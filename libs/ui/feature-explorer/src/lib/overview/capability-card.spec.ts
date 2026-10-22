import { eventually } from '@app/ui-grid/testing/components';
import { describe, expect, it } from 'vitest';

import { PAGE_TEST_TIMEOUT_MS } from '../testing/dom';
import {
  brokerProfileBody,
  FakeWorkspace,
  problemOf,
} from '../testing/fake-workspace';
import { mountPage } from '../testing/page-testbed';
import { ProfileStore } from '../profile/profile-store';
import { CapabilityCard } from './capability-card.component';

const GATES = {
  'streams.browse': { enabled: true },
  'tap.firehose': {
    enabled: true,
    mode: 'degraded',
    reason: 'Needs the tracing plugin',
    source: 'SEM-1',
  },
  'audit.event-exchange': {
    enabled: false,
    reason: 'The plugin is not enabled',
    source: 'https://docs.example.com/audit',
  },
  'policies.operator-edit': {
    enabled: false,
    reason: 'Blocked by the broker',
    source: 'http://insecure.example.com/page',
  },
  'amqp.peek': { enabled: 'true' }, // a string is not true
  'amqp.tap': {}, // no `enabled` at all
  'amqp.publish': {
    enabled: false,
    source: 'https://user:secret@example.com/x', // credentials in a URL: never a link
  },
  'amqp.replay': 'yes', // not even an object
  'future.feature': { enabled: true }, // a feature this build has no name for
};

async function card(
  profile: ((cid: string) => unknown) | null,
  failure?: ReturnType<typeof problemOf>,
) {
  const workspace = new FakeWorkspace();
  workspace.profile = profile;
  if (failure) workspace.failure.profile = failure;
  const bed = await mountPage(CapabilityCard, {
    workspace,
    providers: [ProfileStore],
  });
  await eventually(() => {
    bed.fixture.detectChanges();
    expect(
      bed.el.querySelector('table.gates, .unknown:not([role="status"])'),
    ).not.toBeNull();
  });
  return bed;
}

const rows = (el: HTMLElement): Record<string, HTMLElement> =>
  Object.fromEntries(
    [...el.querySelectorAll<HTMLElement>('tbody tr')].map((tr) => [
      tr.querySelector('th')?.textContent.trim() ?? '',
      tr,
    ]),
  );

/** The text of a row as its cells read one after the other (a table cell is a unit, not a word of the next). */
const words = (tr: HTMLElement | undefined): string =>
  [...(tr?.children ?? [])]
    .map((cell) => cell.textContent.replace(/\s+/g, ' ').trim())
    .filter((cell) => cell !== '')
    .join(' ');

const unknownText = (el: HTMLElement): string =>
  (el.querySelector('.unknown')?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('<app-capability-card>', () => {
  it(
    'M0-54 AC-22 the capability card renders the gates as sent and fails closed',
    async () => {
      const bed = await card((cid) => brokerProfileBody(cid, { gates: GATES }));
      const byName = rows(bed.el);
      // One row per gate, in id order; the eight known ids have names, an unknown one shows as its id.
      expect(Object.keys(byName)).toEqual([
        'Side-effect-aware peek',
        'Publish messages',
        'Replay messages',
        'Tap messages',
        'Audit through the event exchange',
        'future.feature',
        'Operator policy edits',
        'Browse streams',
        'Firehose tap',
      ]);
      // An open gate reads available, with nothing to explain.
      expect(words(byName['Browse streams'])).toBe('Browse streams Available');
      expect(words(byName['future.feature'])).toBe('future.feature Available');
      // A degraded gate reads "available with limits", with its reason and source as sent.
      expect(words(byName['Firehose tap'])).toBe(
        'Firehose tap Available with limits Needs the tracing plugin Source SEM-1',
      );
      // A closed gate reads "not available" with its reason; an https source without credentials is a link.
      const audit = byName['Audit through the event exchange'];
      const link = audit?.querySelector('a');
      expect(words(audit)).toContain('Not available');
      expect(words(audit)).toContain('The plugin is not enabled');
      expect(link?.getAttribute('href')).toBe('https://docs.example.com/audit');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.textContent.trim()).toBe('Source docs.example.com');
      // Any other source is text, never a link: http, and a URL with credentials.
      const insecure = byName['Operator policy edits'];
      expect(insecure?.querySelector('a')).toBeNull();
      expect(words(insecure)).toContain(
        'Source http://insecure.example.com/page',
      );
      const credentials = byName['Publish messages'];
      expect(credentials?.querySelector('a')).toBeNull();
      expect(words(credentials)).toContain('Not available');
      expect(words(credentials)).toContain('No reason given');
      // A gate whose `enabled` is not exactly true is closed: a string, a missing field, a non-object.
      expect(words(byName['Side-effect-aware peek'])).toContain(
        'Not available',
      );
      expect(words(byName['Tap messages'])).toContain('Not available');
      expect(words(byName['Replay messages'])).toContain('Not available');
      expect(bed.el.querySelectorAll('a')).toHaveLength(1);
      expect(bed.el.textContent).not.toContain(
        'Available with limits Available',
      );

      // A profile that is not an object, a failed call and an unprobed connection are unknown, never available.
      const unknown = 'The capabilities of this connection are not known.';
      const garbled = await card(() => 'nope');
      expect(unknownText(garbled.el)).toBe(unknown);
      expect(garbled.el.querySelector('table')).toBeNull();
      const failed = await card(
        (cid) => brokerProfileBody(cid, { gates: GATES }),
        problemOf(500, 'INTERNAL', { title: 'Profile failed' }),
      );
      expect(unknownText(failed.el)).toBe(unknown);
      expect(failed.el.textContent).not.toContain('Available');
      const unprobed = await card(null);
      expect(unknownText(unprobed.el)).toBe(unknown);
      // No gates at all is not "everything is open".
      const none = await card((cid) => ({
        ...brokerProfileBody(cid),
        gates: {},
      }));
      expect(unknownText(none.el)).toBe(unknown);
      const wrong = await card((cid) => ({
        ...brokerProfileBody(cid),
        gates: [],
      }));
      expect(unknownText(wrong.el)).toBe(unknown);
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
