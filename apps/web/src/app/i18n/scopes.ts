// The three Transloco scopes of the shell (M0-51, i18n key layout). Each is a lazy chunk of
// bundled JSON (see i18n.config.ts). A new scope is a new name here, a file under en/ and a
// loader in SCOPE_LOADERS.
export const SCOPE_NAMES = ['shell', 'status', 'system'] as const;
export type ScopeName = (typeof SCOPE_NAMES)[number];
