import { TestBed } from '@angular/core/testing';
import { ThemeService } from '@app/ui-design';

import { appRoutes } from '../app.routes';
import { Gallery } from './gallery';

describe('gallery', () => {
  // The unit tests build with the development configuration, where the gallery is routed. The
  // production side is proved by `pnpm nx run web-gallery-check:gallery-absent`.
  it('AC-2 is routed in a development build, lazily', async () => {
    const route = appRoutes.find((candidate) => candidate.path === 'gallery');
    expect(route).toBeDefined();
    expect(route?.component).toBeUndefined();
    expect(route?.loadComponent).toBeTypeOf('function');
    await expect(
      Promise.resolve((route?.loadComponent as () => Promise<unknown>)()),
    ).resolves.toBe(Gallery);
  });

  it('shows every component state and switches theme and density', async () => {
    const fixture = TestBed.createComponent(Gallery);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    // One gated control per example, one chrome per class plus the unset one, one banner per
    // state plus the unset one.
    expect(el.querySelectorAll('app-gated')).toHaveLength(6);
    expect(el.querySelectorAll('app-env-chrome')).toHaveLength(6);
    expect(el.querySelectorAll('app-verification-banner')).toHaveLength(5);
    expect(el.querySelectorAll('app-verification-banner .banner')).toHaveLength(
      4,
    );

    const theme = TestBed.inject(ThemeService);
    const buttons = [
      ...el.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
    ];
    const pressed = (label: string) =>
      buttons.find((button) => button.textContent.trim() === label);
    pressed('high-contrast')?.click();
    pressed('compact')?.click();
    await fixture.whenStable();
    expect(theme.resolved()).toBe('high-contrast');
    expect(theme.density()).toBe('compact');
    expect(pressed('high-contrast')?.getAttribute('aria-pressed')).toBe('true');
    expect(pressed('dark')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('counts activations of enabled gated controls only', async () => {
    const fixture = TestBed.createComponent(Gallery);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    for (const button of el.querySelectorAll<HTMLButtonElement>(
      'app-gated button',
    )) {
      button.click();
    }
    await fixture.whenStable();
    // Enabled and degraded work; the four others do not.
    expect(el.querySelector('p')?.textContent).toContain('2');
  });
});
