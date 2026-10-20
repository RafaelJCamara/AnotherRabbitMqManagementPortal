// The feature catalogue (DC-31, DC-32) and one decision per feature. A gate is open only on positive
// evidence: a feature the evidence does not settle is closed, with the reason and where it comes
// from. Nothing here compares a broker version (I-3): the provider preset and the registry's gate
// rows answer, and a reason is a fixed string or registry text, never the broker's own words (I-10).
import {
  FeatureIdSchema,
  type FeatureId,
  type GateDecision,
} from '@app/contracts';
import type { BrokerProfile } from '@app/domain-model';
import {
  SemanticsGapError,
  type BrokerSemanticsRegistry,
  type SupportArea,
} from '@app/semantics';

import { isRabbitMqFamily } from '../probe/identify';
import type { Facts } from '../probe/types';

export const FEATURE_NAMES = [
  'streams.browse',
  'tap.firehose',
  'audit.event-exchange',
  'policies.operator-edit',
  'amqp.peek',
  'amqp.tap',
  'amqp.publish',
  'amqp.replay',
] as const;

/** The features this package decides, in a stable order. */
export const FEATURES: readonly FeatureId[] = FEATURE_NAMES.map((name) =>
  FeatureIdSchema.parse(name),
);

/** What the builder has so far: the profile without its gates. */
export type GateProfileInput = Omit<
  BrokerProfile,
  'gates' | 'fingerprint' | 'probedAt'
>;

export interface GateInput {
  readonly profile: GateProfileInput;
  /** Only for the AMQP handshake outcome; no free text of it is copied. */
  readonly facts: Facts;
  readonly registry: BrokerSemanticsRegistry;
}

const PROBE_NODES = 'probe step 7 (nodes)';
const PROBE_OVERVIEW = 'probe step 5 (overview)';
const PROBE_AMQP = 'probe step 12 (amqp-handshake)';
const PLUGINS_SOURCE = 'probe steps 6 and 7 (extensions, nodes)';

const closed = (reason: string, source: string): GateDecision => ({
  enabled: false,
  reason,
  source,
});
const open = (): GateDecision => ({ enabled: true, mode: 'full' });

interface Context extends GateInput {
  readonly family: boolean;
  /** Undefined when the registry has no preset (it has one for every provider and product). */
  readonly preset:
    | ReturnType<BrokerSemanticsRegistry['providerPreset']>
    | undefined;
}

/** The provider preset and its first citation, which is what a closed gate points at. */
function presetSource(ctx: Context): string {
  const preset = ctx.preset;
  return preset === undefined
    ? 'provider preset (not found)'
    : `provider preset ${preset.id}: ${preset.citations[0]?.ref ?? 'no citation'}`;
}

/** The decision shared by the features a provider preset or the product can rule out. */
function ruledOut(ctx: Context, area: SupportArea, what: string) {
  const { product } = ctx.profile;
  if (!ctx.family) {
    return closed(
      `the product is ${product}, which has no ${what} in the RabbitMQ sense`,
      presetSource(ctx),
    );
  }
  if (ctx.preset === undefined) {
    return closed(
      `the provider limits are unknown, so ${what} is not proven`,
      presetSource(ctx),
    );
  }
  if (ctx.preset.support[area] === 'blocked') {
    return closed(
      `${ctx.profile.provider} does not offer ${what}`,
      presetSource(ctx),
    );
  }
  return undefined;
}

/** Open, or degraded when the provider preset says the area is only partly supported. */
function openFor(ctx: Context, area: SupportArea): GateDecision {
  return ctx.preset?.support[area] === 'partial'
    ? {
        enabled: true,
        mode: 'degraded',
        reason: `${ctx.profile.provider} supports this only in part`,
        source: presetSource(ctx),
      }
    : open();
}

function streamsBrowse(ctx: Context): GateDecision {
  const out = ruledOut(ctx, 'streams', 'stream queues');
  if (out !== undefined) return out;
  return ctx.profile.streams.supported
    ? openFor(ctx, 'streams')
    : closed(
        'the stream plugin was not seen: neither rabbitmq_stream in the plugin list nor stream.js in the management extensions',
        PLUGINS_SOURCE,
      );
}

function tapFirehose(ctx: Context): GateDecision {
  const out = ruledOut(ctx, 'firehose', 'the firehose');
  if (out !== undefined) return out;
  switch (ctx.profile.firehose.available) {
    case 'tracing-plugin':
      return openFor(ctx, 'firehose');
    case 'runbook-only':
      return closed(
        'the tracing plugin was not seen, so the firehose can only be shown as a runbook',
        'probe steps 7 and 10 (nodes, exchanges)',
      );
    default:
      return closed(
        'the firehose is not available on this broker',
        presetSource(ctx),
      );
  }
}

function auditEventExchange(ctx: Context): GateDecision {
  const out = ruledOut(ctx, 'eventExchange', 'the event exchange');
  if (out !== undefined) return out;
  const lists = ctx.profile.nodes.flatMap((node) =>
    node.enabledPlugins === undefined ? [] : [node.enabledPlugins],
  );
  if (lists.length === 0) {
    return closed(
      'the plugin state is unknown: the node list gave no plugins (statistics off, or the nodes could not be read)',
      PROBE_NODES,
    );
  }
  return lists.some((plugins) => plugins.includes('rabbitmq_event_exchange'))
    ? openFor(ctx, 'eventExchange')
    : closed(
        'the rabbitmq_event_exchange plugin is not enabled on any node',
        PROBE_NODES,
      );
}

const OPERATOR_POLICY_REMEDIATION =
  'The broker answers HTTP 405 for operator-policy edits. Publish a configuration revision with management.restrictions.operator_policy_changes.disabled=false, then reboot the broker.';

function operatorEdit(ctx: Context): GateDecision {
  switch (ctx.profile.restrictions.operatorPolicyChanges) {
    case 'allowed':
      return open();
    case 'disabled': {
      const flag =
        ctx.facts.overviews[0]?.overview.is_op_policy_updating_enabled;
      return ctx.profile.provider === 'amazon-mq'
        ? closed(OPERATOR_POLICY_REMEDIATION, presetSource(ctx))
        : closed(
            flag === false
              ? 'the broker reports that operator-policy changes are switched off'
              : `${ctx.profile.provider} does not allow operator-policy changes`,
            flag === false ? PROBE_OVERVIEW : presetSource(ctx),
          );
    }
    default:
      return closed(
        'whether the broker allows operator-policy edits is unknown: the overview did not say',
        PROBE_OVERVIEW,
      );
  }
}

/** The four AMQP features follow the handshake of step 12; only its failure class is quoted. */
function amqpHandshake(ctx: Context): GateDecision {
  const amqp = ctx.facts.amqp;
  if (amqp === undefined) {
    return closed('the AMQP handshake did not run', PROBE_AMQP);
  }
  return amqp.ok
    ? open()
    : closed(`the AMQP handshake failed: ${amqp.failure.reason}`, PROBE_AMQP);
}

export const DECISIONS: Readonly<
  Record<string, (ctx: Context) => GateDecision>
> = {
  'streams.browse': streamsBrowse,
  'tap.firehose': tapFirehose,
  'audit.event-exchange': auditEventExchange,
  'policies.operator-edit': operatorEdit,
  'amqp.peek': amqpHandshake,
  'amqp.tap': amqpHandshake,
  'amqp.publish': amqpHandshake,
  'amqp.replay': amqpHandshake,
};

export function contextOf(input: GateInput): Context {
  const { profile, registry } = input;
  let preset: Context['preset'];
  try {
    preset = registry.providerPreset(
      { provider: profile.provider, product: profile.product },
      profile.versions.min,
    );
  } catch (error) {
    if (!(error instanceof SemanticsGapError)) throw error;
  }
  return { ...input, family: isRabbitMqFamily(profile.product), preset };
}
