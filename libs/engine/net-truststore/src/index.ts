// @app/net-truststore: TLS trust for every outbound connection (M0-26, DC-44).
export {
  classifyTlsError,
  describeCertificate,
  diagnoseTlsSocket,
  toProfileTls,
  type CertDiagnostics,
  type CertificateSummary,
  type DiagnoseContext,
  type TlsFailureKind,
} from './diagnostics.ts';
export {
  NetworkError,
  type NetworkErrorCode,
  type NetworkErrorOptions,
  type TlsFailure,
} from './errors.ts';
export {
  secureSocket,
  type SecureResult,
  type SecureSocketOptions,
} from './handshake.ts';
export {
  createTrustStore,
  nodeTlsRuntime,
  parseCertificates,
  validateServername,
  type TlsClientOptions,
  type TlsRuntime,
  type TlsTrust,
  type TrustProfile,
  type TrustSources,
  type TrustStore,
  type TrustStoreOptions,
} from './truststore.ts';
