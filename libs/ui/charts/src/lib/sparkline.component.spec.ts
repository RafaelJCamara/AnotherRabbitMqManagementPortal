import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { points, vertices } from './chart-spec-support';
import type { Point } from '@app/chart-math';
import { Sparkline } from './sparkline.component';

@Component({
  imports: [Sparkline],
  template: `<app-sparkline
    [points]="points()"
    [name]="name()"
    [seriesStyle]="2"
    [width]="96"
    [height]="24"
  />`,
})
class Host {
  readonly points = signal<readonly Point[]>([]);
  readonly name = signal('Ready: 5 messages');
}

describe('<app-sparkline>', () => {
  it('M1-54 AC-15 the sparkline has a name and a value, one line and nothing to operate', async () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.points.set(
      points(500, (i) => Math.sin(i / 10) * 50, 0, 1000),
    );
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const svg = el.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Ready: 5 messages');
    const lines = el.querySelectorAll('path.line');
    expect(lines).toHaveLength(1);
    // Bounded to the pixel width, coloured by its token, and nothing interactive inside.
    expect(vertices(lines[0]?.getAttribute('d') ?? '')).toBeLessThanOrEqual(
      4 * 96,
    );
    expect(el.querySelector('path.line')?.getAttribute('style')).toContain(
      '--ds-color-chart-3',
    );
    expect(el.querySelector('button, a, input, [tabindex]')).toBeNull();

    // No points: nothing is drawn (never a flat line at zero), and it still has its name.
    fixture.componentInstance.points.set([]);
    fixture.componentInstance.name.set('Ready: not reported');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelector('path.line')).toBeNull();
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Ready: not reported',
    );
    // One point is a dot, not an error.
    fixture.componentInstance.points.set([{ t: 5, v: 7 }]);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelectorAll('path.line')).toHaveLength(1);
  }, 20_000);
});
