// Helpers shared by the specs. Not exported from the library.
import {
  ServerFrameSchema,
  topicId,
  type ClientFrame,
  type Problem,
  type ServerFrame,
} from '@app/contracts';
import { LiveSession, type SessionLimits, type SubSpec } from './session.ts';

export const HELLO: ClientFrame = { t: 'hello', v: 1 };

export function notFound(topic: string): Problem {
  return {
    type: 'about:blank',
    title: 'No such topic',
    status: 404,
    code: 'NOT_FOUND',
    detail: topic,
    correlationId: 'c',
    retryable: false,
  };
}

export function spec(extra: Partial<SubSpec> = {}): SubSpec {
  return {
    qos: 'lossless',
    flow: 'credit',
    ring: { items: 8, bytes: 1024 },
    snapshot: () => ({ value: [], bytes: 0 }),
    ...extra,
  };
}

/** A session that has said hello and resolves topics from `specs`. */
export function open(
  specs: Record<string, SubSpec> = {},
  limits?: Partial<SessionLimits>,
  id = 's1',
): LiveSession {
  const session = new LiveSession({
    id,
    engineVersion: '0.0.0-test',
    resolve: (frame) => {
      const found = specs[frame.topic];
      return found === undefined
        ? { ok: false, problem: notFound(frame.topic) }
        : { ok: true, spec: found };
    },
    ...(limits === undefined ? {} : { limits }),
  });
  session.receive(HELLO);
  return session;
}

export function sub(sid: number, topic: string, credit: number): ClientFrame {
  return { t: 'sub', sid, topic: topicId(topic), params: {}, credit };
}

export function credit(sid: number, n: number): ClientFrame {
  return { t: 'credit', sid, n };
}

/** Frames must be valid on the wire, whatever the machine produced. */
export function wire(frames: ServerFrame[]): ServerFrame[] {
  return frames.map((f) => ServerFrameSchema.parse(f));
}
