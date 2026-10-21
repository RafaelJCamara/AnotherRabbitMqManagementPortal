// The composition root (ADR-001, blueprint 1): everything the engine is made of, wired once, the same
// for every delivery mode. A mode file (`modes/*.ts`) supplies a `ModeProfile` of adapters, which
// are storage, key wraps, authenticators, the authorisation policy and the listener, and nothing
// else differs. This file never asks which mode it runs in (`@app/no-mode-branching`).
//
// Startup order (blueprint 1.1):
//   lock        the data-directory lock, when the profile has one directory per engine
//   migrate     refuse a newer schema, back up, migrate
//   vault       open the data-key vault (needs the migrated `data_keys` table)
//   trust-store the CA set of every later outbound connection
//   compose     executor, job runner, live hub and the Fastify app, all unlistened
//   reconcile   what a crash left behind (blueprint 1.5)
//   listen      bind the socket, when the mode has one
//   ready       `{contract, schemaHash}`
// A failure at any step undoes the earlier ones (socket, database, lock) and rethrows.
import { createHash } from 'node:crypto';

import {
  emitSpecs,
  registry as contractRegistry,
  type Registry,
} from '@app/contracts';
import type { EngineMode, Permission } from '@app/contracts';
import { createJobRunner } from '@app/jobs';
import {
  AppError,
  BrokerScheduler,
  createActionExecutor,
  createAuditChain,
  createDrainCoordinator,
  createGuardrails,
  createIdGenerator,
  createPlanStore,
  createReceiptStore,
  executorGatePhase,
  scheduleMgmtRead,
  systemClock,
  systemTimers,
  type Authorizer,
  type Clock,
  type DrainCoordinator,
  type DrainPhaseSpec,
  type DrainReason,
  type DrainResult,
  type Logger,
  type Timers,
} from '@app/kernel';
import { LiveHub, createTopicRegistry } from '@app/live';
import {
  createMigrationRunner,
  createRepositories,
  type Repositories,
  migrations,
  type PersistenceHandle,
} from '@app/persistence';
import { createTrustStore, type TrustStoreOptions } from '@app/net-truststore';
import type { Principal } from '@app/ports';
import {
  createDataKeyVault,
  type KeyWrap,
  type VaultStatus,
  type WrapInput,
} from '@app/secrets';
import type { FileTokenSink, LogTail } from '@app/svc-ops';
import { buildApp, type Authenticator } from '@app/transport';
import type { FastifyInstance } from 'fastify';

import { createBrokerPorts, type BrokerPortsFactory } from './broker/index.ts';
import { mapMgmtErrors } from './broker/mgmt.ts';
import { acquireDataDirLock } from './data-dir-lock.ts';
import type { ModuleFactory } from './modules/index.ts';
import {
  jobsStep,
  pendingSteps,
  reconcile,
  type ReconcileReport,
} from './reconcile.ts';
import { createUnwiredWrites } from './unwired-writes.ts';

/** What a delivery mode swaps in. Nothing else about the engine depends on the mode. */
export interface ModeProfile {
  readonly mode: EngineMode;
  readonly storage: {
    open(): Promise<PersistenceHandle>;
    /** Where `VACUUM INTO` copies go before a migration. */
    readonly backupDir?: string;
    /** The directory one engine at a time may use; absent when the database arbitrates (team). */
    readonly lockDir?: string;
  };
  readonly vault: {
    /** In order of preference (OQ-300). */
    readonly wraps: readonly KeyWrap[];
    /** What unlocks the vault at start: a delivered key, a passphrase. */
    readonly input?: WrapInput;
    /** Called once `open` has returned or failed: the place to zero a delivered key. */
    readonly done?: () => void;
  };
  readonly authenticators: readonly Authenticator[];
  readonly authorizer: Authorizer;
  /** Whether a principal may subscribe to a live topic that needs `permission`. */
  readonly canSubscribe: (
    principal: Principal,
    permission: Permission,
  ) => boolean;
  /** Absent: no TCP listener (desktop; requests arrive over the MessagePort tunnel, M0-34). */
  readonly listener?: { readonly host: string; readonly port: number };
  readonly publicOrigins?: readonly string[];
  /** Asset directories of the web UI, newest first; absent when the mode serves none. */
  readonly uiRoots?: readonly string[];
  readonly jobs: {
    readonly recovery: 'interrupt-all-running' | 'interrupt-expired';
    readonly autoResume: 'never' | 'resumable';
  };
  /**
   * Where a diagnostics bundle can be saved and which secret values this mode holds (a launch
   * token, a carrier secret), so the bundle can remove them wherever they appear (M0-69, I-10).
   * Absent: this mode has no save target yet, and diagnostics.bundle is not registered.
   */
  readonly diagnostics?: {
    readonly files: FileTokenSink;
    readonly secretValues: () => readonly string[];
  };
}

export interface ComposeOptions {
  readonly profile: ModeProfile;
  readonly modules: ModuleFactory;
  readonly engineVersion: string;
  readonly logger: Logger;
  readonly registry?: Registry;
  /** Builds the broker-facing ports (management reads, wire probe, prober). Default: the real adapters; a spec passes fakes. */
  readonly brokerPorts?: BrokerPortsFactory;
  readonly trust?: TrustStoreOptions;
  /** The newest log lines, for the diagnostics bundle. Absent: no bundle (nothing to collect from). */
  readonly logs?: LogTail;
  /** Wraps the repositories over the database: a seam for the tests that make a write fail. */
  readonly decorateRepositories?: (repositories: Repositories) => Repositories;
  readonly clock?: Clock;
  readonly timers?: Timers;
}

export interface ReadyInfo {
  /** sha256 of the OpenAPI document the registry emits: what the UI was built against. */
  readonly contract: string;
  /** sha256 of the ordered migration ids of this engine: the schema the database is at. */
  readonly schemaHash: string;
}

export interface Engine {
  readonly mode: EngineMode;
  /** The bound socket; undefined when the mode has no listener. */
  readonly address:
    | { readonly host: string; readonly port: number }
    | undefined;
  readonly ready: ReadyInfo;
  /** Startup steps in the order they ran. */
  readonly steps: readonly string[];
  readonly reconciliation: readonly ReconcileReport[];
  /** What this engine answers: the registered action ids and the live topic ids. */
  readonly served: {
    readonly actions: readonly string[];
    readonly topics: readonly string[];
  };
  /** Requests can be injected into it; the tunnel of M0-34 does exactly that. */
  readonly app: FastifyInstance;
  vault(): VaultStatus;
  drain(reason: DrainReason, totalMs: number): Promise<readonly DrainResult[]>;
  /** Drains if that has not happened, then releases the socket, the database and the lock. */
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const DEFAULT_DRAIN_MS = 2000;
const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

export async function composeEngine(options: ComposeOptions): Promise<Engine> {
  const { profile, logger } = options;
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const contracts = options.registry ?? contractRegistry;
  const steps: string[] = [];
  /** Undone in reverse when a later step fails, and by `close`. */
  const undo: (() => Promise<void>)[] = [];
  const unwind = async (): Promise<void> => {
    for (const action of undo.splice(0).reverse()) {
      await action().catch((error: unknown) => {
        logger.warn({ event: 'engine.undo.failed', err: error }, 'cleanup');
      });
    }
  };
  const step = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const started = clock.monotonic();
    const result = await work();
    steps.push(name);
    logger.info(
      {
        event: 'engine.start.step',
        step: name,
        ms: Math.round(clock.monotonic() - started),
      },
      'startup step',
    );
    return result;
  };

  try {
    // A bind outside loopback needs authentication and TLS (DC-36), which this build cannot
    // configure: refuse before anything is opened.
    if (
      profile.listener !== undefined &&
      !LOOPBACK.has(profile.listener.host)
    ) {
      throw new AppError('GATE_BLOCKED', {
        detail:
          'A listener outside loopback needs authentication and TLS, which are not configured.',
      });
    }

    if (profile.storage.lockDir !== undefined) {
      const dir = profile.storage.lockDir;
      const lock = await step('lock', () => acquireDataDirLock(dir));
      undo.push(() => lock.release());
    }

    const handle = await profile.storage.open();
    let storageClosed: Promise<void> | undefined;
    const closeStorage = (): Promise<void> =>
      (storageClosed ??= handle.close());
    undo.push(closeStorage);
    await step('migrate', async () => {
      const runner = createMigrationRunner({
        handle,
        ...(profile.storage.backupDir === undefined
          ? {}
          : { backupDir: profile.storage.backupDir }),
      });
      const result = await runner.migrate();
      logger.info(
        {
          event: 'engine.migrate',
          from: result.from,
          to: result.to,
          backedUp: result.backup !== undefined,
        },
        'schema',
      );
    });
    const repos = (options.decorateRepositories ?? ((base) => base))(
      createRepositories(handle),
    );

    const vault = createDataKeyVault({
      repository: repos.dataKeys,
      wraps: profile.vault.wraps,
    });
    const vaultStatus = await step('vault', async () => {
      try {
        return await vault.open(profile.vault.input);
      } finally {
        profile.vault.done?.();
      }
    });
    if (vaultStatus.state !== 'unlocked') {
      logger.warn(
        { event: 'engine.vault', state: vaultStatus.state },
        'the data-key vault is not unlocked; plans and jobs cannot be sealed',
      );
    }

    const trust = await step('trust-store', () => {
      const store = createTrustStore(options.trust);
      store.install();
      return Promise.resolve(store);
    });
    logger.info({ event: 'engine.trust', ...trust.sources }, 'trust store');

    // ---- compose -------------------------------------------------------------------------
    const ids = createIdGenerator({ clock });
    const guardrails = createGuardrails({ clock });
    const audit = createAuditChain({ repository: repos.audit, logger });
    const writes = createUnwiredWrites();
    const executor = createActionExecutor({
      plans: createPlanStore({
        repository: repos.plans,
        cipher: vault.payloads,
        clock,
        ids,
      }),
      idempotency: repos.idempotency,
      authorizer: profile.authorizer,
      audit,
      guardrails: guardrails.policy,
      receipts: createReceiptStore({ repository: repos.receipts, clock, ids }),
      writes,
      clock,
      ids,
      logger,
    });
    const jobRunner = createJobRunner({
      store: repos.jobs,
      cipher: vault.payloads,
      clock,
      timers,
      ids,
      writes,
      logger,
      recovery: profile.jobs.recovery,
      autoResume: profile.jobs.autoResume,
    });
    // What the UI was built against and what the schema is at: the ready line carries them, and a
    // diagnostics bundle names them.
    const ready: ReadyInfo = {
      contract: sha256(emitSpecs(contracts)['openapi.v1.json'] ?? ''),
      schemaHash: sha256(
        migrations.map((migration) => migration.id).join('\n'),
      ),
    };
    // The broker-facing ports: the adapters behind the BrokerScheduler, which is the only path to the
    // management API (I-8), with the adapter's errors mapped to Problems on the way out.
    const scheduler = new BrokerScheduler({ clock, timers });
    const broker = (options.brokerPorts ?? createBrokerPorts)({
      connections: repos.connections,
      profiles: repos.brokerProfiles,
      sealer: vault.fields,
      trust,
      logger,
      mode: profile.mode,
    });
    const brokerClosed = (): void => {
      scheduler.close();
      broker.close();
    };
    undo.push(() => {
      brokerClosed();
      return Promise.resolve();
    });
    const topics = createTopicRegistry();
    const modules = options.modules({
      engineVersion: options.engineVersion,
      mode: profile.mode,
      arming: guardrails.arming,
      services: {
        connections: repos.connections,
        profiles: repos.brokerProfiles,
        workspace: repos.workspace,
        sealer: vault.fields,
        mgmt: mapMgmtErrors(scheduleMgmtRead(broker.mgmt, scheduler)),
        wire: broker.wire,
        prober: broker.prober,
        authorizer: profile.authorizer,
        newId: () => ids.ulid(),
        clock,
        timers,
      },
      ...(options.logs === undefined || profile.diagnostics === undefined
        ? {}
        : {
            ops: {
              diagnostics: {
                versions: () => ({
                  engine: options.engineVersion,
                  mode: profile.mode,
                  node: process.version,
                  platform: `${process.platform}-${process.arch}`,
                  ...ready,
                }),
                logs: options.logs,
                // `BrokerProfileStore` has no listing yet (a bundle needs a window of profiles), so the
                // bundle carries none (OQ-765).
                profiles: () => Promise.resolve([]),
                audit: repos.audit,
                secretValues: profile.diagnostics.secretValues,
              },
              files: profile.diagnostics.files,
              clock,
            },
          }),
    });
    for (const module of modules) {
      executor.register(...module.actions);
      for (const job of module.jobs ?? []) jobRunner.register(job);
      for (const topic of module.topics ?? []) {
        topics.register(topic.def, topic.source);
      }
    }
    const hub = new LiveHub({
      engineVersion: options.engineVersion,
      topics,
      canSubscribe: profile.canSubscribe,
      clock,
      timers,
      ids,
    });

    let state: 'starting' | 'ready' | 'draining' = 'starting';
    const app = buildApp(
      contracts,
      executor,
      {
        mode: profile.mode,
        authenticators: profile.authenticators,
        ...(profile.publicOrigins === undefined
          ? {}
          : { publicOrigins: profile.publicOrigins }),
      },
      {
        logger,
        ids,
        live: { hub },
        ...(profile.uiRoots === undefined
          ? {}
          : {
              ui: {
                roots: profile.uiRoots,
                engineVersion: options.engineVersion,
              },
            }),
      },
    );
    // Public, like the static UI: a container healthcheck has no token. They say whether the process
    // answers and whether it is taking work, and nothing else.
    app.get('/healthz', { config: { public: true } }, () => ({ status: 'ok' }));
    app.get('/readyz', { config: { public: true } }, (_request, reply) =>
      state === 'ready'
        ? { status: 'ready' }
        : reply.code(503).send({ status: state }),
    );
    undo.push(async () => {
      hub.close();
      await app.close();
    });

    const flush: DrainPhaseSpec = {
      name: 'flush',
      run: async ({ reason }) => {
        await audit.flushPending();
        // A suspend comes back: the database stays open.
        if (reason !== 'suspend') await closeStorage();
      },
    };
    const coordinator: DrainCoordinator = createDrainCoordinator({
      phases: [
        executorGatePhase(executor),
        {
          name: 'gate',
          reasons: ['quit', 'sigterm', 'emergency'],
          run: () => {
            hub.drain();
            return Promise.resolve();
          },
        },
        jobRunner.drainPhase(),
        ...modules.flatMap((module) => module.drainPhases ?? []),
        {
          // After the modules ended their sweeps: queued broker requests are refused, running ones
          // are aborted and the idle sockets go. A suspend comes back, so it keeps them.
          name: 'flush',
          reasons: ['quit', 'sigterm', 'emergency'],
          run: () => {
            brokerClosed();
            return Promise.resolve();
          },
        },
        flush,
      ],
      clock,
      timers,
      logger,
    });

    // ---- reconcile, listen, ready ----------------------------------------------------------
    const reconciliation = await step('reconcile', () =>
      reconcile([jobsStep(jobRunner), ...pendingSteps()], logger),
    );

    let address: Engine['address'];
    if (profile.listener !== undefined) {
      const { host, port } = profile.listener;
      address = await step('listen', async () => {
        await app.listen({ host, port });
        const bound = app.server.address();
        if (bound === null || typeof bound === 'string') {
          throw new AppError('INTERNAL', {
            detail: 'The listener has no address.',
          });
        }
        return { host, port: bound.port };
      });
    }

    await step('ready', () => {
      state = 'ready';
      return Promise.resolve();
    });
    void jobRunner.start().catch((error: unknown) => {
      logger.error(
        { event: 'engine.jobs.start.failed', err: error },
        'job runner',
      );
    });

    let drained: Promise<readonly DrainResult[]> | undefined;
    const drain: Engine['drain'] = (reason, totalMs) => {
      if (reason !== 'suspend') state = 'draining';
      const running = coordinator.drain(reason, totalMs);
      if (reason !== 'suspend') drained = running;
      return running;
    };
    let closing: Promise<void> | undefined;
    return {
      mode: profile.mode,
      address,
      ready,
      steps,
      reconciliation,
      served: {
        actions: executor.registered().map((def) => def.id),
        topics: modules.flatMap((module) =>
          (module.topics ?? []).map((topic) => topic.def.id),
        ),
      },
      app,
      vault: () => vault.status(),
      drain,
      close: () =>
        (closing ??= (async () => {
          await (drained ?? drain('quit', DEFAULT_DRAIN_MS));
          await unwind();
        })()),
    };
  } catch (error) {
    // A start that failed before the vault was opened (the lock, the database) still owes the
    // delivered key a zeroing.
    profile.vault.done?.();
    await unwind();
    throw error;
  }
}
