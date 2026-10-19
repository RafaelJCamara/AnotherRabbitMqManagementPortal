// probe.run: Probe the broker with management reads and cache its BrokerProfile
import { ErrorCodeSchema, probeRun, type ErrorCode } from '@app/contracts';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';
import { semanticsRegistry } from '@app/semantics';

import type { CapabilitiesModuleDeps } from '../deps';
import { requireVisible } from '../internal/visible';
import { runProbe } from '../probe/run';
import { buildProfile } from '../profile-builder';

/** The ports this action uses: a subset of the module's deps (src/deps.ts). */
export type ProbeRunDeps = Pick<
  CapabilitiesModuleDeps,
  'mgmt' | 'wire' | 'profiles' | 'connections' | 'lastVerified' | 'registry'
>;

/** The failures of the broker that say something a person can act on; the rest is "unreachable". */
const PASS_THROUGH: readonly ErrorCode[] = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN_BROKER',
  'BROKER_ERROR',
  'RATE_LIMITED',
  'EGRESS_DENIED',
  'TLS_UNTRUSTED',
];

function codeOf(code: string | undefined): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(code);
  return parsed.success && PASS_THROUGH.includes(parsed.data)
    ? parsed.data
    : 'BROKER_UNREACHABLE';
}

export const createProbeRunAction = (
  deps: ProbeRunDeps,
): ActionImpl<typeof probeRun> =>
  implementAction(probeRun, {
    execute: async (input, ctx) => {
      await requireVisible(deps.connections, input.cid, ctx.principal.id);
      const registry = deps.registry ?? semanticsRegistry;
      const run = await runProbe({
        connectionId: input.cid,
        mgmt: deps.mgmt,
        wire: deps.wire,
        registry,
        signal: ctx.signal,
      });

      // Without the overview there is no product, so no profile: keep the cache that exists rather
      // than replace a real profile with one that knows nothing.
      const overview = run.steps.find((step) => step.id === 'overview');
      if (overview?.status !== 'ok') {
        throw new AppError(codeOf(overview?.code), {
          detail: `The broker could not be probed: ${overview?.detail ?? 'the overview was not read'}.`,
        });
      }

      const profile = buildProfile({
        connectionId: input.cid,
        probedAt: ctx.now(),
        facts: run.facts,
        registry,
        lastVerified: deps.lastVerified?.() ?? [],
      });
      const before = await deps.profiles.get(input.cid);
      await deps.profiles.put({
        connectionId: input.cid,
        fingerprint: profile.fingerprint,
        verification: profile.verification,
        probedAt: profile.probedAt,
        profile,
      });
      return {
        profile,
        changed: before?.fingerprint !== profile.fingerprint,
        steps: run.steps.map((step) => ({
          id: step.id,
          status: step.status,
          ...(step.detail === undefined
            ? {}
            : { detail: step.detail.slice(0, 200) }),
        })),
      };
    },
  });
