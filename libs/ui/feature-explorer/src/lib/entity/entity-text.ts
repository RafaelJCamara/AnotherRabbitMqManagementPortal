// Copy as text (M1-42, R8): the fields an entity page shows, one `label: value` line each, with the words the
// page uses, and the address last. It holds what is on the page and nothing else; the inventory carries no
// secret, so nothing is masked.
import type { ExplorerKind, InventoryRow } from '@app/explorer-model';

import type { Translate } from '../translate';
import { fieldLabel, fieldsOf, formatField } from './entity-fields';

export function entityText(
  kind: ExplorerKind,
  row: InventoryRow,
  address: string,
  t: Translate,
): string {
  const fields = [
    ...fieldsOf(kind, 'overview', row),
    ...fieldsOf(kind, 'config', row),
  ];
  const lines = fields.map(
    ({ id, value }) => `${fieldLabel(id, t)}: ${formatField(id, value, t)}`,
  );
  lines.push(`${t('explorer.entity.address')}: ${address}`);
  return lines.join('\n');
}
