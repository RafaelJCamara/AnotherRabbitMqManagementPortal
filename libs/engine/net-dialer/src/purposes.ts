// The purpose registry (M0-69, DC-59, I-12): every reason this product opens an outbound socket,
// as data. The Dialer is the only way out (I-9) and every dial names a purpose, so this list is the
// complete list of outbound calls; the docs page `security/outbound-calls` is generated from it, and
// a release whose list changed needs a reviewed diff of that page. Nothing here imports anything:
// the docs generator reads this file on its own.
//
// Adding a purpose is a reviewed change (CODEOWNERS): say who is called, when, and whether it is on
// by default. Anything that phones home belongs on this list and is off by default.

export type PurposeStatus =
  /** Code that dials this purpose is in the repository today. */
  | 'active'
  /** Registered ahead of the code: the call does not exist yet. */
  | 'planned';

export interface PurposeSpec {
  /** What `DialTarget.purpose` carries: lower case, a short identifier. */
  readonly id: string;
  /** The feature, in words a user knows. */
  readonly feature: string;
  /** Who is called. A destination the person configures says so. */
  readonly destination: string;
  /** What makes the call happen. */
  readonly trigger: string;
  /** Whether it happens without the person asking. */
  readonly default: string;
  readonly status: PurposeStatus;
}

export const PURPOSES: readonly PurposeSpec[] = [
  {
    id: 'amqp',
    feature: 'Messaging (AMQP 0-9-1)',
    destination:
      'The broker host and port of a connection profile the person added',
    trigger: 'A peek, publish, tap or source lease on that connection',
    default: 'Never until a broker profile exists',
    status: 'active',
  },
  {
    id: 'mgmt-http',
    feature: 'Management HTTP API',
    destination:
      'The management endpoint of a connection profile the person added',
    trigger: 'Browsing and managing that broker, and the capability probe',
    default: 'Never until a broker profile exists',
    status: 'active',
  },
  {
    id: 'prom-scrape',
    feature: 'Metrics (Prometheus endpoint)',
    destination:
      'The Prometheus endpoint of a connection profile the person added',
    trigger: 'The background metrics sweep of that broker',
    default: 'Never until a broker profile exists',
    status: 'active',
  },
  {
    id: 'oidc',
    feature: 'Single sign-on and broker OAuth',
    destination:
      'The identity provider (discovery, key set and token endpoints) an administrator configured',
    trigger: 'A sign-in, a key refresh or a token refresh',
    default: 'Never until an identity provider is configured',
    status: 'planned',
  },
  {
    id: 'alert-webhook',
    feature: 'Alert notifications',
    destination:
      'The webhook or mail endpoint the person configured for a rule',
    trigger: 'An alert rule fires',
    default: 'Never until a notification channel is configured',
    status: 'planned',
  },
  {
    id: 'otlp-export',
    feature: 'OpenTelemetry export',
    destination: 'The OTLP endpoint the person configured',
    trigger: 'Spans and metrics of this tool, while the endpoint is set',
    default: 'Off; the exporter is not even loaded until an endpoint is set',
    status: 'planned',
  },
  {
    id: 'diagnostics-upload',
    feature: 'Diagnostics upload',
    destination:
      'The endpoint the person configured; the bundle is otherwise only written to a local file',
    trigger: 'The person chooses to send a diagnostics bundle',
    default: 'Off; there is no default endpoint',
    status: 'planned',
  },
  {
    id: 'update-check',
    feature: 'Update check (desktop)',
    destination: 'The release feed of this product',
    trigger: 'Startup and a timer, after the person opted in at first run',
    default: 'Off; asked once at first run, with no preselected answer',
    status: 'planned',
  },
];

const IDS: ReadonlySet<string> = new Set(PURPOSES.map((purpose) => purpose.id));

/** Whether `id` is on the list. The comparison is exact: a purpose is a name, not a pattern. */
export function isRegisteredPurpose(id: string): boolean {
  return IDS.has(id);
}
