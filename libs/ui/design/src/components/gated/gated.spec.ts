import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { GateDecision } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { Gated, type GatedLabels } from './gated';
import { parseSourceLink } from './source-link';

const LABELS: GatedLabels = {
  whyDisabled: 'Why disabled',
  degraded: 'Limited',
  source: 'Source',
  noReason: 'No reason given',
};

@Component({
  imports: [Gated],
  template: `
    <app-gated
      [gate]="gate()"
      [labels]="labels"
      (activated)="activations.set(activations() + 1)"
    >
      <span class="inner">{{ text }}</span>
    </app-gated>
  `,
})
class Host {
  readonly gate = signal<GateDecision | null | undefined>(undefined);
  readonly labels = LABELS;
  readonly text = 'Purge';
  readonly activations = signal(0);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

/** What a consumer's `(click)` on `<app-gated>` or on a wrapper would see. */
interface Clicks {
  host: number;
  ancestor: number;
}

async function mount(gate: GateDecision | null | undefined) {
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  fixture.componentInstance.gate.set(gate);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const clicks: Clicks = { host: 0, ancestor: 0 };
  must(el.querySelector('app-gated'), 'app-gated').addEventListener(
    'click',
    () => (clicks.host += 1),
  );
  el.addEventListener('click', () => (clicks.ancestor += 1));
  return {
    fixture,
    host: fixture.componentInstance,
    clicks,
    button: must(
      el.querySelector<HTMLButtonElement>('button.control'),
      'button',
    ),
    reason: must(el.querySelector<HTMLElement>('.reason'), 'reason'),
    link: () => el.querySelector<HTMLAnchorElement>('a'),
    el,
    async set(gate: GateDecision | null | undefined) {
      fixture.componentInstance.gate.set(gate);
      await fixture.whenStable();
    },
  };
}

const text = (el: Element | null): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Not hidden from sight or from assistive technology. */
function isExposed(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (
      node.hidden ||
      node.hasAttribute('inert') ||
      node.getAttribute('aria-hidden') === 'true' ||
      node.style.display === 'none' ||
      node.style.visibility === 'hidden'
    ) {
      return false;
    }
  }
  return true;
}

/** What a browser would put in the tab sequence: focusable, not disabled, not hidden, not inert. */
function isTabbable(el: HTMLElement): boolean {
  return el.tabIndex >= 0 && !el.hasAttribute('disabled') && isExposed(el);
}

/** Text a screen reader reads for the elements an `aria-describedby` names. */
const description = (el: HTMLElement): string =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .map((id) => text(el.ownerDocument.getElementById(id)))
    .join(' ')
    .trim();

describe('<app-gated> disabled', () => {
  const gate: GateDecision = {
    enabled: false,
    reason: 'Purge is locked on prod until armed',
    source: 'https://docs.example.com/guardrails#prod-lock',
  };

  it('AC-2 the reason and the source link are keyboard-reachable and announced', async () => {
    const m = await mount(gate);

    // Reachable: the control stays focusable (aria-disabled, not `disabled`), and the link
    // follows it in the tab sequence.
    expect(m.button.hasAttribute('disabled')).toBe(false);
    expect(m.button.getAttribute('aria-disabled')).toBe('true');
    expect(isTabbable(m.button)).toBe(true);
    const link = must(m.link(), 'link');
    expect(isTabbable(link)).toBe(true);
    expect(
      m.button.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    document.body.append(m.el);
    m.button.focus();
    expect(document.activeElement).toBe(m.button);
    link.focus();
    expect(document.activeElement).toBe(link);

    // Announced: the control's description is the reason and the source, in a polite live
    // region, and the reason is visible text (not hidden from anyone).
    expect(description(m.button)).toContain('Why disabled');
    expect(description(m.button)).toContain(
      'Purge is locked on prod until armed',
    );
    expect(description(m.button)).toContain('Source docs.example.com');
    expect(m.reason.getAttribute('aria-live')).toBe('polite');
    expect(isExposed(m.reason)).toBe(true);
    expect(text(m.reason)).toContain('Purge is locked on prod until armed');
    m.el.remove();
  });

  it('AC-2 the link opens a new browsing context without handing it the page', async () => {
    const link = must((await mount(gate)).link(), 'link');
    expect(link.getAttribute('href')).toBe(
      'https://docs.example.com/guardrails#prod-lock',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does not emit activated and keeps the click from every listener above the button', async () => {
    const m = await mount(gate);
    const seen: boolean[] = [];
    m.el.addEventListener('click', (event) =>
      seen.push(event.defaultPrevented),
    );
    m.button.click();
    must(m.el.querySelector<HTMLElement>('.inner'), 'inner').click();
    expect(m.host.activations()).toBe(0);
    expect(m.clicks.host).toBe(0);
    expect(m.clicks.ancestor).toBe(0);
    expect(seen).toEqual([]);
  });

  it('a click on the source link is not held back', async () => {
    const m = await mount(gate);
    const seen: boolean[] = [];
    m.el.addEventListener('click', (event) => {
      seen.push(event.defaultPrevented);
      event.preventDefault(); // keep jsdom from navigating
    });
    must(m.link(), 'link').click();
    expect(seen).toEqual([false]);
    expect(m.host.activations()).toBe(0);
  });

  it('a click on a disabled button is cancelled, like any default action', async () => {
    const m = await mount(gate);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    m.button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each<[string, GateDecision | null | undefined]>([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {} as GateDecision],
    ['enabled false', { enabled: false }],
    ['enabled as the string "true"', { enabled: 'true' } as never],
    ['enabled as 1', { enabled: 1 } as never],
    ['mode degraded but not enabled', { enabled: false, mode: 'degraded' }],
  ])('a gate that is %s is a closed gate', async (_name, value) => {
    const m = await mount(value);
    expect(m.button.getAttribute('aria-disabled')).toBe('true');
    m.button.click();
    expect(m.host.activations()).toBe(0);
    expect(m.clicks.host).toBe(0);
    expect(text(m.reason)).toContain('Why disabled');
    expect(text(m.reason)).toContain('No reason given');
  });

  it('says so when the engine gave no reason, or only blanks', async () => {
    const m = await mount({ enabled: false, reason: '  \n ' });
    expect(text(m.reason)).toBe('Why disabled No reason given');
    expect(m.link()).toBeNull();
  });

  it('shows a source that is not a link as plain text', async () => {
    const m = await mount({
      enabled: false,
      reason: 'Locked',
      source: 'prod-lock',
    });
    expect(m.link()).toBeNull();
    expect(text(m.reason)).toBe('Why disabled Locked Source prod-lock');
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://docs.example.com/page',
    'https://user:secret@docs.example.com/page',
    '//docs.example.com/page',
    '/relative/path',
    'https://docs.example.com/a b',
    'https://docs.example.com/\u0000',
    ' https://docs.example.com/',
    'https://',
    'not a url',
    '',
  ])('never makes a link of the source %j', async (source) => {
    const m = await mount({ enabled: false, reason: 'Locked', source });
    expect(m.link()).toBeNull();
    expect(m.el.querySelector('[href]')).toBeNull();
    expect(parseSourceLink(source)).toBeNull();
  });

  it('links the normalised URL: an empty user name is dropped, not kept', () => {
    expect(parseSourceLink('https://@docs.example.com/page')).toEqual({
      href: 'https://docs.example.com/page',
      host: 'docs.example.com',
    });
  });

  it('renders the reason and source as text, never as markup', async () => {
    const m = await mount({
      enabled: false,
      reason: '<img src=x onerror=alert(1)><b>bold</b>',
      source: '<script>alert(1)</script>',
    });
    expect(m.el.querySelector('img, b, script')).toBeNull();
    expect(text(m.reason)).toContain('<img src=x onerror=alert(1)><b>bold</b>');
    expect(text(m.reason)).toContain('<script>alert(1)</script>');
  });

  it('shows the host of the link in punycode, so a look-alike name is not hidden', async () => {
    const m = await mount({
      enabled: false,
      reason: 'Locked',
      source: 'https://xn--pple-43d.example/help',
    });
    expect(text(m.link())).toBe('Source xn--pple-43d.example');
    const unicode = await mount({
      enabled: false,
      reason: 'Locked',
      source: 'https://аpple.example/help',
    });
    expect(text(unicode.link())).toBe('Source xn--pple-43d.example');
  });
});

describe('<app-gated> enabled', () => {
  it('emits activated once per click, and the click goes on to listeners above', async () => {
    const m = await mount({ enabled: true });
    expect(m.button.hasAttribute('aria-disabled')).toBe(false);
    m.button.click();
    expect(m.host.activations()).toBe(1);
    expect(m.clicks.host).toBe(1);
    expect(m.clicks.ancestor).toBe(1);
    expect(text(m.reason)).toBe('');
    expect(m.link()).toBeNull();
  });

  it('shows the reason of a degraded control and still lets it work', async () => {
    const m = await mount({
      enabled: true,
      mode: 'degraded',
      reason: 'Stats are off, totals only',
      source: 'https://docs.example.com/stats',
    });
    m.button.click();
    expect(m.host.activations()).toBe(1);
    expect(text(m.reason)).toContain('Limited');
    expect(text(m.reason)).toContain('Stats are off, totals only');
    expect(text(m.reason)).not.toContain('Why disabled');
    expect(m.button.hasAttribute('aria-disabled')).toBe(false);
    expect(description(m.button)).toContain('Stats are off, totals only');
    expect(m.link()?.getAttribute('href')).toBe(
      'https://docs.example.com/stats',
    );
  });

  it('a degraded control with no reason does not invent one', async () => {
    const m = await mount({ enabled: true, mode: 'degraded' });
    expect(text(m.reason)).toBe('Limited');
  });

  it('a full-mode gate shows no reason even when the engine sent one', async () => {
    const m = await mount({ enabled: true, mode: 'full', reason: 'ignored' });
    expect(text(m.reason)).toBe('');
  });
});

describe('<app-gated> over time', () => {
  it('closes the moment the engine closes the gate, and opens when it opens', async () => {
    const m = await mount({ enabled: true });
    m.button.click();
    expect(m.host.activations()).toBe(1);

    await m.set({ enabled: false, reason: 'Locked' });
    m.button.click();
    expect(m.host.activations()).toBe(1);
    expect(m.button.getAttribute('aria-disabled')).toBe('true');
    expect(text(m.reason)).toContain('Locked');

    await m.set(undefined);
    m.button.click();
    expect(m.host.activations()).toBe(1);

    await m.set({ enabled: true });
    m.button.click();
    expect(m.host.activations()).toBe(2);
    expect(text(m.reason)).toBe('');
  });

  it('gives each instance its own description id', async () => {
    const a = await mount({ enabled: false });
    const b = await mount({ enabled: false });
    expect(a.button.getAttribute('aria-describedby')).not.toBe(
      b.button.getAttribute('aria-describedby'),
    );
    expect(a.reason.id).toBe(a.button.getAttribute('aria-describedby'));
  });

  it('removes its capture listener when destroyed', async () => {
    const m = await mount({ enabled: false });
    const host = must(m.el.querySelector('app-gated'), 'host');
    const remove = vi.spyOn(host, 'removeEventListener');
    m.fixture.destroy();
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function), {
      capture: true,
    });
  });
});
