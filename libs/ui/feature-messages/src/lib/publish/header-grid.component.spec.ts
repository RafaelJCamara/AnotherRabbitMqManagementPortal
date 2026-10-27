import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  fakeHost,
  provideFakeLoader,
  type FakeHost,
} from '@app/ui-editor/testing';
import { provideTransloco } from '@jsverse/transloco';
import { describe, expect, it, vi } from 'vitest';

import { provideMessagesScope } from '../messages-scope';
import { HeaderGrid } from './header-grid.component';
import { leakedKeys, squash } from './spec-support';
import { newRow, rowsToHeaders, type HeaderRow } from './header-model';

interface Bed {
  readonly fixture: ComponentFixture<HeaderGrid>;
  readonly host: FakeHost;
  readonly el: HTMLElement;
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let round = 0; round < 4; round++) {
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();
  }
}

async function mount(
  rows: readonly HeaderRow[] = [],
  mode: 'grid' | 'json' = 'grid',
): Promise<Bed> {
  const host = fakeHost();
  TestBed.resetTestingModule(); // a spec may mount several grids: each starts from a clean module
  TestBed.configureTestingModule({
    providers: [
      provideTransloco({
        config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
      }),
      provideMessagesScope(),
      provideFakeLoader(host),
    ],
  });
  const fixture = TestBed.createComponent(HeaderGrid);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('mode', mode);
  await settle(fixture);
  await vi.waitFor(
    () => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('fieldset'),
      ).not.toBeNull();
    },
    { timeout: 10_000 },
  );
  await settle(fixture);
  return { fixture, host, el: fixture.nativeElement as HTMLElement };
}

const rowEl = (bed: Bed, id: string): HTMLElement => {
  const found = bed.el.querySelector<HTMLElement>(`tr[data-row="${id}"]`);
  if (found === null) throw new Error(`no row ${id}`);
  return found;
};

function typeInto(input: Element | undefined | null, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(select: Element | null, value: string): void {
  if (!(select instanceof HTMLSelectElement)) throw new Error('no select');
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

const click = (el: Element | null): void => {
  if (!(el instanceof HTMLElement)) throw new Error('nothing to click');
  el.click();
};

const rowSummary = (rows: readonly HeaderRow[]): [string, string, string][] =>
  rows.map((row) => [row.name, row.type, row.text]);

describe('<app-header-grid>', () => {
  it('M1-46 AC-23 the header grid keeps AMQP types and round-trips through JSON', async () => {
    const bed = await mount();
    const { fixture } = bed;
    const rows = () => fixture.componentInstance.rows();

    // Rows are added, typed, retyped and removed through the controls.
    const typed: [string, string, string][] = [
      ['attempt', 'long', '3'],
      ['ratio', 'double', '1.5'],
      ['urgent', 'bool', 'true'],
      ['sent', 'timestamp', '1700000000'],
      ['blob', 'bytes', 'aGk='],
      ['nested', 'table', '[{"name":"k","value":{"t":"int","v":7}}]'],
    ];
    for (const [name, type, text] of typed) {
      click(bed.el.querySelector('button.add'));
      await settle(fixture);
      const id = rows().at(-1)?.id ?? '';
      const row = rowEl(bed, id);
      const [nameInput, valueInput] = row.querySelectorAll('input');
      typeInto(nameInput, name);
      choose(row.querySelector('select'), type);
      typeInto(valueInput, text);
      await settle(fixture);
    }
    click(bed.el.querySelector('button.add'));
    await settle(fixture);
    click(bed.el.querySelector('tr:last-child button.remove'));
    await settle(fixture);
    expect(rowSummary(rows())).toEqual(typed);

    // To JSON: the typed table, with every type kept.
    click(bed.el.querySelector('button.mode-json'));
    await settle(fixture);
    expect(fixture.componentInstance.mode()).toBe('json');
    expect(bed.host.editors).toHaveLength(1);
    expect(JSON.parse(bed.host.editors[0]?.value ?? '')).toEqual({
      attempt: { t: 'long', v: 3 },
      ratio: { t: 'double', v: 1.5 },
      urgent: { t: 'bool', v: true },
      sent: { t: 'timestamp', v: 1700000000 },
      blob: { t: 'bytes', v: 'aGk=' },
      nested: { t: 'table', v: [{ name: 'k', value: { t: 'int', v: 7 } }] },
    });

    // An edit in the JSON that is a typed table reaches the rows at once; back to the table keeps the types.
    bed.host.editors[0]?.type(
      '{"count":{"t":"short","v":2},"flag":{"t":"bool","v":false}}',
    );
    await settle(fixture);
    click(bed.el.querySelector('button.mode-grid'));
    await settle(fixture);
    expect(fixture.componentInstance.mode()).toBe('grid');
    expect(rowSummary(rows())).toEqual([
      ['count', 'short', '2'],
      ['flag', 'bool', 'false'],
    ]);
    expect(bed.host.editors[0]?.disposed).toBe(1);
    expect(bed.el.querySelector('[role="alert"]')).toBeNull();

    // Invalid JSON blocks the switch back with a message, and keeps the grid's rows.
    click(bed.el.querySelector('button.mode-json'));
    await settle(fixture);
    bed.host.editors[1]?.type('{"count": ');
    await settle(fixture);
    expect(fixture.componentInstance.jsonError()).toBe('json');
    click(bed.el.querySelector('button.mode-grid'));
    await settle(fixture);
    expect(fixture.componentInstance.mode()).toBe('json');
    expect(bed.el.querySelector('[role="alert"]')?.textContent).toContain(
      'not valid',
    );
    expect(rowSummary(rows())).toEqual([
      ['count', 'short', '2'],
      ['flag', 'bool', 'false'],
    ]);
    // A JSON that parses but is not a typed table says so in other words; fixing it clears the error.
    bed.host.editors[1]?.type('{"count": 5}');
    await settle(fixture);
    expect(fixture.componentInstance.jsonError()).toBe('shape');
    click(bed.el.querySelector('button.mode-grid'));
    await settle(fixture);
    expect(bed.el.querySelector('[role="alert"]')?.textContent).toContain(
      'typed headers',
    );
    bed.host.editors[1]?.type('{"count":{"t":"int","v":5}}');
    await settle(fixture);
    expect(fixture.componentInstance.jsonError()).toBeNull();
    click(bed.el.querySelector('button.mode-grid'));
    await settle(fixture);
    expect(fixture.componentInstance.mode()).toBe('grid');
    expect(bed.el.querySelector('[role="alert"]')).toBeNull();
    expect(rowSummary(rows())).toEqual([['count', 'int', '5']]);
  });

  it('flags a duplicate name and a value that does not fit, and holds back the JSON view', async () => {
    const rows = [
      newRow('a', 'string', '1'),
      newRow('a', 'long', 'x'),
      newRow('', 'string', ''),
    ];
    const bed = await mount(rows);
    const second = rowEl(bed, rows[1]?.id ?? '');
    expect(second.querySelector('.error')?.textContent).toContain('same name');
    expect(second.querySelector('.error')?.textContent).toContain(
      'does not fit its type',
    );
    expect(second.querySelector('input')?.getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(rowEl(bed, rows[0]?.id ?? '').querySelector('.error')).toBeNull();
    expect(
      rowEl(bed, rows[2]?.id ?? '').querySelector('.error')?.textContent,
    ).toContain('needs a name');

    click(bed.el.querySelector('button.mode-json'));
    await settle(bed.fixture);
    expect(bed.fixture.componentInstance.mode()).toBe('grid');
    expect(bed.el.querySelector('[role="alert"]')?.textContent).toContain(
      'Fix the marked row',
    );
    expect(bed.host.editors).toHaveLength(0);

    // Fixing the rows lifts the marks and lets the switch through.
    typeInto(rowEl(bed, rows[0]?.id ?? '').querySelector('input'), 'z');
    typeInto(rowEl(bed, rows[1]?.id ?? '').querySelectorAll('input')[1], '4');
    click(rowEl(bed, rows[2]?.id ?? '').querySelector('button.remove'));
    await settle(bed.fixture);
    expect(bed.el.querySelector('.error')).toBeNull();
    expect(rowsToHeaders(bed.fixture.componentInstance.rows()).ok).toBe(true);
    click(bed.el.querySelector('button.mode-json'));
    await settle(bed.fixture);
    expect(bed.fixture.componentInstance.mode()).toBe('json');
    expect(bed.el.querySelector('[role="alert"]')).toBeNull();
  });

  it('puts every word of the grid through a translation', async () => {
    const empty = await mount();
    expect(squash(empty.el.textContent)).toContain('Headers Table JSON');
    expect(squash(empty.el.textContent)).toContain('No headers.');
    expect(squash(empty.el.textContent)).toContain('Add a header');
    expect(squash(empty.el.textContent)).toContain(
      'Decimal, list and table values are typed as JSON. Bytes are base64.',
    );
    expect(empty.el.querySelector('legend')?.textContent).toBe('Headers');
    expect(
      empty.el.querySelector('[role="group"]')?.getAttribute('aria-label'),
    ).toBe('How to edit the headers');
    const pressed = (bed: Bed, mode: string): string | null | undefined =>
      bed.el.querySelector(`button.mode-${mode}`)?.getAttribute('aria-pressed');
    expect(pressed(empty, 'grid')).toBe('true');
    expect(pressed(empty, 'json')).toBe('false');
    expect(leakedKeys(empty.el)).toEqual([]);

    const rows = [newRow('a', 'string', 'x'), newRow('a', 'long', 'x')];
    const bed = await mount(rows);
    expect(
      [...bed.el.querySelectorAll('th')].map((th) => th.textContent),
    ).toEqual(['Name', 'Type', 'Value']);
    const labels = [...bed.el.querySelectorAll('input, select')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Name of header 1',
      'Type of header 1',
      'Value of header 1',
      'Name of header 2',
      'Type of header 2',
      'Value of header 2',
    ]);
    expect(
      [...bed.el.querySelectorAll('button.remove')].map((b) =>
        squash(b.textContent),
      ),
    ).toEqual(['Remove header 1', 'Remove header 2']);
    expect(
      [
        ...(bed.el.querySelector('select')?.querySelectorAll('option') ?? []),
      ].map((option) => squash(option.textContent)),
    ).toEqual([
      'string',
      'byte',
      'short',
      'int',
      'long',
      'float',
      'double',
      'bool',
      'timestamp',
      'decimal',
      'bytes',
      'void',
      'list',
      'table',
    ]);
    expect(
      bed.el.querySelector('tr[data-row] input')?.getAttribute('spellcheck'),
    ).toBe('false');
    expect(leakedKeys(bed.el)).toEqual([]);

    click(bed.el.querySelector('button.mode-json'));
    await settle(bed.fixture);
    const bad = await mount([newRow('a', 'int', '1')]);
    click(bad.el.querySelector('button.mode-json'));
    await settle(bad.fixture);
    expect(pressed(bad, 'grid')).toBe('false');
    expect(pressed(bad, 'json')).toBe('true');
    expect(bad.host.editors[0]?.options.ariaLabel).toBe(
      'Headers as typed JSON',
    );
    expect(squash(bad.el.textContent)).toContain(
      'Each header is written as {"t": its type, "v": its value}.',
    );
    expect(leakedKeys(bad.el)).toEqual([]);
    bad.host.editors[0]?.type('nope');
    click(bad.el.querySelector('button.mode-grid'));
    await settle(bad.fixture);
    expect(leakedKeys(bad.el)).toEqual([]);
  });

  it('ties the mark of a row to its message, and keeps the switch message to the switch that was tried', async () => {
    const rows = [newRow('a', 'string', 'x'), newRow('a', 'long', 'x')];
    const bed = await mount(rows);
    const [first, second] = rows.map((row) => rowEl(bed, row.id));
    const inputs = (row: HTMLElement | undefined) => [
      ...(row?.querySelectorAll('input') ?? []),
    ];
    expect(inputs(first).map((el) => el.getAttribute('aria-invalid'))).toEqual([
      null,
      null,
    ]);
    expect(inputs(second).map((el) => el.getAttribute('aria-invalid'))).toEqual(
      ['true', 'true'],
    );
    expect(
      inputs(first)
        .concat(inputs(second))
        .map((el) => el.getAttribute('spellcheck')),
    ).toEqual(['false', 'false', 'false', 'false']);
    const message = second?.querySelector('.error');
    expect(message?.id).toBe(`hdr-err-${rows[1]?.id ?? ''}`);
    expect(inputs(second)[0]?.getAttribute('aria-describedby')).toBe(
      message?.id,
    );
    expect(
      first?.querySelector('input')?.getAttribute('aria-describedby'),
    ).toBeNull();
    expect(
      [...bed.el.querySelectorAll('tr[data-row] select')].map(
        (el) => (el as HTMLSelectElement).value,
      ),
    ).toEqual(['string', 'long']);

    // Only a switch that was tried leaves a message: breaking a row, or the JSON, says nothing until then.
    const ok = await mount([newRow('a', 'int', '1')]);
    click(ok.el.querySelector('button.mode-json'));
    await settle(ok.fixture);
    ok.host.editors[0]?.type('{"a": ');
    await settle(ok.fixture);
    expect(ok.fixture.componentInstance.jsonError()).toBe('json');
    expect(ok.host.editors[0]?.value).toBe('{"a": '); // the text is the editor's, not rewritten
    expect(ok.el.querySelector('[role="alert"]')).toBeNull();
    // The JSON button of the view we are in changes nothing: the wrong text stays wrong.
    click(ok.el.querySelector('button.mode-json'));
    await settle(ok.fixture);
    expect(ok.fixture.componentInstance.jsonError()).toBe('json');
    ok.host.editors[0]?.type('{"a":{"t":"int","v":1}}');
    await settle(ok.fixture);
    click(ok.el.querySelector('button.mode-grid'));
    await settle(ok.fixture);
    expect(ok.fixture.componentInstance.mode()).toBe('grid');
    const id = ok.fixture.componentInstance.rows()[0]?.id ?? '';
    typeInto(rowEl(ok, id).querySelector('input'), '');
    await settle(ok.fixture);
    expect(ok.el.querySelector('[role="alert"]')).toBeNull(); // no switch was tried since
    click(ok.el.querySelector('button.mode-grid')); // already here: nothing happens
    await settle(ok.fixture);
    expect(ok.fixture.componentInstance.mode()).toBe('grid');
  });

  it('says when there are too many headers, and disables the value of a void one', async () => {
    const many = Array.from({ length: 65 }, (_, i) => newRow(`h${String(i)}`));
    const bed = await mount(many);
    expect(bed.el.querySelector('table + .error')?.textContent).toContain(
      'At most 64',
    );
    const one = await mount([newRow('v', 'void', '')]);
    expect(one.el.querySelectorAll('input')[1]?.disabled).toBe(true);
    const typedRow = await mount([newRow('v', 'long', '1')]);
    expect(typedRow.el.querySelectorAll('input')[1]?.disabled).toBe(false);
  });

  it('shows the JSON view of a draft that was left in it, without the text that was wrong', async () => {
    const bed = await mount([newRow('a', 'int', '1')], 'json');
    expect(JSON.parse(bed.host.editors[0]?.value ?? '')).toEqual({
      a: { t: 'int', v: 1 },
    });
    const stale = TestBed.createComponent(HeaderGrid);
    stale.componentRef.setInput('mode', 'json');
    stale.componentRef.setInput('jsonError', 'json');
    await settle(stale);
    expect(stale.componentInstance.jsonError()).toBeNull();
  });
});
