// The egress guard of the deny-all egress run (M0-69, I-12): a Node preload that refuses, and
// records, every way the engine process could reach out. It is loaded with
//   node --import <this file> dist/apps/engine/main.mjs ...
// and is the "deny-all egress proxy" of the container run: nothing is allowed, so a connection that
// no configured broker asked for is a failure, and the log names it.
//
// Refused and recorded (a JSON line per attempt in the file named by EGRESS_GUARD_LOG):
//   - net.Socket.connect (so also net.connect, tls.connect, http(s) clients, fetch, WebSocket and
//     undici, which all end in it) and tls.connect and http2.connect on their own;
//   - every dns lookup and resolve of a name (an IP literal is not a lookup and is let through:
//     Node itself passes one when it listens on 127.0.0.1);
//   - dgram sockets, created, bound or sent on;
//   - child processes (a spawned `curl` is egress too).
// What it cannot see is native code that opens a socket on its own. That is the second layer: a
// container with no network at all (`--network none`, or a deny-all NetworkPolicy), which the image
// work package (M0-64) adds to this run. Until then this run proves the JavaScript surface.
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http2 from 'node:http2';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

const logPath = process.env.EGRESS_GUARD_LOG;
if (logPath === undefined || logPath === '') {
  throw new Error('egress guard: EGRESS_GUARD_LOG is not set');
}

function record(kind, detail) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ kind, detail, at: Date.now() })}\n`,
  );
}

function refuse(kind, detail) {
  record(kind, detail);
  const error = new Error(`egress guard: ${kind} refused (${detail})`);
  error.code = 'EGRESS_GUARD';
  throw error;
}

/** Host and port or path of a `connect` call, whichever way it was written. */
function target(args) {
  const [first, second] = args;
  if (first !== null && typeof first === 'object') {
    return (
      first.path ?? `${String(first.host ?? 'localhost')}:${String(first.port)}`
    );
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return first;
  return `${typeof second === 'string' ? second : 'localhost'}:${String(first)}`;
}

record('guard.loaded', `pid ${String(process.pid)}`);

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  refuse('net.connect', target(args));
  return connect.apply(this, args);
};
tls.connect = (...args) => refuse('tls.connect', target(args));
http2.connect = (...args) => refuse('http2.connect', target(args));

const NAME_FUNCTIONS = [
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
];
for (const owner of [dns, dns.promises, dns.Resolver.prototype]) {
  for (const name of NAME_FUNCTIONS) {
    const original = owner[name];
    if (typeof original !== 'function') continue;
    owner[name] = function guardedName(...args) {
      const name0 = args[0];
      // An IP literal is not a lookup: Node passes one when it listens on 127.0.0.1.
      if (
        name === 'lookup' &&
        typeof name0 === 'string' &&
        net.isIP(name0) !== 0
      ) {
        return original.apply(this, args);
      }
      return refuse(`dns.${name}`, String(name0));
    };
  }
}

dgram.createSocket = (...args) => refuse('dgram.createSocket', String(args[0]));

const spawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function guardedSpawn(options) {
  refuse('child_process.spawn', String(options?.file));
  return spawn.call(this, options);
};

syncBuiltinESMExports();
