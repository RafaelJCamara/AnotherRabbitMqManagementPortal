import {
  eventually,
  restoreGridSpecEnvironment,
  warmUpGrid,
  WARM_UP_TIMEOUT_MS,
} from '@app/ui-grid/testing/components';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import en from '../../i18n/en.json';
import { brokerProfileBody, FakeWorkspace } from '../testing/fake-workspace';
import {
  fieldPairs,
  mountEntity,
  must,
  PAGE_TEST_TIMEOUT_MS,
  queueRow,
  tabIds,
} from '../testing/entity-bed';

const STREAM = queueRow('events', { type: 'stream', state: 'running' });
const QUEUE = queueRow('orders.q', { type: 'quorum', state: 'running' });

const REASON = 'Streams are not enabled on this broker.';
const SOURCE = 'https://www.rabbitmq.com/docs/streams';

/** A workspace whose profile carries the gates the tabs ask about. */
function gated(): FakeWorkspace {
  const workspace = new FakeWorkspace();
  workspace.profile = (cid) =>
    brokerProfileBody(cid, {
      gates: {
        'streams.browse': { enabled: false, reason: REASON, source: SOURCE },
        'amqp.peek': { enabled: true },
        'amqp.publish': { enabled: false },
        'amqp.tap': { enabled: true, mode: 'degraded', reason: 'Sampled.' },
      },
    });
  return workspace;
}

const reasonOf = (el: Element, id: string): string => {
  const tab = must(el, `[role="tab"][data-tab="${id}"]`);
  const described = tab.getAttribute('aria-describedby');
  return described === null
    ? ''
    : (el.querySelector(`#${described}`)?.textContent.trim() ?? '');
};

async function strip(
  el: HTMLElement,
  fixture: { detectChanges(): void },
): Promise<void> {
  await eventually(() => {
    fixture.detectChanges();
    expect(el.querySelector('[role="tablist"]')).not.toBeNull();
  }, 8000);
}

describe('the tabs of an entity page', () => {
  beforeAll(warmUpGrid, WARM_UP_TIMEOUT_MS);
  afterAll(restoreGridSpecEnvironment);

  it(
    'AC-11 a stream page has Browse not Messages and a gated tab says why it is disabled',
    async () => {
      // A stream: Browse replaces Messages; the gate the engine closed is explained as it was sent.
      const bed = await mountEntity({ rows: [STREAM], workspace: gated() });
      await strip(bed.el, bed.fixture);
      expect(tabIds(bed.el)).toEqual([
        'overview',
        'browse',
        'consumers',
        'routing',
        'config',
      ]);
      expect(bed.el.querySelector('.kind')?.textContent.trim()).toBe(
        en.entity.kind.stream,
      );
      const browse = must(bed.el, '[data-tab="browse"]');
      expect(browse.getAttribute('aria-disabled')).toBe('true');
      expect(reasonOf(bed.el, 'browse')).toBe(
        `${en.entity.tabReason.gate.replace('{{reason}}', REASON)} ${en.entity.tabReason.source.replace('{{source}}', SOURCE)}`,
      );
      // The tabs that are built can be chosen: they are not disabled.
      for (const id of ['overview', 'consumers', 'routing', 'config']) {
        expect(
          must(bed.el, `[data-tab="${id}"]`).getAttribute('aria-disabled'),
          id,
        ).toBeNull();
      }
      // The overview is selected, the strip has one tab stop, and the panel is that tab's.
      expect(
        must(bed.el, '[data-tab="overview"]').getAttribute('aria-selected'),
      ).toBe('true');
      expect(
        [...bed.el.querySelectorAll<HTMLElement>('[role="tab"]')].filter(
          (tab) => tab.tabIndex === 0,
        ),
      ).toHaveLength(1);
      expect(
        must(bed.el, '[role="tabpanel"]').getAttribute('aria-labelledby'),
      ).toBe('entity-tab-overview');

      // Arrow keys, Home and End move between the tabs, the disabled ones included.
      const key = (target: Element, name: string): void => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: name,
            bubbles: true,
            cancelable: true,
          }),
        );
      };
      const focused = (): HTMLElement => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) throw new Error('no focus');
        return active;
      };
      const focusedTab = (): string | undefined => focused().dataset.tab;
      const overview = must(bed.el, '[data-tab="overview"]');
      overview.focus();
      key(overview, 'ArrowRight');
      expect(document.activeElement).toBe(browse);
      key(browse, 'End');
      expect(focusedTab()).toBe('config');
      key(focused(), 'ArrowRight');
      expect(focusedTab()).toBe('overview');
      key(focused(), 'ArrowLeft');
      expect(focusedTab()).toBe('config');
      key(focused(), 'Home');
      expect(focusedTab()).toBe('overview');

      // Choosing a tab that can be used says so (the route then navigates); a disabled one says nothing.
      const chosen: string[] = [];
      bed.fixture.componentInstance.tabChange.subscribe((id) => {
        chosen.push(id);
      });
      browse.click();
      expect(chosen).toEqual([]);
      must(bed.el, '[data-tab="routing"]').click();
      expect(chosen).toEqual(['routing']);

      // A queue: Messages needs a gate the engine opened, but is not built yet, and says that.
      const queue = await mountEntity({ rows: [QUEUE], workspace: gated() });
      await strip(queue.el, queue.fixture);
      expect(tabIds(queue.el)).toEqual([
        'overview',
        'messages',
        'publish',
        'tap',
        'consumers',
        'routing',
        'config',
        'charts',
        'forecast',
        'lint',
      ]);
      expect(tabIds(queue.el)).not.toContain('browse');
      expect(reasonOf(queue.el, 'messages')).toBe(en.entity.tabReason.later);
      expect(reasonOf(queue.el, 'tap')).toBe(en.entity.tabReason.later); // degraded is open, with limits
      // A gate the engine closed without a reason says so, never an invented one.
      expect(reasonOf(queue.el, 'publish')).toBe(
        en.entity.tabReason.gateNoReason,
      );
      expect(reasonOf(queue.el, 'charts')).toBe(en.entity.tabReason.later);

      // An engine that sent no usable gates closes every gated tab, and says the capabilities are unknown.
      const unknown = await mountEntity({ rows: [QUEUE] });
      await strip(unknown.el, unknown.fixture);
      expect(reasonOf(unknown.el, 'messages')).toBe(
        en.entity.tabReason.unknownGate,
      );
      expect(reasonOf(unknown.el, 'charts')).toBe(en.entity.tabReason.later);

      // A deep link to a gated tab shows the reason in the panel.
      const deep = await mountEntity({
        rows: [STREAM],
        workspace: gated(),
        tab: 'browse',
      });
      await strip(deep.el, deep.fixture);
      const panel = must(deep.el, '[role="tabpanel"]');
      expect(panel.getAttribute('aria-labelledby')).toBe('entity-tab-browse');
      expect(panel.textContent).toContain(REASON);
      expect(panel.textContent).toContain(SOURCE);
      expect(deep.el.querySelector('dl.fields')).toBeNull();

      // A tab the entity does not have (Messages on a stream) shows the overview and says so.
      const missing = await mountEntity({
        rows: [STREAM],
        workspace: gated(),
        tab: 'messages',
      });
      await strip(missing.el, missing.fixture);
      expect(missing.el.textContent).toContain(
        en.entity.unknownTab
          .replace('{{noun}}', en.entity.noun.stream)
          .replace('{{tab}}', 'messages'),
      );
      expect(fieldPairs(missing.el).length).toBeGreaterThan(0);
      expect(
        must(missing.el, '[data-tab="overview"]').getAttribute('aria-selected'),
      ).toBe('true');

      // Nothing on the page reaches a message: the only requests are the profile and the inventory reads.
      for (const bedOf of [bed, queue, unknown, deep, missing]) {
        expect(bedOf.workspace.requestLines).toEqual([
          'GET /api/v1/connections/c1/profile',
        ]);
        for (const query of bedOf.fake.queries) {
          expect(query.window.limit).toBe(1);
        }
      }
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
