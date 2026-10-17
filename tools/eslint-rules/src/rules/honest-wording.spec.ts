import { jsonTester, typescriptTester } from '../test-utils.ts';
import { honestWording } from './honest-wording.ts';

const json = (value: unknown) => JSON.stringify(value, null, 2);

jsonTester().run('honest-wording (i18n JSON)', honestWording, {
  valid: [
    {
      name: 'the honest copy',
      filename: 'en.json',
      code: json({
        peek: {
          title: 'Side-effect-aware peek',
          hint: 'Messages stay in the queue.',
        },
      }),
    },
    {
      name: 'non-destructive on the stream-browse keys',
      filename: 'en.json',
      code: json({
        messages: {
          streamBrowse: {
            title: 'Non-destructive browse',
            hint: 'Anonymous, non-destructive.',
          },
        },
      }),
    },
    {
      name: 'non-destructive on the node-agent keys',
      filename: 'en.json',
      code: json({ peek: { nodeAgent: { title: 'Non-destructive peek' } } }),
    },
    {
      name: 'dashed and snake-case key spellings are the same segment',
      filename: 'en.json',
      code: json({
        'node-agent': { title: 'non-destructive peek' },
        stream_browse: { a: 'non-destructive' },
      }),
    },
    {
      name: 'read-only for locks and permissions',
      filename: 'en.json',
      code: json({
        shell: { lock: { toggle: 'Toggle read-only lock' } },
        mcp: { status: { local: 'Local read-only MCP' } },
        connections: {
          managedBy: { operator: 'Managed by the operator (read-only)' },
        },
        permissions: { viewer: 'Read-only access' },
      }),
    },
    {
      name: 'read-only outside message contexts',
      filename: 'en.json',
      code: json({ settings: { editor: { mode: 'Read-only editor' } } }),
    },
    {
      name: 'arrays of allowed strings',
      filename: 'en.json',
      code: json({ nodeAgent: { bullets: ['non-destructive'] } }),
    },
    {
      name: 'custom allow-list',
      filename: 'en.json',
      options: [{ allowedKeys: ['special.**'] }],
      code: json({ special: { title: 'non-destructive' } }),
    },
  ],
  invalid: [
    {
      name: 'non-destructive peek outside the allow-listed keys (acceptance)',
      filename: 'en.json',
      code: json({ peek: { title: 'non-destructive peek' } }),
      errors: [{ messageId: 'claim', data: { term: 'non-destructive' } }],
    },
    {
      name: 'claim terms are checked under every key',
      filename: 'en.json',
      code: json({ settings: { about: 'A Non-Destructive viewer' } }),
      errors: [{ messageId: 'claim' }],
    },
    {
      name: 'other claim terms',
      filename: 'en.json',
      code: json({
        a: 'Runs without side effects',
        b: 'A side-effect-free read',
        c: 'Use safe peek',
        d: 'Look inside without breaking anything',
        e: 'nondestructive',
      }),
      errors: [
        { messageId: 'claim', data: { term: 'without side effects' } },
        { messageId: 'claim', data: { term: 'side-effect-free' } },
        { messageId: 'claim', data: { term: 'safe peek' } },
        { messageId: 'claim', data: { term: 'without breaking' } },
        { messageId: 'claim', data: { term: 'non-destructive' } },
      ],
    },
    {
      name: 'a claim in an array element',
      filename: 'en.json',
      code: json({ dlq: { bullets: ['Inspect', 'non-destructive'] } }),
      errors: [{ messageId: 'claim' }],
    },
    {
      name: 'read-only under message contexts',
      filename: 'en.json',
      code: json({
        peek: { title: 'Read-only peek' },
        dlq: { inspect: { hint: 'read only view of the DLQ' } },
        mcp: { tools: { peek: { description: 'A readonly tool' } } },
        feature: { messages: { body: 'Read-only' } },
      }),
      errors: [
        { messageId: 'readOnly' },
        { messageId: 'readOnly' },
        { messageId: 'readOnly' },
        { messageId: 'readOnly' },
      ],
    },
    {
      name: 'read-only under a lock key inside a message context is still allowed, but not a peek key',
      filename: 'en.json',
      code: json({
        peek: { lock: { title: 'read-only lock' }, title: 'read-only' },
      }),
      errors: [{ messageId: 'readOnly', line: 6 }],
    },
    {
      name: 'a custom message context',
      filename: 'en.json',
      options: [{ messageContexts: ['inspector'] }],
      code: json({
        inspector: { title: 'Read-only' },
        peek: { title: 'Read-only' },
      }),
      errors: [{ messageId: 'readOnly' }],
    },
  ],
});

typescriptTester().run('honest-wording (string literals)', honestWording, {
  valid: [
    "const title = 'Side-effect-aware peek';",
    "const lock = 'read-only';",
    "import x from 'non-destructive-package';",
    'const template = `Peek ${count} messages`;',
  ],
  invalid: [
    {
      code: "const title = 'Non-destructive peek';",
      errors: [{ messageId: 'claimInCode' }],
    },
    {
      code: 'const hint = `Peek without side effects (${count})`;',
      errors: [{ messageId: 'claimInCode' }],
    },
  ],
});
