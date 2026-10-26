// Fakes for the peek preflight and the rescue preflight (M1-13): a scripted management API, a fake
// `PeekEvidencePort`, a recording `send`, a `send` that fails the run when touched, and a found queue
// built from a spec. The specs of the three slices and `testing.ts` use them.
//
// The scripted API is a plain description of a vhost: the rows are raw management JSON, so a spec can
// leave a field out the way a stats-off or provider-restricted broker does. It records every request
// and parses the answer with the schema the caller sent, as the real adapter does (a body of the wrong
// shape is a BROKER_ERROR Problem, the adapter's `unexpected-body`). The paths are the ones the
// management API serves; a path with no row answers 404, and `failures` makes a path answer a status.
import { parseSemVer, type Era } from '@app/domain-model';
import { AppError } from '@app/kernel';
import type {
  Lane,
  MgmtQuery,
  MgmtReadPort,
  MgmtSendRequest,
  PeekEvidencePort,
  PeekEvidenceRequest,
  QueuesEffectiveConfigOutput,
  RoutingDlxSourcesOutput,
} from '@app/ports';
import { ZodError } from 'zod';

import type { PreflightProfile } from './preflight.ts';
import type {
  FoundQueue,
  QuarantineQueueSpec,
  QuarantineSend,
} from './quarantine.ts';

/** A raw management row: whatever the broker would send, fields left out on purpose. */
export type ManagementRow = Readonly<Record<string, unknown>>;

export interface RecordedRequest {
  readonly method: 'GET' | 'STREAM';
  readonly path: string;
  readonly query: MgmtQuery | undefined;
  readonly lane: Lane;
}

export interface VhostDescription {
  readonly vhost: string;
  /** Queue rows by queue name. */
  readonly queues?: Readonly<Record<string, ManagementRow>>;
  /** The lists are raw bodies: a bare array or a paged envelope. */
  readonly consumers?: unknown;
  readonly policies?: unknown;
  readonly operatorPolicies?: unknown;
  readonly nodes?: unknown;
  readonly connections?: unknown;
  /** The permission row of `user`, when the user has one. */
  readonly user?: string;
  readonly permission?: ManagementRow;
  /** HTTP status a path answers with instead of a body: 403, 404 and 5xx become Problems. */
  readonly failures?: Readonly<Record<string, number>>;
  /** Called before each answer; a spec uses it to move a manual clock during a read. */
  readonly onRequest?: (request: RecordedRequest) => void;
}

export interface ScriptedManagement {
  readonly mgmt: MgmtReadPort;
  readonly requests: readonly RecordedRequest[];
}

export const queuePath = (vhost: string, queue: string): string =>
  `/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(queue)}`;

const STATUS_CODE: Readonly<
  Record<number, ConstructorParameters<typeof AppError>[0]>
> = { 403: 'FORBIDDEN_BROKER', 404: 'NOT_FOUND' };

export function createScriptedManagement(
  description: VhostDescription,
): ScriptedManagement {
  const { vhost } = description;
  const enc = encodeURIComponent(vhost);
  const routes = new Map<string, unknown>();
  for (const [name, row] of Object.entries(description.queues ?? {})) {
    routes.set(queuePath(vhost, name), row);
  }
  routes.set(`/api/consumers/${enc}`, description.consumers ?? []);
  routes.set(`/api/policies/${enc}`, description.policies ?? []);
  routes.set(
    `/api/operator-policies/${enc}`,
    description.operatorPolicies ?? [],
  );
  routes.set('/api/nodes', description.nodes ?? []);
  routes.set(`/api/vhosts/${enc}/connections`, description.connections ?? []);
  if (description.permission !== undefined) {
    const user = encodeURIComponent(description.user ?? 'guest');
    routes.set(`/api/permissions/${enc}/${user}`, description.permission);
  }
  const requests: RecordedRequest[] = [];
  const record = (request: RecordedRequest): void => {
    requests.push(request);
    description.onRequest?.(request);
  };
  const mgmt: MgmtReadPort = {
    get(request, signal) {
      signal.throwIfAborted();
      record({
        method: 'GET',
        path: request.path,
        query: request.query,
        lane: request.lane,
      });
      const status = description.failures?.[request.path];
      if (status !== undefined) {
        return Promise.reject(
          new AppError(STATUS_CODE[status] ?? 'BROKER_ERROR'),
        );
      }
      if (!routes.has(request.path)) {
        return Promise.reject(new AppError('NOT_FOUND'));
      }
      try {
        return Promise.resolve(request.schema.parse(routes.get(request.path)));
      } catch (error) {
        if (error instanceof ZodError) {
          return Promise.reject(new AppError('BROKER_ERROR'));
        }
        throw error;
      }
    },
    stream(request) {
      record({
        method: 'STREAM',
        path: request.path,
        query: request.query,
        lane: request.lane,
      });
      return Promise.reject(new Error('stream is not scripted'));
    },
  };
  return { mgmt, requests };
}

export interface RecordedSend {
  readonly method: MgmtSendRequest<unknown>['method'];
  readonly path: string;
  readonly body: unknown;
}

/** A `send` that records what it was given and answers like a broker that accepts the request. */
export function createRecordingSend(
  behaviour: (call: RecordedSend) => Promise<unknown> = () =>
    Promise.resolve(undefined),
): { readonly send: QuarantineSend; readonly calls: readonly RecordedSend[] } {
  const calls: RecordedSend[] = [];
  const send: QuarantineSend = (request) => {
    const call = {
      method: request.method,
      path: request.path,
      body: request.body,
    };
    calls.push(call);
    return behaviour(call);
  };
  return { send, calls };
}

/** A `send` that fails the test run when anything reaches it. */
export const throwingSend: QuarantineSend = () => {
  throw new Error('a write was attempted where none is allowed');
};

/** What a queue found on the broker looks like when it is the spec; `overrides` make it differ. */
export function foundFromSpec(
  spec: QuarantineQueueSpec,
  overrides: Partial<FoundQueue> = {},
): FoundQueue {
  return {
    name: spec.name,
    vhost: spec.vhost,
    type: spec.arguments['x-queue-type'],
    durable: spec.durable,
    autoDelete: spec.autoDelete,
    arguments: { ...spec.arguments },
    ...overrides,
  };
}

export interface FakeEvidenceOptions {
  readonly dlxSources?: Partial<RoutingDlxSourcesOutput>;
  readonly effectiveConfig?: Partial<QueuesEffectiveConfigOutput>;
  /** When set, both calls reject with it (a timeout, a Problem). */
  readonly failWith?: Error;
}

export interface FakeEvidence extends PeekEvidencePort {
  readonly calls: readonly {
    readonly op: 'dlxSources' | 'effectiveConfig';
    readonly request: PeekEvidenceRequest & {
      readonly heldDeathSources?: readonly string[];
    };
  }[];
}

const SNAPSHOT: RoutingDlxSourcesOutput['snapshot'] = {
  takenAt: 0,
  truncation: {
    queues: 0,
    exchanges: 0,
    bindings: 0,
    consumers: 0,
    policies: 0,
    operatorPolicies: 0,
  },
  consumers: 'read',
};

/** A complete, hazard-free `routing.dlx-sources` answer; `overrides` make it differ. */
export function dlxAnswer(
  request: PeekEvidenceRequest,
  overrides: Partial<RoutingDlxSourcesOutput> = {},
): RoutingDlxSourcesOutput {
  return {
    vhost: request.vhost,
    queue: request.queue,
    sources: [],
    sourcesMore: 0,
    complete: true,
    unknownReasons: [],
    unknownReasonsMore: 0,
    truncation: { sources: 0, steps: 0, paths: 0, loops: 0, candidates: 0 },
    heldDeathSourcesConsidered: [],
    gaps: [],
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

/** A `queues.effective-config` answer that decided nothing (`effective` is null); `overrides` fill it in. */
export function effectiveConfigAnswer(
  request: PeekEvidenceRequest,
  overrides: Partial<QueuesEffectiveConfigOutput> = {},
): QueuesEffectiveConfigOutput {
  return {
    vhost: request.vhost,
    queue: request.queue,
    queueType: null,
    version: null,
    mixedVersions: false,
    layers: { user: { state: 'none' }, operator: { state: 'none' } },
    effective: null,
    gaps: [],
    snapshot: SNAPSHOT,
    ...overrides,
  };
}

export function createFakeEvidence(
  options: FakeEvidenceOptions = {},
): FakeEvidence {
  const calls: {
    op: 'dlxSources' | 'effectiveConfig';
    request: PeekEvidenceRequest & { heldDeathSources?: readonly string[] };
  }[] = [];
  const answer = <T>(
    op: 'dlxSources' | 'effectiveConfig',
    request: PeekEvidenceRequest,
    signal: AbortSignal,
    make: () => T,
  ): Promise<T> => {
    signal.throwIfAborted();
    calls.push({ op, request });
    return options.failWith === undefined
      ? Promise.resolve(make())
      : Promise.reject(options.failWith);
  };
  return {
    calls,
    dlxSources: (request, _principal, signal) =>
      answer('dlxSources', request, signal, () =>
        dlxAnswer(request, options.dlxSources),
      ),
    effectiveConfig: (request, _principal, signal) =>
      answer('effectiveConfig', request, signal, () =>
        effectiveConfigAnswer(request, options.effectiveConfig),
      ),
  };
}

// Fixtures of the rescue preflight specs (M1-13 slice C): a profile for an era, the queue that is
// peeked, the quarantine queue as the management API lists it, a policy, healthy nodes, a permission.
const VERSION_OF: Readonly<Record<Era, string>> = {
  '3.13': '3.13.7',
  '4.0-4.2': '4.2.9',
  '4.3': '4.3.6',
  '4.4': '4.4.0',
};

export interface ProfileOptions {
  readonly era?: Era;
  readonly classicEnabled?: boolean | 'unknown';
  readonly version?: string | null;
  readonly maxMessageBytes?: number;
}
export function profileOf(options: ProfileOptions = {}): PreflightProfile {
  const era = options.era ?? '4.0-4.2';
  const version =
    options.version === undefined ? VERSION_OF[era] : options.version;
  return {
    era: { value: era, reasons: [], conservative: false },
    versions: {
      min: version === null ? null : parseSemVer(version),
      perNode: {},
      mixed: false,
      build: 'oss',
    },
    identity: {
      user: 'ada',
      tags: [],
      isAdmin: false,
      canMonitor: true,
      isPolicymaker: false,
    },
    classicEnabled: options.classicEnabled ?? true,
    limits: {
      preAuthFrameMax: 4096,
      ...(options.maxMessageBytes === undefined
        ? {}
        : { maxMessageBytes: options.maxMessageBytes }),
    },
  };
}

export const peekedQuorumRow: ManagementRow = {
  name: 'orders',
  type: 'quorum',
  durable: true,
  auto_delete: false,
  arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 20 },
  consumers: 1,
  messages_ready: 40,
  message_bytes_ready: 40_000,
  policy: null,
  operator_policy: null,
  delivery_limit: 20,
  delayed_retry: 'disabled',
  leader: 'rabbit@a',
  members: ['rabbit@a'],
  online: ['rabbit@a'],
};
export const quarantineRow = (
  overrides: ManagementRow = {},
): ManagementRow => ({
  name: 'product.quarantine',
  type: 'classic',
  durable: true,
  auto_delete: false,
  exclusive: false,
  arguments: { 'x-queue-type': 'classic', 'x-overflow': 'reject-publish' },
  messages: 0,
  message_bytes: 0,
  ...overrides,
});
export const policyRow = (
  definition: Record<string, unknown>,
  overrides: ManagementRow = {},
): ManagementRow => ({
  name: 'amazon-mq',
  pattern: '.*',
  'apply-to': 'all',
  priority: 0,
  definition,
  ...overrides,
});
export const healthyNodes = [
  { name: 'rabbit@a', mem_alarm: false, disk_free_alarm: false },
];
export const openPermission = { configure: '.*', write: '.*', read: '.*' };
