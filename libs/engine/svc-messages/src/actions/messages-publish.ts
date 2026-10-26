// messages.publish: send N copies of one message on a dedicated publish lease and report, for each
// copy, what the broker did with it (PUB-01, DC-12).
//
// One lease per call (confirm channel, always `mandatory`), one copy in flight, sequential. A copy is
// `confirmed` only when the lease said so; a `returned` copy (no queue took it) is never a success,
// and a `timeout` is neither a success nor a nack. The loop stops after `blocked` and `timeout`, and
// every copy that was not sent is listed (I-13). The lease is released exactly once on every path.
// The proof a confirmed copy carries is minted by the lease and read by nobody here (A-9).
import {
  messagesPublish,
  publishBodyBytes,
  type CopyOutcome,
  type InputOf,
  type OutputOf,
} from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import type { MessagesModuleDeps } from '../deps';
import {
  decodeBody,
  failureCode,
  failureDetail,
  PublishWireError,
  reasonFor,
  REASONS,
  toTypedHeaders,
} from '../internal/publish-wire';

/** The ports this action reads through. */
export type MessagesPublishDeps = Pick<
  MessagesModuleDeps,
  'recorder' | 'logger'
>;

type Output = OutputOf<typeof messagesPublish>;
type CopyResult = Output['copies'][number];

/** What the person sees before a publish is confirmed (prod and staging plan it): no body, no values. */
interface PublishPreview {
  readonly exchange: string;
  readonly routingKey: string;
  readonly copies: number;
  readonly bodyBytes: number;
  readonly headerCount: number;
}

/** Nothing was sent: the Problem carries the adapter's code and its safe detail, or a fixed text. */
function notSent(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof PublishWireError) {
    return new AppError('VALIDATION_FAILED', {
      detail: 'The message does not fit the publish limits.',
    });
  }
  const code = failureCode(error);
  const detail = code === 'INTERNAL' ? undefined : failureDetail(error);
  return new AppError(code, {
    detail: detail ?? 'The message could not be published; nothing was sent.',
  });
}

function summarise(copies: readonly CopyResult[]): Output['summary'] {
  const counts: Record<CopyOutcome, number> = {
    confirmed: 0,
    nacked: 0,
    returned: 0,
    blocked: 0,
    timeout: 0,
    failed: 0,
    'not-sent': 0,
  };
  for (const copy of copies) counts[copy.outcome] += 1;
  return counts;
}

export const createMessagesPublishAction: (
  deps: MessagesPublishDeps,
) => ActionImpl<typeof messagesPublish, PublishPreview> = (deps) =>
  implementAction(messagesPublish, {
    // Reads nothing from the broker. The preview names the target and the size, never a value; the
    // body travels as the plan's sensitive payload, encrypted at rest and purged with the plan.
    plan: (input) =>
      Promise.resolve({
        preview: {
          exchange: input.exchange,
          routingKey: input.routingKey,
          copies: input.copies,
          bodyBytes: publishBodyBytes(input.body) ?? 0,
          headerCount: Object.keys(input.headers ?? {}).length,
        },
        gates: [],
        warnings: [],
        consentsRequired: [],
        sensitivePayload: { body: input.body },
      }),

    // No broker state this depends on: the lease is taken at execution.
    revalidate: () => Promise.resolve('valid'),

    async execute(input: InputOf<typeof messagesPublish>, ctx) {
      let body: Uint8Array;
      let props: Record<string, unknown>;
      try {
        body = decodeBody(input.body);
        props =
          input.headers === undefined
            ? { ...input.props }
            : { ...input.props, headers: toTypedHeaders(input.headers) };
      } catch (error) {
        throw notSent(error);
      }

      let lease;
      try {
        lease = await ctx.writes.connections.publish(
          input.cid,
          input.vhost,
          ctx.principal,
          ctx.signal,
        );
      } catch (error) {
        throw notSent(error);
      }

      const copies: CopyResult[] = [];
      try {
        let stop: 'ended' | 'cancelled' | undefined;
        for (let index = 0; index < input.copies; index += 1) {
          if (
            stop === undefined &&
            (ctx.signal.aborted ||
              (ctx.deadline !== undefined && ctx.now() >= ctx.deadline))
          ) {
            stop = 'cancelled';
          }
          if (stop !== undefined) {
            copies.push({
              index,
              outcome: 'not-sent',
              reason:
                stop === 'cancelled' ? REASONS.cancelled : REASONS.stopped,
            });
            continue;
          }

          let result;
          try {
            result = await lease.publish(
              input.exchange,
              input.routingKey,
              body,
              props,
              { mandatory: true, timeoutMs: input.timeoutMs },
            );
          } catch (error) {
            // Nothing is decided yet: the call fails and nothing was sent (R5).
            if (index === 0) throw notSent(error);
            // Earlier copies have their outcome and stay in the answer; this one is `failed`.
            deps.logger.warn(
              {
                event: 'messages.publish.copy-failed',
                correlationId: ctx.correlationId,
                code: failureCode(error),
              },
              'a copy could not be published',
            );
            copies.push({
              index,
              outcome: 'failed',
              reason: failureCode(error),
            });
            stop = 'ended';
            continue;
          }

          const reason = reasonFor(
            result.outcome,
            result.outcome === 'confirmed' ? undefined : result.reason,
          );
          copies.push({
            index,
            outcome: result.outcome,
            ...(reason === undefined ? {} : { reason }),
          });
          if (result.outcome === 'blocked' || result.outcome === 'timeout') {
            stop = 'ended';
          }
        }
      } finally {
        try {
          await lease.release();
        } catch {
          deps.logger.warn(
            {
              event: 'messages.publish.release-failed',
              correlationId: ctx.correlationId,
            },
            'the publish lease did not close cleanly',
          );
        }
      }

      const summary = summarise(copies);
      // Recording never changes what happened. A call whose first copy has no outcome (it was
      // cancelled before it started) sent nothing and leaves no entry (H1).
      let historyId: string | undefined;
      if (copies[0]?.outcome !== 'not-sent') {
        try {
          historyId = await deps.recorder.record({
            ownerId: ctx.principal.id,
            connectionId: input.cid,
            vhost: input.vhost,
            at: ctx.now(),
            exchange: input.exchange,
            routingKey: input.routingKey,
            copies: input.copies,
            summary,
            props: input.props,
            ...(input.headers === undefined ? {} : { headers: input.headers }),
            body,
          });
        } catch {
          deps.logger.warn(
            {
              event: 'messages.publish.history-failed',
              correlationId: ctx.correlationId,
            },
            'the publish could not be recorded in the history',
          );
        }
      }

      return {
        copies,
        summary,
        allConfirmed: copies.every((copy) => copy.outcome === 'confirmed'),
        ...(historyId === undefined ? {} : { historyId }),
        historyRecorded: historyId !== undefined,
      };
    },
  });
