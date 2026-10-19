import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EnvClassSchema, type EnvClass } from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  ENV_CLASSES,
  EnvChrome,
  normalizeEnv,
  type EnvLabels,
} from './env-chrome';

const LABELS: EnvLabels = {
  prod: 'Production',
  staging: 'Staging',
  test: 'Test',
  dev: 'Development',
  local: 'Local',
};

@Component({
  imports: [EnvChrome],
  template: `<app-env-chrome
    [environment]="environment()"
    [labels]="labels()"
    [detail]="detail()"
  />`,
})
class Host {
  readonly environment = signal<EnvClass | null | undefined>('dev');
  readonly labels = signal<EnvLabels>(LABELS);
  readonly detail = signal<string | undefined>(undefined);
}

async function mount(environment: unknown, labels: EnvLabels = LABELS) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.environment.set(environment as EnvClass);
  fixture.componentInstance.labels.set(labels);
  await fixture.whenStable();
  const chrome = (fixture.nativeElement as HTMLElement).querySelector(
    'app-env-chrome',
  );
  if (!chrome) throw new Error('no chrome');
  return {
    fixture,
    chrome,
    text: () => chrome.textContent.replace(/\s+/g, ' ').trim(),
  };
}

describe('<app-env-chrome>', () => {
  it('knows exactly the environment classes of the contract', () => {
    expect([...ENV_CLASSES]).toEqual([...EnvClassSchema.options]);
  });

  it.each(ENV_CLASSES)(
    'names the class %s in text, not only in colour',
    async (env) => {
      const m = await mount(env);
      expect(m.chrome.getAttribute('data-env')).toBe(env);
      expect(m.text()).toBe(LABELS[env]);
    },
  );

  it('marks prod, and only prod, with the prod class', async () => {
    expect((await mount('prod')).chrome.classList.contains('prod')).toBe(true);
    for (const env of ENV_CLASSES.filter((known) => known !== 'prod')) {
      expect((await mount(env)).chrome.classList.contains('prod'), env).toBe(
        false,
      );
    }
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['an unknown class', 'qa'],
    ['a different case', 'PROD'],
    ['a number', 7],
    ['an object', {}],
  ])(
    'shows %s as prod, the way the engine reads an unset class',
    async (_name, value) => {
      const m = await mount(value);
      expect(m.chrome.getAttribute('data-env')).toBe('prod');
      expect(m.chrome.classList.contains('prod')).toBe(true);
      expect(m.text()).toBe('Production');
      expect(normalizeEnv(value)).toBe('prod');
    },
  );

  it('falls back to the class id when a label is missing, never to blank', async () => {
    const m = await mount('staging', { ...LABELS, staging: '' });
    expect(m.text()).toBe('staging');
  });

  it('shows the detail as text only', async () => {
    const m = await mount('prod');
    m.fixture.componentInstance.detail.set(
      '<img src=x onerror=alert(1)> orders-eu',
    );
    await m.fixture.whenStable();
    expect(m.chrome.querySelector('img')).toBeNull();
    expect(m.text()).toBe('Production <img src=x onerror=alert(1)> orders-eu');
    m.fixture.componentInstance.detail.set(undefined);
    await m.fixture.whenStable();
    expect(m.text()).toBe('Production');
  });

  it('follows the connection when it changes class', async () => {
    const m = await mount('dev');
    m.fixture.componentInstance.environment.set('prod');
    await m.fixture.whenStable();
    expect(m.chrome.getAttribute('data-env')).toBe('prod');
    expect(m.text()).toBe('Production');
  });
});
