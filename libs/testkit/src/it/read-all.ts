import type { Socket } from 'node:net';

/** Reads a socket until the peer ends it. */
export function readAll(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
    });
    socket.once('end', () => {
      resolve(text);
    });
    socket.once('close', () => {
      resolve(text);
    });
    socket.once('error', reject);
  });
}
