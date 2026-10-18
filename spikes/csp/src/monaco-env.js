/* global self */
// Monaco reads `MonacoEnvironment` while its modules are evaluated (its Trusted Types policies are
// static initialisers), so this module must be imported BEFORE monaco-editor.
import { createWorker, monacoPolicyHook } from './trusted-types.js';

const createTrustedTypesPolicy = monacoPolicyHook();

self.MonacoEnvironment = {
  getWorker(_id, label) {
    const url =
      label === 'json'
        ? '/workers/json.worker.js'
        : '/workers/editor.worker.js';
    return createWorker(url, { type: 'module', name: label });
  },
  ...(createTrustedTypesPolicy === undefined
    ? {}
    : { createTrustedTypesPolicy }),
};
