import { explorerWindowTopic, inventoryQuery } from '@app/contracts';
import type {
  ExplorerData,
  ExplorerLiveEvent,
  ExplorerWindowItem,
} from '@app/explorer-model';
import type { EngineApi, LiveClient, LiveEvent } from '@app/ui-data';

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The request was aborted.', 'AbortError');
}

/** A rejection is always an Error; the engine's failures already are (`EngineProblemError`). */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** What the topic sends, as the model's port knows it; `data` frames are not part of this topic. */
function mapEvent(
  event: LiveEvent<ExplorerWindowItem>,
): ExplorerLiveEvent | undefined {
  switch (event.kind) {
    case 'snapshot':
      return { kind: 'snapshot', items: event.items };
    case 'delta':
      return {
        kind: 'delta',
        upserts: event.upserts,
        removes: event.removes,
      };
    case 'gap':
      return { kind: 'gap' };
    case 'status':
      return { kind: 'status', state: event.state };
    case 'reset':
      return { kind: 'reset' };
    case 'data':
      return undefined;
  }
}

/**
 * The explorer's data port over the engine: `inventory.query` through `EngineApi` (the answer is
 * parsed against the contract in dev and test builds) and `explorer.window` through the live client.
 * Every call here reads; nothing changes the broker.
 */
export function createEngineExplorerData(
  api: Pick<EngineApi, 'call'>,
  live: Pick<LiveClient, 'subscribe'>,
): ExplorerData {
  return {
    query(input, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        const onAbort = (): void => {
          subscription.unsubscribe();
          reject(abortReason(signal));
        };
        const subscription = api.call(inventoryQuery, input).subscribe({
          next: (output) => {
            resolve(output);
          },
          error: (error: unknown) => {
            reject(asError(error));
          },
        });
        signal.addEventListener('abort', onAbort, { once: true });
        subscription.add(() => {
          signal.removeEventListener('abort', onAbort);
        });
      });
    },
    follow(params, listener) {
      const subscription = live
        .subscribe(explorerWindowTopic, params)
        .subscribe({
          next: (event) => {
            const mapped = mapEvent(event);
            if (mapped) listener(mapped);
          },
          error: (error: unknown) => {
            listener({ kind: 'error', error });
          },
          complete: () => {
            listener({ kind: 'end' });
          },
        });
      return () => {
        subscription.unsubscribe();
      };
    },
  };
}
