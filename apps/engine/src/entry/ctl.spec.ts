import { describe, expect, it, vi } from 'vitest';

import { createCtlPort, detectCtlTransport, type CtlTransport } from './ctl.ts';

function fakeTransport() {
  let deliver: (message: unknown) => void = () => undefined;
  const posted: unknown[] = [];
  const transport: CtlTransport = {
    post: (message) => {
      posted.push(message);
    },
    onMessage: (handler) => {
      deliver = handler;
    },
  };
  return {
    transport,
    posted,
    send: (message: unknown) => {
      deliver(message);
    },
  };
}

const init = (dek?: Uint8Array) => ({
  t: 'init',
  paths: { data: '/data', logs: '/logs' },
  ...(dek === undefined ? {} : { dek }),
  settings: {},
});

describe('control channel', () => {
  it('resolves next() with a frame that arrived before anyone asked, once', async () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    peer.send(init());

    const frame = await port.next('init', 50);

    expect(frame.paths.data).toBe('/data');
    await expect(port.next('init', 20)).rejects.toThrow(/ctl:init/);
  });

  it('resolves next() with a frame that arrives later, and ignores other types meanwhile', async () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    const waiting = port.next('shutdown', 500);

    peer.send({ t: 'resume' });
    peer.send({ t: 'shutdown', deadlineMs: 1500 });

    expect(await waiting).toEqual({ t: 'shutdown', deadlineMs: 1500 });
  });

  it('a satisfied wait is forgotten: the next frame of that type is kept for the next one', async () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    const first = port.next('shutdown', 500);
    peer.send({ t: 'shutdown', deadlineMs: 1000 });
    await first;

    peer.send({ t: 'shutdown', deadlineMs: 2000 });

    expect(await port.next('shutdown', 50)).toEqual({
      t: 'shutdown',
      deadlineMs: 2000,
    });
  });

  it('times out with a message that names the frame and not its content', async () => {
    const port = createCtlPort(fakeTransport().transport);

    await expect(port.next('init', 10)).rejects.toThrow(
      'No ctl:init frame arrived within 10 ms.',
    );
  });

  it('leaves no timer running once the frame has arrived, so the wait cannot hold the process open', async () => {
    vi.useFakeTimers();
    try {
      const peer = fakeTransport();
      const port = createCtlPort(peer.transport);
      const waiting = port.next('init', 10_000);
      expect(vi.getTimerCount()).toBe(1);

      peer.send(init());
      await waiting;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a wait that timed out does not swallow the frame that arrives afterwards', async () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    await expect(port.next('init', 10)).rejects.toThrow();

    peer.send(init());

    expect((await port.next('init', 50)).paths.data).toBe('/data');
  });

  it('hands every valid frame to listeners', () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    const seen: string[] = [];
    port.onFrame((frame) => seen.push(frame.t));

    peer.send({ t: 'resume' });
    peer.send({ t: 'suspend', deadlineMs: 1000 });

    expect(seen).toEqual(['resume', 'suspend']);
  });

  it('drops a frame that fails validation and reports field names only, never values (I-10)', () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);
    const fields: (readonly string[])[] = [];
    const frames: string[] = [];
    port.onInvalid((names) => fields.push(names));
    port.onFrame((frame) => frames.push(frame.t));

    peer.send({
      t: 'init',
      paths: { data: 42, logs: '/logs' },
      dek: 'a-secret-in-the-wrong-type',
      settings: {},
    });
    peer.send({ t: 'nonsense' });
    peer.send('not even an object');

    expect(frames).toEqual([]);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual(expect.arrayContaining(['paths.data', 'dek']));
    expect(JSON.stringify(fields)).not.toContain('a-secret');
  });

  it('validates what it posts', () => {
    const peer = fakeTransport();
    const port = createCtlPort(peer.transport);

    port.post({ t: 'ready', contract: 'c', schemaHash: 's' });
    expect(() => {
      port.post({ t: 'ready', contract: 1 } as never);
    }).toThrow();

    expect(peer.posted).toEqual([
      { t: 'ready', contract: 'c', schemaHash: 's' },
    ]);
  });
});

describe('ctl transport of a process', () => {
  it('uses the utility-process parent port and unwraps its event', () => {
    const handlers: ((event: { data: unknown }) => void)[] = [];
    const postMessage = vi.fn();
    const transport = detectCtlTransport({
      parentPort: {
        postMessage,
        on: (_event, handler) => handlers.push(handler),
      },
      on: () => undefined,
    });
    const received: unknown[] = [];
    transport?.onMessage((message) => received.push(message));
    handlers[0]?.({ data: { t: 'resume' } });
    transport?.post({ t: 'resume' });

    expect(received).toEqual([{ t: 'resume' }]);
    expect(postMessage).toHaveBeenCalledWith({ t: 'resume' });
  });

  it('falls back to the IPC channel of a forked process, and to nothing without one', () => {
    const send = vi.fn(() => true);
    const on = vi.fn();
    const proc = { send, on };
    const transport = detectCtlTransport(proc);
    transport?.post({ t: 'resume' });
    const handler = vi.fn();
    transport?.onMessage(handler);

    expect(send).toHaveBeenCalledWith({ t: 'resume' });
    expect(on).toHaveBeenCalledWith('message', handler);
    expect(detectCtlTransport({ on: () => undefined })).toBeUndefined();
  });
});
