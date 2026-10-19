import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { VerificationSchema, type Verification } from '@app/domain-model';
import { describe, expect, it } from 'vitest';

import {
  normalizeVerification,
  VERIFICATION_STATES,
  VerificationBanner,
  type VerificationLabels,
} from './verification-banner';

const LABELS: VerificationLabels = {
  'unverified-patch': 'This patch release is not verified',
  'unverified-minor': 'This minor release is not verified',
  'unknown-build': 'Unknown build: nothing is verified',
};

@Component({
  imports: [VerificationBanner],
  template: `<app-verification-banner
    [verification]="verification()"
    [labels]="labels()"
    [detail]="detail()"
  />`,
})
class Host {
  readonly verification = signal<Verification | null | undefined>('verified');
  readonly labels = signal<VerificationLabels>(LABELS);
  readonly detail = signal<string | undefined>(undefined);
}

async function mount(
  verification: unknown,
  labels: VerificationLabels = LABELS,
) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.verification.set(verification as Verification);
  fixture.componentInstance.labels.set(labels);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    banner: () => el.querySelector<HTMLElement>('.banner'),
    text: () => el.textContent.replace(/\s+/g, ' ').trim(),
  };
}

describe('<app-verification-banner>', () => {
  it('knows exactly the verification states of the broker profile', () => {
    expect([...VERIFICATION_STATES]).toEqual([...VerificationSchema.options]);
  });

  it('shows nothing for a verified build, and only for that', async () => {
    const m = await mount('verified');
    expect(m.banner()).toBeNull();
    expect(m.text()).toBe('');
  });

  it.each(['unverified-patch', 'unverified-minor', 'unknown-build'] as const)(
    'shows the message of %s in a status region',
    async (state) => {
      const m = await mount(state);
      expect(m.banner()?.getAttribute('role')).toBe('status');
      expect(m.banner()?.getAttribute('data-verification')).toBe(state);
      expect(m.text()).toBe(LABELS[state]);
    },
  );

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a state from a newer engine', 'verified-with-caveats'],
    ['a different case', 'Verified'],
    ['a boolean', true],
  ])(
    'shows %s as an unknown build, never as verified',
    async (_name, value) => {
      const m = await mount(value);
      expect(m.banner()?.getAttribute('data-verification')).toBe(
        'unknown-build',
      );
      expect(m.text()).toBe(LABELS['unknown-build']);
      expect(normalizeVerification(value)).toBe('unknown-build');
    },
  );

  it('falls back to the state id when a message is missing, never to blank', async () => {
    const m = await mount('unverified-minor', {
      ...LABELS,
      'unverified-minor': '',
    });
    expect(m.text()).toBe('unverified-minor');
  });

  it('shows the detail as text only, and drops it again', async () => {
    const m = await mount('unverified-patch');
    m.fixture.componentInstance.detail.set('<b>4.3.7</b>');
    await m.fixture.whenStable();
    expect(m.el.querySelector('b')).toBeNull();
    expect(m.text()).toBe(`${LABELS['unverified-patch']} <b>4.3.7</b>`);
    m.fixture.componentInstance.detail.set(undefined);
    await m.fixture.whenStable();
    expect(m.text()).toBe(LABELS['unverified-patch']);
  });

  it('appears when a verified connection is replaced by an unverified one', async () => {
    const m = await mount('verified');
    m.fixture.componentInstance.verification.set('unverified-patch');
    await m.fixture.whenStable();
    expect(m.banner()).not.toBeNull();
    m.fixture.componentInstance.verification.set('verified');
    await m.fixture.whenStable();
    expect(m.banner()).toBeNull();
  });
});
