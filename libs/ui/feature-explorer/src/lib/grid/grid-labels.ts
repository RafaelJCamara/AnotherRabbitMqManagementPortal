// Every word the grid shows, already translated (`explorer.grid.*`). AG Grid reads its locale text
// once, at creation, so a kind's grid gets its labels when it is built.
import type { ExplorerKind } from '@app/explorer-model';
import type { GridLabels } from '@app/ui-grid';

import type { Translate } from '../translate';

export function gridLabels(kind: ExplorerKind, t: Translate): GridLabels {
  return {
    gridLabel: t(`explorer.grid.label.${kind}`),
    loading: t('explorer.grid.loading'),
    noRows: t('explorer.grid.noRows'),
    menu: {
      label: t('explorer.grid.menu.label'),
      whyDisabled: t('explorer.grid.menu.whyDisabled'),
      degraded: t('explorer.grid.menu.degraded'),
      source: t('explorer.grid.menu.source'),
      noReason: t('explorer.grid.menu.noReason'),
    },
    status: {
      total: t('explorer.grid.status.total'),
      totalUnknown: t('explorer.grid.status.totalUnknown'),
      loaded: t('explorer.grid.status.loaded'),
      selected: t('explorer.grid.status.selected'),
      loading: t('explorer.grid.status.loading'),
      error: t('explorer.grid.status.error'),
      retry: t('explorer.grid.status.retry'),
      copied: t('explorer.grid.status.copied'),
      copyTruncated: t('explorer.grid.status.copyTruncated'),
      copyFailed: t('explorer.grid.status.copyFailed'),
      selectionCapped: t('explorer.grid.status.selectionCapped'),
      dropped: t('explorer.grid.status.dropped'),
    },
    columnChooser: {
      button: t('explorer.grid.chooser.button'),
      title: t('explorer.grid.chooser.title'),
      up: t('explorer.grid.chooser.up'),
      down: t('explorer.grid.chooser.down'),
      moveUp: t('explorer.grid.chooser.moveUp'),
      moveDown: t('explorer.grid.chooser.moveDown'),
      width: t('explorer.grid.chooser.width'),
      reset: t('explorer.grid.chooser.reset'),
      lastColumn: t('explorer.grid.chooser.lastColumn'),
    },
  };
}
