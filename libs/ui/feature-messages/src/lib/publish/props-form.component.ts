// The properties of a message (R4): the text ones, the delivery mode, the priority and the timestamp. A cleared
// field is no property, never an empty one. The fields hold what was typed; the bounds are the draft's to name.
import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
} from '@angular/core';
import type { PublishProps } from '@app/contracts';
import { TranslocoDirective } from '@jsverse/transloco';

import type { DraftIssue } from './draft';
import { controlValue } from './dom';
import { Field } from './field.component';
import { issueText, issuesOf } from './issue-text';
import { PROP_TEXT_FIELDS, type PropTextField } from './limits';
import type { Translate } from '../translate';

type NumberProp = 'priority' | 'timestamp';

const without = (props: PublishProps, name: keyof PublishProps): PublishProps =>
  Object.fromEntries(Object.entries(props).filter(([key]) => key !== name));

const LABELS: Readonly<Record<PropTextField | NumberProp, string>> = {
  contentType: 'publish.props.contentType',
  contentEncoding: 'publish.props.contentEncoding',
  correlationId: 'publish.props.correlationId',
  replyTo: 'publish.props.replyTo',
  expiration: 'publish.props.expiration',
  messageId: 'publish.props.messageId',
  type: 'publish.props.type',
  userId: 'publish.props.userId',
  appId: 'publish.props.appId',
  priority: 'publish.props.priority',
  timestamp: 'publish.props.timestamp',
};

@Component({
  selector: 'app-props-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Field, TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <fieldset>
        <legend>{{ t('publish.props.legend') }}</legend>
        @for (name of textFields; track name) {
          <app-field
            [fieldId]="'prop-' + name"
            [label]="t(label(name))"
            [value]="props()[name] ?? ''"
            [error]="error(t, name)"
            (changed)="setText(name, $event)"
          />
        }
        <div class="field">
          <label for="prop-deliveryMode">{{
            t('publish.props.deliveryMode')
          }}</label>
          <select id="prop-deliveryMode" (change)="setMode($event)">
            <option value="" [selected]="props().deliveryMode === undefined">
              {{ t('publish.props.deliveryModeNone') }}
            </option>
            <option value="1" [selected]="props().deliveryMode === 1">
              {{ t('publish.props.deliveryMode1') }}
            </option>
            <option value="2" [selected]="props().deliveryMode === 2">
              {{ t('publish.props.deliveryMode2') }}
            </option>
          </select>
        </div>
        <app-field
          fieldId="prop-priority"
          type="number"
          [label]="t(label('priority'))"
          [value]="numberText(props().priority)"
          [error]="error(t, 'priority')"
          (changed)="setNumber('priority', $event)"
        />
        <app-field
          fieldId="prop-timestamp"
          type="number"
          [label]="t(label('timestamp'))"
          [value]="numberText(props().timestamp)"
          [error]="error(t, 'timestamp')"
          (changed)="setNumber('timestamp', $event)"
        />
      </fieldset>
    </ng-container>
  `,
  styles: `
    fieldset {
      border: 1px solid var(--ds-color-border);
      border-radius: var(--ds-radius);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--ds-space-1);
      margin-bottom: var(--ds-space-3);
    }
    label {
      font-weight: 600;
    }
    select {
      min-height: var(--ds-target-size);
      font: inherit;
    }
  `,
})
export class PropsForm {
  readonly props = model<PublishProps>({});
  readonly issues = input<readonly DraftIssue[]>([]);

  protected readonly textFields = PROP_TEXT_FIELDS;

  protected label(name: PropTextField | NumberProp): string {
    return LABELS[name];
  }

  protected error(t: Translate, name: PropTextField | NumberProp): string {
    const issue = issuesOf(this.issues(), `props.${name}`)[0];
    return issue === undefined ? '' : issueText(t, issue);
  }

  protected numberText(value: number | undefined): string {
    return value === undefined || Number.isNaN(value) ? '' : String(value);
  }

  protected setText(name: PropTextField, text: string): void {
    this.props.update((props) => ({
      ...without(props, name),
      ...(text === '' ? {} : { [name]: text }),
    }));
  }

  protected setNumber(name: NumberProp, text: string): void {
    this.props.update((props) => ({
      ...without(props, name),
      ...(text === '' ? {} : { [name]: Number(text) }),
    }));
  }

  protected setMode(event: Event): void {
    const mode = controlValue(event);
    this.props.update((props) => ({
      ...without(props, 'deliveryMode'),
      ...(mode === '1' || mode === '2'
        ? { deliveryMode: Number(mode) as 1 | 2 }
        : {}),
    }));
  }
}
