import { describe, expect, it } from 'vitest';

import { byText, squash } from '../testing/dom';
import { FakeConnections, problemOf } from '../testing/fake-connections';
import { profileFixture } from '../testing/fixtures';
import {
  eventually,
  mountRouted,
  PAGE_TEST_TIMEOUT_MS,
} from '../testing/routed-bed';

function rows(el: HTMLElement): HTMLTableRowElement[] {
  return [...el.querySelectorAll<HTMLTableRowElement>('tbody tr')];
}

describe('the connections list', () => {
  it(
    'AC-7 shows one row per connection with its environment chrome, its addresses and a link that opens its explorer',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = [
        profileFixture('p1', { name: 'Orders prod', envClass: 'prod' }),
        profileFixture('s1', { name: 'Staging', envClass: 'staging' }),
        profileFixture('d1', { name: 'Lab', envClass: 'dev' }),
      ];
      const bed = await mountRouted('/connections', { fake });
      await eventually(bed, () => rows(bed.el).length === 3, 'three rows');
      expect(
        rows(bed.el).map((row) =>
          row.querySelector('app-env-chrome')?.getAttribute('data-env'),
        ),
      ).toEqual(['prod', 'staging', 'dev']);
      expect(
        rows(bed.el).map((row) =>
          squash(row.querySelector('app-env-chrome')?.textContent),
        ),
      ).toEqual(['Production', 'Staging', 'Development']);
      const first = rows(bed.el)[0];
      expect(squash(first?.querySelector('th')?.textContent)).toBe(
        'Orders prod',
      );
      expect(squash(first?.textContent)).toContain('http://127.0.0.1:15672');
      expect(squash(first?.textContent)).toContain('127.0.0.1:5672');
      // AC-9: the name leads to the connection, and the explorer is one link away.
      expect(first?.querySelector('th a')?.getAttribute('href')).toBe(
        '/connections/p1',
      );
      expect(
        byText(first as HTMLElement, 'a', 'Open the explorer').getAttribute(
          'href',
        ),
      ).toBe('/c/p1/explorer');
      // The table has a caption and column headers.
      expect(bed.el.querySelector('caption')?.textContent).toContain(
        'The connections you can use',
      );
      expect(bed.el.querySelectorAll('thead th[scope="col"]')).toHaveLength(5);
      // No secret is anywhere in it.
      expect(bed.el.textContent).not.toMatch(/password|secret/i);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-9 with no connection it says so and leads to the create form',
    async () => {
      const bed = await mountRouted('/connections', {
        fake: new FakeConnections(),
      });
      await eventually(
        bed,
        () =>
          squash(bed.el.textContent).includes('There are no connections yet.'),
        'the empty text',
      );
      expect(bed.el.querySelector('table')).toBeNull();
      expect(byText(bed.el, 'a', 'Add a connection').getAttribute('href')).toBe(
        '/connections/new',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-9 reads further windows on request and keeps the ones it has',
    async () => {
      const fake = new FakeConnections();
      fake.profiles = Array.from({ length: 130 }, (_, i) =>
        profileFixture(`c${String(i)}`),
      );
      const bed = await mountRouted('/connections', { fake });
      await eventually(
        bed,
        () => rows(bed.el).length === 100,
        'the first window',
      );
      byText(bed.el, 'button', 'Show more connections').click();
      await eventually(
        bed,
        () => rows(bed.el).length === 130,
        'the second window',
      );
      expect(
        [...bed.el.querySelectorAll('button')].some((b) =>
          b.textContent.includes('Show more'),
        ),
      ).toBe(false);
    },
    PAGE_TEST_TIMEOUT_MS,
  );

  it(
    'AC-9 a failed read says why as the engine sent it and offers another try',
    async () => {
      const fake = new FakeConnections().seed('c1');
      fake.failure.list = problemOf(503, 'INTERNAL', {
        title: 'The engine is busy',
        detail: 'Try again in a moment.',
      });
      const bed = await mountRouted('/connections', { fake });
      await eventually(
        bed,
        () => bed.el.querySelector('[role="alert"]') !== null,
        'the failure',
      );
      expect(
        squash(bed.el.querySelector('[role="alert"]')?.textContent),
      ).toContain('The engine is busy');
      expect(
        squash(bed.el.querySelector('[role="alert"]')?.textContent),
      ).toContain('Try again in a moment.');
      fake.failure = {};
      byText(bed.el, 'button', 'Try again').click();
      await eventually(
        bed,
        () =>
          rows(bed.el).length === 1 &&
          bed.el.querySelector('[role="alert"]') === null,
        'the list after the retry',
      );
    },
    PAGE_TEST_TIMEOUT_MS,
  );
});
