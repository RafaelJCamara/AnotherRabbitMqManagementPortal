import { typescriptTester } from '../test-utils.ts';
import { noModeBranching } from './no-mode-branching.ts';

typescriptTester().run('no-mode-branching', noModeBranching, {
  valid: [
    "if (config.kind === 'desktop') run();",
    "if (mode === 'verbose') run();",
    'const mode = options.mode;',
    "const names = ['desktop', 'local'];",
    "switch (kind) { case 'desktop': break; }",
    'platform.openExternal(url);',
    "['a', 'b'].includes(mode);",
  ],
  invalid: [
    {
      code: "if (mode === 'desktop') run();",
      errors: [{ messageId: 'branch' }],
    },
    {
      code: "if ('team' !== config.deliveryMode) run();",
      errors: [{ messageId: 'branch' }],
    },
    {
      code: "const x = getMode() == 'Local' ? a : b;",
      errors: [{ messageId: 'branch' }],
    },
    {
      code: 'if (mode === DeliveryMode.Team) run();',
      errors: [{ messageId: 'branch' }],
    },
    {
      code: "switch (hostMode) { case 'desktop': run(); break; default: break; }",
      errors: [{ messageId: 'branch' }],
    },
    {
      code: "if (['desktop', 'local'].includes(deliveryMode)) run();",
      errors: [{ messageId: 'branch' }],
    },
    {
      code: 'if (isDesktop()) run();',
      errors: [{ messageId: 'branch' }],
    },
    {
      code: 'if (config.isTeamMode) run();',
      errors: [{ messageId: 'branch' }],
    },
  ],
});
