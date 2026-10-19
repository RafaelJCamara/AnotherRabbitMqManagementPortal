// Integration tests of the live endpoint (M0-33): a real listener on 127.0.0.1:0 and real `ws`
// clients, through `nx run transport:it --testNamePattern=live`. The hub is the real hub; only the
// topic source is a test double.
import type { ClientFrame, ServerFrame } from '@app/contracts';
import { defineTopic } from '@app/contracts';
import { createManualClock } from '@app/kernel';
import { createTicketStore, createTopicRegistry, LiveHub } from '@app/live';
import type { Principal } from '@app/ports';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';

import {
  CARRIER,
  TOKEN,
  bearer,
  createHarness,
  listen,
  tcp,
  type Listening,
} from './harness.test.ts';

const topic = defineTopic({
  id: 'it.numbers',
  params: z.strictObject({}),
  item: z.strictObject({ n: z.number().int() }),
  qos: 'lossless',
  flow: 'credit',
  permission: 'meta.read',
  ring: { items: 4, bytes: 4096 },
});

interface Sink {
  publish(item: { n: number }, bytes?: number): void;
}

interface Rig {
  app: FastifyInstance;
  server: Listening;
  hub: LiveHub;
  sinks: Sink[];
  state: { n: number }[];
  seen: Principal[];
  clock: ReturnType<typeof createManualClock>;
}

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function rig(): Promise<Rig> {
  const clock = createManualClock();
  const topics = createTopicRegistry();
  const sinks: Sink[] = [];
  const state: { n: number }[] = [];
  const seen: Principal[] = [];
  topics.register(topic, {
    snapshot: () => ({ value: [...state], bytes: 16 * state.length }),
    subscribe: (_params, _principal, sink) => {
      sinks.push(sink);
      return () => undefined;
    },
  });
  const hub = new LiveHub({
    engineVersion: '0.0.0-it',
    topics,
    canSubscribe: (principal) => {
      seen.push(principal);
      return true;
    },
  });
  const { app } = createHarness({
    live: { hub, tickets: createTicketStore({ clock }) },
  });
  open.push(app);
  const server = await listen(app);
  return { app, server, hub, sinks, state, seen, clock };
}

async function ticketFor(
  server: Listening,
  headers = bearer(),
): Promise<string> {
  const answer = await tcp(server, {
    method: 'POST',
    path: '/api/v1/live/tickets',
    headers,
  });
  expect(answer.status).toBe(200);
  const { ticket } = answer.json() as { ticket: string };
  return ticket;
}

type Outcome =
  | { ok: true; socket: WebSocket; protocol: string; got: ServerFrame[] }
  | { ok: false; status: number };

/** Opens `/api/v1/live` the way a browser would; resolves with the refusal status when refused. */
function upgrade(
  server: Listening,
  protocols: string[],
  headers: Record<string, string> = {},
  path = '/api/v1/live',
): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${String(server.port)}${path}`,
      protocols,
      {
        headers,
      },
    );
    const got: ServerFrame[] = [];
    socket.on('message', (data: Buffer) => {
      got.push(JSON.parse(data.toString('utf8')) as ServerFrame);
    });
    socket.on('open', () => {
      resolve({ ok: true, socket, protocol: socket.protocol, got });
    });
    socket.on('unexpected-response', (_request, response) => {
      resolve({ ok: false, status: response.statusCode ?? 0 });
      response.resume();
    });
    socket.on('error', () => undefined);
  });
}

const withTicket = (ticket: string): string[] => [
  'app.v1',
  `app.ticket.${ticket}`,
];

async function connect(
  server: Listening,
): Promise<Extract<Outcome, { ok: true }>> {
  const outcome = await upgrade(server, withTicket(await ticketFor(server)));
  if (!outcome.ok) throw new Error(`refused with ${String(outcome.status)}`);
  return outcome;
}

const send = (socket: WebSocket, frame: ClientFrame): void => {
  socket.send(JSON.stringify(frame));
};

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function frames(
  got: ServerFrame[],
  count: number,
): Promise<ServerFrame[]> {
  await until(() => got.length >= count, `${String(count)} frames`);
  return got.splice(0);
}

describe('live endpoint: tickets and the handshake', () => {
  it('live AC-1 a ticket opens one socket, binds it to the principal that asked, and echoes only app.v1', async () => {
    const { server, seen } = await rig();
    const ticket = await ticketFor(server);
    const first = await upgrade(server, withTicket(ticket));
    expect(first.ok && first.protocol).toBe('app.v1');
    if (!first.ok) return;
    send(first.socket, { t: 'hello', v: 1 });
    send(first.socket, {
      t: 'sub',
      sid: 1,
      topic: 'it.numbers' as never,
      params: {},
      credit: 1,
    });
    const welcome = await frames(first.got, 2);
    expect(welcome[0]).toMatchObject({
      t: 'welcome',
      v: 1,
      engineVersion: '0.0.0-it',
    });
    expect(seen[0]).toMatchObject({ kind: 'local-token', id: 'local-token' });
    first.socket.close();
  });

  it('live AC-1 a reused ticket is refused with 401', async () => {
    const { server } = await rig();
    const ticket = await ticketFor(server);
    const first = await upgrade(server, withTicket(ticket));
    expect(first.ok).toBe(true);
    expect(await upgrade(server, withTicket(ticket))).toEqual({
      ok: false,
      status: 401,
    });
    if (first.ok) first.socket.close();
  });

  it('live AC-1 an expired ticket is refused with 401', async () => {
    const { server, clock } = await rig();
    const ticket = await ticketFor(server);
    clock.advance(30_001);
    expect(await upgrade(server, withTicket(ticket))).toEqual({
      ok: false,
      status: 401,
    });
  });

  it('live a ticket is not a bearer token, and a bearer token is not a ticket', async () => {
    const { server } = await rig();
    expect(await upgrade(server, ['app.v1'], bearer())).toEqual({
      ok: false,
      status: 401,
    });
    expect(await upgrade(server, withTicket(TOKEN))).toEqual({
      ok: false,
      status: 401,
    });
    expect(await upgrade(server, withTicket('nope'))).toEqual({
      ok: false,
      status: 401,
    });
  });

  it('live tickets are only handed to an authenticated caller', async () => {
    const { server } = await rig();
    const answer = await tcp(server, {
      method: 'POST',
      path: '/api/v1/live/tickets',
    });
    expect(answer.status).toBe(401);
    expect(answer.body).not.toContain('ticket"');
  });

  it('live the upgrade goes through the same guards as a request, and a refusal does not burn the ticket', async () => {
    const { server } = await rig();
    const ticket = await ticketFor(server);
    const port = String(server.port);
    const hostile: [string, Record<string, string>, number][] = [
      ['a foreign Origin', { origin: 'https://evil.example' }, 403],
      ['a foreign Host', { host: 'evil.example' }, 403],
      ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 403],
      ['the carrier header', { 'x-app-carrier': CARRIER }, 403],
    ];
    for (const [name, headers, status] of hostile) {
      expect(await upgrade(server, withTicket(ticket), headers), name).toEqual({
        ok: false,
        status,
      });
    }
    expect(
      await upgrade(server, withTicket(ticket), {}, '/api/v1/other'),
    ).toEqual({
      ok: false,
      status: 404,
    });
    // Without the app.v1 subprotocol the ticket is not looked at either.
    expect(await upgrade(server, [`app.ticket.${ticket}`])).toEqual({
      ok: false,
      status: 401,
    });
    // The same ticket still works for the page itself (same Origin, same-origin fetch).
    const page = await upgrade(server, withTicket(ticket), {
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
    });
    expect(page.ok).toBe(true);
    if (page.ok) page.socket.close();
  });
});

describe('live endpoint: the protocol over a real socket', () => {
  it('live AC-1 a client that stops granting credit cannot grow the outbox: gap, then snapshot', async () => {
    const { server, sinks, state, hub } = await rig();
    const { socket, got } = await connect(server);
    send(socket, { t: 'hello', v: 1 });
    send(socket, {
      t: 'sub',
      sid: 1,
      topic: 'it.numbers' as never,
      params: {},
      credit: 0,
    });
    await frames(got, 2);
    state.push({ n: 98 }, { n: 99 }, { n: 100 });
    for (let n = 1; n <= 100; n += 1) sinks[0]?.publish({ n }, 16);
    const session = [...hub.sessions.values()][0];
    expect(session?.live.inspect(1)?.items).toBeLessThanOrEqual(4);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(got).toEqual([]);
    send(socket, { t: 'credit', sid: 1, n: 5 });
    const [gap, snapshot] = await frames(got, 2);
    expect(gap).toMatchObject({
      t: 'gap',
      fromSeq: 1,
      toSeq: 100,
      reason: 'overflow',
    });
    expect(snapshot).toMatchObject({ t: 'snapshot', seq: 100, items: state });
    socket.close();
  });

  it('live AC-2 after a dropped socket, hello with resume within 30 s continues the lossless subscription', async () => {
    const { server, sinks } = await rig();
    const first = await connect(server);
    send(first.socket, { t: 'hello', v: 1 });
    send(first.socket, {
      t: 'sub',
      sid: 1,
      topic: 'it.numbers' as never,
      params: {},
      credit: 10,
    });
    const [welcome] = await frames(first.got, 2);
    if (welcome?.t !== 'welcome') throw new Error('no welcome');
    sinks[0]?.publish({ n: 1 }, 16);
    sinks[0]?.publish({ n: 2 }, 16);
    await frames(first.got, 1);
    first.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    sinks[0]?.publish({ n: 3 }, 16);

    const back = await connect(server);
    send(back.socket, {
      t: 'hello',
      v: 1,
      resume: { session: welcome.session, lastSeq: { '1': 2 } },
    });
    const resumed = await frames(back.got, 2);
    expect(resumed[0]).toMatchObject({
      t: 'welcome',
      session: welcome.session,
    });
    expect(resumed[1]).toMatchObject({ t: 'subok', sid: 1 });
    send(back.socket, { t: 'credit', sid: 1, n: 10 });
    const [data] = await frames(back.got, 1);
    expect(data).toMatchObject({ t: 'data', sid: 1, items: [{ n: 3 }] });
    back.socket.close();
  });

  it('live closes the socket of a client that sends binary, bad JSON or a bad frame', async () => {
    const { server } = await rig();
    const closed = async (message: string | Buffer): Promise<number> => {
      const { socket } = await connect(server);
      const code = new Promise<number>((resolve) => {
        socket.on('close', (value) => {
          resolve(value);
        });
      });
      socket.send(message, { binary: Buffer.isBuffer(message) });
      return code;
    };
    expect(await closed(Buffer.from('{}'))).toBe(1003);
    expect(await closed('not json')).toBe(1008);
    expect(await closed(JSON.stringify({ t: 'sub', sid: 1 }))).toBe(1008);
  });

  it('live closing the app ends every open socket', async () => {
    const { server, app } = await rig();
    const { socket } = await connect(server);
    const closed = new Promise<void>((resolve) => {
      socket.on('close', () => {
        resolve();
      });
    });
    await app.close();
    await closed;
  });
});
