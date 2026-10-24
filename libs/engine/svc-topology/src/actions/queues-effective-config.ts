// queues.effective-config: The effective configuration of one queue, per key, with provenance
// Reads the vhost, finds the queue, and resolves its arguments and the policy layers that apply to it
// with the registry rules (@app/effective-config). A layer that cannot be decided (a policy list the
// principal may not read, an ambiguous match) gives `effective: null` and says why in `layers` and
// `gaps`; nothing is resolved from a guess.
import { queuesEffectiveConfig, type OutputOf } from '@app/contracts';
import type { EffectiveConfig } from '@app/effective-config';
import { AppError, implementAction, type ActionImpl } from '@app/kernel';

import { collectGaps } from '../internal/gaps';
import { loadVhost, snapshotMeta, type ActionDeps } from '../internal/load';
import { resolveQueueConfig, type PolicyLayer } from '../internal/settings';

/** The ports this action reads through (src/internal/load.ts). */
export type QueuesEffectiveConfigDeps = ActionDeps;

type Output = OutputOf<typeof queuesEffectiveConfig>;

const layerView = (layer: PolicyLayer): Output['layers']['user'] =>
  layer.state === 'policy'
    ? { state: 'policy', name: layer.policy.name }
    : layer;

/** The library's answer as the contract's: fresh arrays, and no field the contract does not name. */
function effectiveView(
  config: EffectiveConfig,
): NonNullable<Output['effective']> {
  const warning = (w: EffectiveConfig['warnings'][number]) => ({
    id: w.id,
    severity: w.severity,
    textKey: w.textKey,
    textVersion: w.textVersion,
    params: { ...w.params },
    citations: w.citations.map((c) => ({ kind: c.kind, ref: c.ref })),
  });
  return {
    queueType: config.queueType,
    version: config.version,
    entries: Object.fromEntries(
      Object.entries(config.entries).map(([key, entry]) => [
        key,
        {
          key: entry.key,
          argument: entry.argument,
          status: entry.status,
          value: entry.value,
          rule: entry.rule,
          mergeRule: entry.mergeRule,
          basis: entry.basis,
          provenance: entry.provenance.map((p) => ({
            layer: p.layer,
            name: p.name,
            value: p.value,
            role: p.role,
          })),
          warnings: entry.warnings.map(warning),
        },
      ]),
    ),
    mergedPolicy: {
      notEffective: true,
      entries: Object.fromEntries(
        Object.entries(config.mergedPolicy.entries).map(([key, entry]) => [
          key,
          { ...entry },
        ]),
      ),
    },
    unrecognisedArguments: [...config.unrecognisedArguments],
    warnings: config.warnings.map(warning),
  };
}

export const createQueuesEffectiveConfigAction = (
  deps: QueuesEffectiveConfigDeps,
): ActionImpl<typeof queuesEffectiveConfig> =>
  implementAction(queuesEffectiveConfig, {
    execute: async (input, ctx) => {
      const loaded = await loadVhost(deps, input, ctx);
      const { profile, snapshot } = loaded;
      const row = snapshot.queues.find((queue) => queue.name === input.queue);
      if (row === undefined) {
        throw new AppError('NOT_FOUND', {
          detail:
            snapshot.truncation.queues > 0
              ? 'The queue is not among the queues that were read; the vhost is larger than the limit.'
              : 'There is no such queue.',
        });
      }
      const config = resolveQueueConfig(row, {
        policies: snapshot.policies,
        operatorPolicies: snapshot.operatorPolicies,
        version: profile.versions.min,
      });
      return {
        vhost: input.vhost,
        queue: input.queue,
        queueType: config.type,
        version: profile.versions.min?.raw ?? null,
        mixedVersions: profile.versions.mixed,
        layers: {
          user: layerView(config.layers.user),
          operator: layerView(config.layers.operator),
        },
        effective:
          config.effective === null ? null : effectiveView(config.effective),
        gaps: [
          ...collectGaps(snapshot, profile, {
            statsMissing: config.statsMissing,
            undecided: config.undecided,
            skipped: 0,
          }),
        ],
        snapshot: snapshotMeta(snapshot),
      };
    },
  });
