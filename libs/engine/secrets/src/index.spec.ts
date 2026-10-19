import { describe, expect, it } from 'vitest';

import * as api from './index.ts';

describe('secrets public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_SCRYPT_COST',
      'ENVELOPE_OVERHEAD',
      'ENVELOPE_VERSION',
      'KEY_BYTES',
      'MAX_PLAINTEXT_BYTES',
      'MIN_PASSPHRASE_CHARS',
      'SecretsError',
      'createAadCipher',
      'createCtlDeliveredWrap',
      'createDataKeyVault',
      'createFieldCipher',
      'createFileKekWrap',
      'createKeyringWrap',
      'createMemoryDataKeyRepository',
      'createMemoryKeyring',
      'createPassphraseWrap',
      'fieldAad',
      'isProtectedKeyring',
      'parseKek',
    ]);
  });
});
