// The commands of a shell with a connection in view (M1-41, R14): open each explorer page as a tab, and go to the
// page where the capabilities of this connection are checked. They exist while the shell lives, and are listed only
// while a connection is shown (`connection.active`). They act through the services the tree and the tab strip use, so
// a refusal (too many tabs) is the shell's own notice, and nothing here sends anything to the engine.
import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { CommandContext, registerCommands, scopedText } from '@app/ui-commands';

import { SCOPE_LOADERS, scopeDefinition } from '../i18n/i18n.config';
import { ActiveConnection } from '../shell/active-connection';
import { EXPLORER_KIND_NODES } from '../shell/explorer-tree/explorer-kinds-source';
import { WorkspaceTabs } from '../shell/tabs/workspace-tabs';
import { commandsScope } from './commands-scope';

export function registerShellCommands(): void {
  const connection = inject(ActiveConnection);
  const tabs = inject(WorkspaceTabs);
  const router = inject(Router);
  const commands = commandsScope();
  const shell = scopeDefinition(inject(SCOPE_LOADERS), 'shell');
  inject(CommandContext).bind(
    'connection.active',
    computed(() => connection.cid() !== null),
  );
  const active = (get: (key: string) => unknown): boolean =>
    get('connection.active') === true;

  registerCommands([
    ...EXPLORER_KIND_NODES.map((kind, index) => {
      const label = scopedText(shell, `tree.kind.${kind}`);
      return {
        id: `go.explorer.${kind}`,
        title: scopedText(commands, `go.${kind}`),
        category: scopedText(commands, 'category.navigate'),
        when: active,
        menu: { menu: 'go' as const, order: index, group: 'explorer' },
        run: (): void => {
          const cid = connection.cid();
          if (cid === null) return;
          tabs.open({
            url:
              kind === 'overview'
                ? `/c/${cid}/explorer`
                : `/c/${cid}/explorer/${kind}`,
            label: label(),
          });
        },
      };
    }),
    {
      id: 'connection.check-capabilities',
      title: scopedText(commands, 'connection.check'),
      category: scopedText(commands, 'category.connection'),
      when: active,
      menu: { menu: 'go' as const, order: 10, group: 'connection' },
      run: async (): Promise<void> => {
        const cid = connection.cid();
        if (cid !== null) await router.navigateByUrl(`/connections/${cid}`);
      },
    },
  ]);
}
