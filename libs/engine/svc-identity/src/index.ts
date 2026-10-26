export { createIdentityModule } from './module';
export type { IdentityModuleDeps } from './deps';
export type { EngineModule } from './module';
// Fakes for the ports of this module, for the architecture manifest and the HTTP specs.
export { createIdentityFakeDeps } from './testing';
export {
  ProviderConfigSchema,
  TOKEN_COMMAND_DEFAULT_MAX_STDOUT_BYTES,
  TOKEN_COMMAND_DEFAULT_TIMEOUT_MS,
  TOKEN_COMMAND_MAX_STDOUT_BYTES,
  TOKEN_COMMAND_MAX_TIMEOUT_MS,
  type CredentialProvider,
  type IssuedCredential,
  type ProviderConfig,
  type ProviderKind,
} from './provider';
export { DEFAULT_USERNAME_CLAIMS, readTokenClaims } from './internal/claims';
export type { TokenClaims } from './internal/claims';
export { SecretValue } from './internal/secret-value';
export { createPasswordProvider } from './providers/password';
export { createStaticTokenProvider } from './providers/static-token';
export { createTokenCommandProvider } from './providers/token-command';
export { createX509ExternalProvider } from './providers/x509-external';
