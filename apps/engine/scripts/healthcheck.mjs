// The container HEALTHCHECK (ADR-016, blueprint 1.2): `node healthcheck.mjs`.
//
// Asks the engine in this container, on loopback, whether it serves: GET /healthz must answer 200
// with {"status":"ok"} within the timeout. Exit 0 means healthy; anything else exits 1 with one short
// line on stderr. It contacts 127.0.0.1 and nothing else, whatever the environment says, sends no
// token (the route is public, behind the Host guard) and prints nothing a log could hold a secret in.
//
//   node healthcheck.mjs [--port=8765] [--timeout-ms=3000]
//
// The port is --port, else APP_PORT, else 8765 (the port the image documents). The image copies this
// file next to the bundle (work package M0-64); it imports nothing outside Node.
import { request } from 'node:http';
import process from 'node:process';

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 3000;

function flag(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

function whole(text, fallback, min, max) {
  if (text === undefined || text === '') return fallback;
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  return value >= min && value <= max ? value : undefined;
}

const port = whole(
  flag('port') ?? process.env.APP_PORT,
  DEFAULT_PORT,
  1,
  65_535,
);
const timeoutMs = whole(flag('timeout-ms'), DEFAULT_TIMEOUT_MS, 1, 60_000);
const fail = (reason) => {
  process.stderr.write(`unhealthy: ${reason}\n`);
  process.exit(1);
};
if (port === undefined) fail('the port is not a number from 1 to 65535');
if (timeoutMs === undefined) fail('--timeout-ms is not a number');

const call = request(
  {
    host: '127.0.0.1',
    port,
    path: '/healthz',
    method: 'GET',
    timeout: timeoutMs,
    headers: { host: `127.0.0.1:${String(port)}` },
  },
  (response) => {
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024) response.destroy(new Error('too long'));
      else chunks.push(chunk);
    });
    response.on('error', () => {
      fail('the answer was cut off');
    });
    response.on('end', () => {
      if (response.statusCode !== 200) {
        fail(`status ${String(response.statusCode)}`);
        return;
      }
      let status;
      try {
        status = JSON.parse(Buffer.concat(chunks).toString('utf8')).status;
      } catch {
        fail('the answer is not JSON');
        return;
      }
      if (status === 'ok') process.exit(0);
      fail('the engine does not say ok');
    });
  },
);
call.on('timeout', () => {
  call.destroy();
  fail('no answer in time');
});
call.on('error', () => {
  fail('the engine is not reachable');
});
call.end();
