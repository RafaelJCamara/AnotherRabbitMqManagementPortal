// The words the shared components of the design library take as inputs, built from the feature's own keys (R12). The
// design library has no copy and no Transloco; the page hands the words in.
import type { GatedLabels } from '@app/ui-design';

import type { Translate } from './translate';

export function gatedLabels(t: Translate): GatedLabels {
  return {
    whyDisabled: t('publish.gate.whyDisabled'),
    degraded: t('publish.gate.degraded'),
    source: t('publish.gate.source'),
    noReason: t('publish.gate.noReason'),
  };
}
