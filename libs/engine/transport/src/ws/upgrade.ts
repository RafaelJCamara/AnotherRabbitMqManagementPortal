// The live WebSocket (blueprint 7.2, ADR-005): `POST /api/v1/live/tickets` hands a single-use ticket
// to an authenticated caller, and the `upgrade` event of the HTTP server (which `ws` takes before
// Fastify, so no hook runs) admits a socket only through the same guards and a ticket.
// Everything after the handshake is the hub's: this file only moves text between the two.
import { STATUS_CODES, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { createTicketStore, type LiveHub, type TicketStore } from '@app/live';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';

import type { Admission } from '../auth/admission.ts';
import { httpError } from '../problem-handler.ts';
import { API_PREFIX } from '../router.ts';

export const LIVE_PATH = `${API_PREFIX}/live`;
const SUBPROTOCOL = 'app.v1';
const TICKET_PREFIX = 'app.ticket.';

export interface LiveEndpoint {
  readonly hub: LiveHub;
  readonly tickets?: TicketStore;
}

export function registerLive(
  app: FastifyInstance,
  { hub, tickets = createTicketStore() }: LiveEndpoint,
  admission: Admission,
): void {
  app.post(`${LIVE_PATH}/tickets`, (request) => {
    if (request.principal === null) throw httpError(401, 'No principal.');
    return { ticket: tickets.issue(request.principal) };
  });

  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols: () => SUBPROTOCOL,
  });
  const upgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    try {
      if (req.url?.split('?')[0] !== LIVE_PATH)
        throw httpError(404, 'No such route.');
      admission.guard(req.headers, 'GET', true, false);
      const offered = (req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((protocol) => protocol.trim());
      const ticket = offered.find((p) => p.startsWith(TICKET_PREFIX));
      // Redeemed last, so a refusal for any other reason does not burn the ticket.
      const principal = offered.includes(SUBPROTOCOL)
        ? tickets.redeem(ticket?.slice(TICKET_PREFIX.length) ?? '')
        : undefined;
      if (principal === undefined)
        throw httpError(401, 'A live ticket is required.');
      sockets.handleUpgrade(req, socket, head, (ws) => {
        // A ws socket already has the shape of a hub transport.
        const link = hub.attach(ws, principal);
        ws.on('message', (data: Buffer, binary: boolean) => {
          if (binary) ws.close(1003, 'text frames only');
          else link?.receive(data.toString('utf8'));
        });
        ws.on('close', () => link?.closed());
        ws.on('error', () => {
          ws.terminate();
        });
      });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      const text = STATUS_CODES[status] ?? 'Error';
      socket.end(
        `HTTP/1.1 ${String(status)} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
    }
  };
  app.server.on('upgrade', upgrade);
  // preClose, not onClose: the server waits for upgraded sockets, so they must end first.
  app.addHook('preClose', (done) => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close(() => {
      done();
    });
  });
}
