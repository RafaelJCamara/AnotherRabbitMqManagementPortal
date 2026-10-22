// A sparkline (M1-54): the shape of one series in a line of text, with its newest value said in words. It has a
// name and a value text for assistive technology, no axes and nothing to operate. A series with no points draws
// nothing (never a flat line at zero).
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { styleOf } from './chart-types';
import { downsample, type Point } from './draw/downsample';
import { gapThreshold, pathOf } from './draw/path';
import { linearScale } from './draw/scales';

@Component({
  selector: 'app-sparkline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      role="img"
      [attr.aria-label]="name()"
      [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
      [attr.width]="width()"
      [attr.height]="height()"
    >
      @if (path(); as d) {
        <path
          class="line"
          [attr.d]="d"
          [style.stroke]="'var(' + style().colour + ')'"
        />
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-block;
      line-height: 0;
    }
    .line {
      fill: none;
      stroke-width: 1.5;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
  `,
})
export class Sparkline {
  readonly points = input.required<readonly Point[]>();
  /** The accessible name: what it shows and its newest value, in the host's words. */
  readonly name = input.required<string>();
  /** Which colour token it uses (0 to 5). */
  readonly seriesStyle = input(0);
  readonly width = input(96);
  readonly height = input(24);

  protected readonly style = computed(() => styleOf(this.seriesStyle()));
  protected readonly path = computed(() => {
    const points = this.points();
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return '';
    const width = this.width();
    const height = this.height();
    const values = points.map((p) => p.v).filter(Number.isFinite);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const x = linearScale(first.t, last.t, 1, width - 1);
    const y = linearScale(low, high, height - 2, 2);
    return pathOf(
      downsample(points, first.t, last.t, width),
      x,
      y,
      gapThreshold(points),
    );
  });
}
