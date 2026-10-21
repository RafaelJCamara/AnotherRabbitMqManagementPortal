// The nodes of the cluster as a real table (M0-54, R9, R13): name, running or stopped, being drained or not.
// At most 100 rows (the contract's bound). A field the broker did not send reads "not reported".
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import type { OverviewAnswer } from './overview-model';

@Component({
  selector: 'app-overview-nodes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <table class="nodes">
        <caption>
          {{
            t('explorer.overview.nodes.caption')
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ t('explorer.overview.nodes.name') }}</th>
            <th scope="col">{{ t('explorer.overview.nodes.state') }}</th>
            <th scope="col">{{ t('explorer.overview.nodes.draining') }}</th>
          </tr>
        </thead>
        <tbody>
          @for (node of nodes(); track node.name) {
            <tr>
              <th scope="row">{{ node.name }}</th>
              <td>
                {{
                  t(
                    node.running
                      ? 'explorer.overview.nodes.running'
                      : 'explorer.overview.nodes.stopped'
                  )
                }}
              </td>
              <td>
                {{
                  t(
                    node.beingDrained === undefined
                      ? 'explorer.overview.nodes.notReported'
                      : node.beingDrained
                        ? 'explorer.overview.nodes.drainingYes'
                        : 'explorer.overview.nodes.drainingNo'
                  )
                }}
              </td>
            </tr>
          }
        </tbody>
      </table>
    </ng-container>
  `,
  styles: `
    .nodes {
      border-collapse: collapse;
      min-width: 24rem;
    }
    th,
    td {
      padding: var(--ds-space-1) var(--ds-space-3);
      border-bottom: 1px solid var(--ds-color-border);
      text-align: start;
      font-size: var(--ds-font-size);
    }
    caption {
      text-align: start;
      color: var(--ds-color-text-muted);
      padding-bottom: var(--ds-space-1);
    }
  `,
})
export class OverviewNodes {
  readonly nodes = input.required<OverviewAnswer['nodes']>();
}
