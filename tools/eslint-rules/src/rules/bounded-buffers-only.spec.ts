import { typescriptTester } from '../test-utils.ts';
import { boundedBuffersOnly } from './bounded-buffers-only.ts';

typescriptTester().run('bounded-buffers-only', boundedBuffersOnly, {
  valid: [
    'const buffer = new BoundedRing({ maxItems: 100, maxBytes: 1024 });',
    'const outbox = new BoundedQueue({ maxItems: 10, maxBytes: 4096 });',
    // Broker entities are not buffers.
    'const queues: Queue[] = [];',
    'const queue = [];',
    // Plain collections with other names are not checked.
    'const names = new Set<string>();',
    'const results = [];',
    'results.push(x);',
    // Byte buffers are not collections.
    'const buffer = Buffer.alloc(16);',
    'class A { private readonly ring = new BoundedRing(options); }',
  ],
  invalid: [
    {
      code: 'const buffer = [];',
      errors: [{ messageId: 'unbounded', data: { name: 'buffer' } }],
    },
    {
      code: 'const eventBuffer: Event[] = new Array();',
      errors: [{ messageId: 'unbounded', data: { name: 'eventBuffer' } }],
    },
    {
      code: 'class A { private readonly outbox: Frame[] = []; }',
      errors: [{ messageId: 'unbounded', data: { name: 'outbox' } }],
    },
    {
      code: 'class A { reset() { this.backlog = []; } }',
      errors: [{ messageId: 'unbounded', data: { name: 'backlog' } }],
    },
    {
      code: 'const ring = new Map<string, Frame>();',
      errors: [{ messageId: 'unbounded', data: { name: 'ring' } }],
    },
    {
      code: 'const frameBuffers = Array.from(source);',
      errors: [{ messageId: 'unbounded', data: { name: 'frameBuffers' } }],
    },
    {
      code: 'this.buffer.push(frame);',
      errors: [{ messageId: 'grow', data: { name: 'buffer' } }],
    },
    {
      code: 'inbox.unshift(frame);',
      errors: [{ messageId: 'grow', data: { name: 'inbox' } }],
    },
  ],
});
