/**
 * The ports this module needs, injected by the composition root. Name them here as the first action
 * needs them (for example `readonly mgmt: MgmtReadPort`), and give them fakes in testing.ts.
 */
export type ConnectionsModuleDeps = Readonly<Record<string, never>>;
