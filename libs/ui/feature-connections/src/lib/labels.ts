// The words the shared components of the design library take as inputs, built from the feature's own keys
// (M0-52, R8, R11). The design library has no copy and no Transloco; the page hands the words in.
import type { EnvClass } from '@app/contracts';
import type { EnvLabels, GatedLabels } from '@app/ui-design';

import type { Translate } from './translate';

const ENV_CLASSES: readonly EnvClass[] = [
  'prod',
  'staging',
  'test',
  'dev',
  'local',
];

export function envLabels(t: Translate): EnvLabels {
  return Object.fromEntries(
    ENV_CLASSES.map((env) => [env, t(`connections.env.${env}`)]),
  ) as EnvLabels;
}

export function gatedLabels(t: Translate): GatedLabels {
  return {
    whyDisabled: t('connections.gate.whyDisabled'),
    degraded: t('connections.gate.degraded'),
    source: t('connections.gate.source'),
    noReason: t('connections.gate.noReason'),
  };
}
