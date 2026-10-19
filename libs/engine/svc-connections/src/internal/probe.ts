// Testing one endpoint on its own (CON-01): the subject of a test (a saved profile with its stored
// secrets, or a draft with the secrets in it), the call to the prober, and the specific, honest
// message for each way it can fail. HTTP and AMQP are separate on purpose: a broker whose
// management API answers while 5672 is blocked is a normal situation with its own fix.
import type { EndpointsInput, GateDecision } from '@app/contracts';
import { AppError } from '@app/kernel';
import type {
  AmqpProbeResult,
  ConnectionProber,
  HttpProbeResult,
  ProbeAmqpEndpoint,
  ProbeFailureReason,
  ProbeHttpEndpoint,
} from '@app/ports';

import type { ConnectionsModuleDeps } from '../deps';
import { loadVisible, openSecret } from './common';
import { configOf, resolveNew, type StoredConfig } from './endpoints';

/** A test gives up after this long, whatever the adapter does. */
export const TEST_TIMEOUT_MS = 15_000;

/**
 * The features that need an AMQP connection. They are stand-ins until the capability gates
 * (M0-46) define the catalogue: a failed AMQP test closes all of them with its reason (OQ-445).
 */
export const AMQP_FEATURES = [
  'amqp.peek',
  'amqp.tap',
  'amqp.publish',
  'amqp.replay',
] as const;

export const AMQP_GATE_SOURCE = 'connections.test-amqp';

/** What a test is about: the address and the secrets that go with it, in the open for this call only. */
export interface TestSubject {
  readonly config: StoredConfig;
  /** The secret of each protocol; undefined when none is set or it cannot be opened. */
  readonly secret: {
    readonly http: string | undefined;
    readonly amqp: string | undefined;
  };
  /** Why a secret the profile needs is missing: it was never set, or it cannot be opened. */
  readonly missing: {
    readonly http: 'unset' | 'unreadable' | undefined;
    readonly amqp: 'unset' | 'unreadable' | undefined;
  };
}

interface TestInput {
  cid?: string | undefined;
  draft?: EndpointsInput | undefined;
}

export async function loadSubject(
  deps: Pick<ConnectionsModuleDeps, 'store' | 'sealer'>,
  principalId: string,
  input: TestInput,
): Promise<TestSubject> {
  if ((input.cid === undefined) === (input.draft === undefined)) {
    throw new AppError('VALIDATION_FAILED', {
      detail:
        'Give either cid (a saved connection) or draft (an unsaved one), not both and not neither.',
    });
  }
  if (input.draft !== undefined) {
    const resolved = resolveNew(input.draft);
    const put = (change: (typeof resolved.secrets)['http']) =>
      typeof change === 'object' ? change.put : undefined;
    return {
      config: resolved.config,
      secret: {
        http: put(resolved.secrets.http),
        amqp: put(resolved.secrets.amqp),
      },
      missing: { http: undefined, amqp: undefined },
    };
  }
  const cid = input.cid ?? '';
  const record = await loadVisible(deps.store, cid, principalId);
  const config = configOf(record);
  const stored = await deps.store.credentials(cid);
  const read = async (protocol: 'http' | 'amqp', kind: string) => {
    if (kind === 'none') return { secret: undefined, missing: undefined };
    const row = stored.find((entry) => entry.protocol === protocol);
    if (row === undefined)
      return { secret: undefined, missing: 'unset' as const };
    const secret = await openSecret(deps.sealer, cid, protocol, row.ciphertext);
    return secret === undefined
      ? { secret, missing: 'unreadable' as const }
      : { secret, missing: undefined };
  };
  const http = await read('http', config.http.auth.kind);
  const amqp = await read('amqp', config.amqp.auth.kind);
  return {
    config,
    secret: { http: http.secret, amqp: amqp.secret },
    missing: { http: http.missing, amqp: amqp.missing },
  };
}

/** The signal a probe runs under: the caller's, and the test's own time limit. */
export function probeSignal(caller: AbortSignal): AbortSignal {
  return AbortSignal.any([caller, AbortSignal.timeout(TEST_TIMEOUT_MS)]);
}

export function httpEndpointOf(subject: TestSubject): ProbeHttpEndpoint {
  const { http } = subject.config;
  const auth: ProbeHttpEndpoint['auth'] =
    http.auth.kind === 'basic'
      ? {
          kind: 'basic',
          username: http.auth.username ?? '',
          password: subject.secret.http ?? '',
        }
      : http.auth.kind === 'bearer'
        ? { kind: 'bearer', token: subject.secret.http ?? '' }
        : { kind: 'none' };
  return {
    host: http.host,
    port: http.port,
    tls: http.tls,
    ...(http.pathPrefix === null ? {} : { pathPrefix: http.pathPrefix }),
    auth,
  };
}

export function amqpEndpointOf(subject: TestSubject): ProbeAmqpEndpoint {
  const { amqp } = subject.config;
  return {
    host: amqp.host,
    port: amqp.port,
    tls: amqp.tls,
    vhost: amqp.vhost,
    auth:
      amqp.auth.kind === 'plain'
        ? {
            kind: 'plain',
            username: amqp.auth.username ?? '',
            password: subject.secret.amqp ?? '',
          }
        : { kind: 'none' },
  };
}

/** A prober that rejects is a bug in the prober: the test reports `unexpected` and says nothing more. */
export async function runHttpProbe(
  prober: ConnectionProber,
  endpoint: ProbeHttpEndpoint,
  signal: AbortSignal,
): Promise<HttpProbeResult> {
  try {
    return await prober.http(endpoint, signal);
  } catch {
    return { ok: false, failure: { reason: 'unexpected' } };
  }
}

export async function runAmqpProbe(
  prober: ConnectionProber,
  endpoint: ProbeAmqpEndpoint,
  signal: AbortSignal,
): Promise<AmqpProbeResult> {
  try {
    return await prober.amqp(endpoint, signal);
  } catch {
    return { ok: false, failure: { reason: 'unexpected' } };
  }
}

type HttpFailureCode =
  | 'HTTP_UNREACHABLE'
  | 'HTTP_TIMEOUT'
  | 'HTTP_EGRESS_DENIED'
  | 'HTTP_TLS_UNTRUSTED'
  | 'HTTP_AUTH_REFUSED'
  | 'HTTP_MISSING_TAG'
  | 'HTTP_NOT_MANAGEMENT'
  | 'HTTP_UNEXPECTED';

const HTTP_FAILURES: Readonly<
  Record<ProbeFailureReason, { code: HttpFailureCode; message: string }>
> = {
  unreachable: {
    code: 'HTTP_UNREACHABLE',
    message:
      'The management API did not answer: the connection was refused or the host could not be found. Check the host, the port and the firewall.',
  },
  timeout: {
    code: 'HTTP_TIMEOUT',
    message: 'The management API did not answer in time.',
  },
  'egress-denied': {
    code: 'HTTP_EGRESS_DENIED',
    message: 'The egress policy does not allow connections to this address.',
  },
  'tls-untrusted': {
    code: 'HTTP_TLS_UNTRUSTED',
    message:
      'The server certificate is not trusted: its issuer is unknown or it does not match the host name.',
  },
  'auth-refused': {
    code: 'HTTP_AUTH_REFUSED',
    message:
      'The management API refused the login: wrong user name, password or token.',
  },
  'missing-tag': {
    code: 'HTTP_MISSING_TAG',
    message:
      'The login works, but the user has no management tag (management, monitoring, policymaker or administrator).',
  },
  'not-management': {
    code: 'HTTP_NOT_MANAGEMENT',
    message:
      'Something answered, but it is not a RabbitMQ management API. Check the port and the path prefix.',
  },
  'vhost-refused': {
    code: 'HTTP_UNEXPECTED',
    message: 'The management API answered in a way this test does not expect.',
  },
  unexpected: {
    code: 'HTTP_UNEXPECTED',
    message: 'The test failed for a reason this test does not recognise.',
  },
};

export function httpFailure(reason: ProbeFailureReason): {
  code: HttpFailureCode;
  message: string;
} {
  return HTTP_FAILURES[reason];
}

type AmqpFailureCode =
  | 'AMQP_PORT_BLOCKED'
  | 'AMQP_EGRESS_DENIED'
  | 'AMQP_TLS_UNTRUSTED'
  | 'AMQP_AUTH_REFUSED'
  | 'AMQP_VHOST_REFUSED'
  | 'AMQP_UNEXPECTED';

/** `unreachable` and `timeout` both mean nothing answered on the AMQP port: it is blocked or closed. */
export function amqpFailure(
  reason: ProbeFailureReason,
  endpoint: { host: string; port: number },
): { code: AmqpFailureCode; message: string } {
  const where = `${endpoint.host}:${String(endpoint.port)}`;
  switch (reason) {
    case 'unreachable':
    case 'timeout':
      return {
        code: 'AMQP_PORT_BLOCKED',
        message: `AMQP port blocked: nothing answered on ${where}. A firewall, a security group, a wrong port or a broker without an AMQP listener can cause this. The management API is tested separately.`,
      };
    case 'egress-denied':
      return {
        code: 'AMQP_EGRESS_DENIED',
        message:
          'The egress policy does not allow connections to this address.',
      };
    case 'tls-untrusted':
      return {
        code: 'AMQP_TLS_UNTRUSTED',
        message:
          'The server certificate is not trusted: its issuer is unknown or it does not match the host name.',
      };
    case 'auth-refused':
      return {
        code: 'AMQP_AUTH_REFUSED',
        message:
          'The broker refused the AMQP login: wrong user name or password.',
      };
    case 'vhost-refused':
      return {
        code: 'AMQP_VHOST_REFUSED',
        message:
          'The login works, but the user may not use this vhost, or the vhost does not exist.',
      };
    default:
      return {
        code: 'AMQP_UNEXPECTED',
        message:
          'The AMQP test failed for a reason this test does not recognise.',
      };
  }
}

export const SECRET_UNAVAILABLE = {
  unset: 'No secret is stored for this connection. Enter it first.',
  unreadable:
    'The stored secret cannot be opened (the vault is locked, or the credential was changed). Enter it again.',
} as const;

/** Every AMQP feature open, or every one closed with the same reason. */
export function amqpGates(
  failure: string | undefined,
): Record<string, GateDecision> {
  return Object.fromEntries(
    AMQP_FEATURES.map((feature) => [
      feature,
      failure === undefined
        ? { enabled: true }
        : { enabled: false, reason: failure, source: AMQP_GATE_SOURCE },
    ]),
  );
}
