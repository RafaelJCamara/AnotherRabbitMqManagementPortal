import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Splitter } from './splitter';

interface Setup {
  readonly fixture: ComponentFixture<Splitter>;
  readonly host: HTMLElement;
  readonly emitted: number[];
}

function mount(
  inputs: Partial<{
    orientation: 'vertical' | 'horizontal';
    value: number;
    min: number;
    max: number;
    reverse: boolean;
  }> = {},
): Setup {
  const fixture = TestBed.createComponent(Splitter);
  const all = {
    orientation: 'vertical',
    value: 300,
    min: 160,
    max: 600,
    reverse: false,
    ...inputs,
  };
  for (const [name, value] of Object.entries(all)) {
    fixture.componentRef.setInput(name, value);
  }
  fixture.componentRef.setInput('label', 'Resize');
  const emitted: number[] = [];
  fixture.componentInstance.resized.subscribe((value) => emitted.push(value));
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement, emitted };
}

const key = (host: HTMLElement, name: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, cancelable: true });
  host.dispatchEvent(event);
  return event;
};

function pointer(host: HTMLElement, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, {
    button: 0,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  host.dispatchEvent(event);
}

describe('Splitter', () => {
  it('is a focusable separator that carries its value, bounds and name', () => {
    const { host } = mount();
    expect(host.getAttribute('role')).toBe('separator');
    expect(host.getAttribute('tabindex')).toBe('0');
    expect(host.getAttribute('aria-orientation')).toBe('vertical');
    expect(host.getAttribute('aria-valuenow')).toBe('300');
    expect(host.getAttribute('aria-valuemin')).toBe('160');
    expect(host.getAttribute('aria-valuemax')).toBe('600');
    expect(host.getAttribute('aria-label')).toBe('Resize');
  });

  it('moves with the arrow keys of its axis, Home and End, within bounds', () => {
    const { host, emitted, fixture } = mount();
    expect(key(host, 'ArrowRight').defaultPrevented).toBe(true);
    expect(key(host, 'ArrowLeft').defaultPrevented).toBe(true);
    key(host, 'Home');
    key(host, 'End');
    expect(emitted).toEqual([316, 284, 160, 600]);
    // The keys of the other axis and other keys do nothing, and are not swallowed.
    emitted.length = 0;
    expect(key(host, 'ArrowDown').defaultPrevented).toBe(false);
    expect(key(host, 'a').defaultPrevented).toBe(false);
    expect(emitted).toEqual([]);
    // At a bound there is nothing to report.
    fixture.componentRef.setInput('value', 600);
    fixture.detectChanges();
    key(host, 'ArrowRight');
    expect(emitted).toEqual([]);
  });

  it('a reversed splitter grows toward the start: the panel above gets taller on ArrowUp', () => {
    const { host, emitted } = mount({
      orientation: 'horizontal',
      reverse: true,
      value: 200,
      min: 80,
      max: 500,
    });
    key(host, 'ArrowUp');
    key(host, 'ArrowDown');
    key(host, 'ArrowLeft');
    expect(emitted).toEqual([216, 184]);
  });

  it('drags with the pointer and reports clamped sizes', () => {
    const { host, emitted, fixture } = mount();
    pointer(host, 'pointermove', 500, 0); // not dragging yet
    expect(emitted).toEqual([]);
    pointer(host, 'pointerdown', 300, 10);
    fixture.detectChanges();
    expect(host.classList).toContain('dragging');
    pointer(host, 'pointermove', 350, 10);
    pointer(host, 'pointermove', 9000, 10);
    pointer(host, 'pointermove', -9000, 10);
    pointer(host, 'pointerup', 0, 10);
    fixture.detectChanges();
    expect(host.classList).not.toContain('dragging');
    expect(emitted).toEqual([350, 600, 160]);
    pointer(host, 'pointermove', 400, 10);
    expect(emitted).toHaveLength(3);
    fixture.detectChanges();
  });
});
