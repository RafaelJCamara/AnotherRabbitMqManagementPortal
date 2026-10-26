import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor } from './code-editor.component';
import {
  fakeHost,
  pick,
  provideFakeLoader,
  settle,
  type FakeHost,
} from './editor-spec-support';
import type { EditorMarker } from './facade';
import { EditorLoadError, MONACO_LOADER } from './loader';

async function mount(
  host: FakeHost,
  inputs: Record<string, unknown> = {},
): Promise<ComponentFixture<CodeEditor>> {
  TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
  const fixture = TestBed.createComponent(CodeEditor);
  fixture.componentRef.setInput('ariaLabel', 'Message body');
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  await settle(fixture);
  return fixture;
}

beforeEach(() => {
  localStorage.clear();
});

describe('<app-code-editor>', () => {
  it('M1-46 AC-12 binds value, language and readOnly without an echo loop', async () => {
    const host = fakeHost();
    const fixture = await mount(host, {
      value: '{"a":1}',
      language: 'json',
      readOnly: true,
    });
    const emitted: string[] = [];
    fixture.componentInstance.value.subscribe((v) => emitted.push(v));
    const editor = pick(host.editors, 0);
    expect(host.editors).toHaveLength(1);
    expect(editor.options).toEqual({
      value: '{"a":1}',
      language: 'json',
      readOnly: true,
      ariaLabel: 'Message body',
    });

    editor.type('{"a":2}');
    await settle(fixture);
    expect(emitted).toEqual(['{"a":2}']);
    expect(fixture.componentInstance.value()).toBe('{"a":2}');
    expect(editor.sets).toBe(0);

    fixture.componentRef.setInput('value', 'from outside');
    fixture.componentRef.setInput('language', 'xml');
    fixture.componentRef.setInput('readOnly', false);
    await settle(fixture);
    expect(editor.value).toBe('from outside');
    expect(editor.sets).toBe(1);
    expect(editor.language).toBe('xml');
    expect(editor.readOnly).toBe(false);
    expect(emitted).toEqual(['{"a":2}']);
    fixture.componentRef.setInput('readOnly', true);
    await settle(fixture);
    expect(editor.readOnly).toBe(true);
  });

  it('M1-46 slice B does not echo text the editor rewrote, and keeps listening afterwards', async () => {
    const host = fakeHost((text) => text.replaceAll('\r\n', '\n'));
    const fixture = await mount(host);
    const emitted: string[] = [];
    fixture.componentInstance.value.subscribe((v) => emitted.push(v));
    fixture.componentRef.setInput('value', 'x\r\ny');
    await settle(fixture);
    expect(pick(host.editors, 0).value).toBe('x\ny');
    expect(fixture.componentInstance.value()).toBe('x\r\ny');
    expect(emitted).toEqual([]);
    pick(host.editors, 0).type('z');
    expect(emitted).toEqual(['z']);
  });

  it('M1-46 slice B reports markers dropped before the editor exists only once', async () => {
    const host = fakeHost();
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('ariaLabel', 'x');
    fixture.componentRef.setInput(
      'markers',
      Array.from({ length: 107 }, (_, i) => ({
        line: i + 1,
        message: 'm',
        severity: 'info' as const,
      })),
    );
    const dropped: number[] = [];
    fixture.componentInstance.markersDropped.subscribe((n) => dropped.push(n));
    fixture.detectChanges();
    expect(dropped).toEqual([]);
    await settle(fixture);
    expect(dropped).toEqual([7]);
  });

  it('M1-46 AC-13 disposes everything exactly once, also before the lazy load resolves', async () => {
    const host = fakeHost();
    for (let cycle = 0; cycle < 100; cycle++) {
      TestBed.resetTestingModule();
      const fixture = await mount(host, { value: String(cycle) });
      fixture.destroy();
    }
    expect(host.editors).toHaveLength(100);
    expect(host.editors.every((e) => e.disposed === 1)).toBe(true);
    expect(
      host.editors.every(
        (e) => e.listenersAdded === 1 && e.listenersDisposed === 1,
      ),
    ).toBe(true);

    TestBed.resetTestingModule();
    let arrive: () => void = () => undefined;
    const late = new Promise<void>((resolve) => (arrive = resolve));
    const lateHost = fakeHost();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MONACO_LOADER,
          useValue: { load: () => late.then(() => lateHost) },
        },
      ],
    });
    const fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('ariaLabel', 'x');
    fixture.detectChanges();
    fixture.destroy();
    arrive();
    await late;
    await Promise.resolve();
    expect(lateHost.editors).toHaveLength(0);
    expect(lateHost.themes).toEqual([]);
  });

  it('M1-46 AC-14 reports the byte size over the limit and never truncates', async () => {
    const host = fakeHost();
    const max = 1_048_576;
    const fixture = await mount(host, { maxBytes: max });
    const over: number[] = [];
    fixture.componentInstance.overLimit.subscribe((n) => over.push(n));

    const tooBig = 'a'.repeat(max + 1);
    pick(host.editors, 0).type(tooBig);
    await settle(fixture);
    expect(over).toEqual([max + 1]);
    expect(pick(host.editors, 0).value).toHaveLength(max + 1);
    expect(fixture.componentInstance.value()).toHaveLength(max + 1);

    // 349,525 euro signs are 1,048,575 bytes; one more byte is exactly the limit, still within.
    const atLimit = '€'.repeat(349_525) + 'a';
    pick(host.editors, 0).type(atLimit);
    await settle(fixture);
    expect(over).toEqual([max + 1, 0]);
    // Fewer characters than the limit, but two bytes more than it.
    const multibyte = atLimit + 'é';
    pick(host.editors, 0).type(multibyte);
    await settle(fixture);
    expect(multibyte.length).toBeLessThan(max);
    expect(over).toEqual([max + 1, 0, max + 2]);
    expect(pick(host.editors, 0).value).toBe(multibyte);

    pick(host.editors, 0).type('short');
    await settle(fixture);
    pick(host.editors, 0).type('shorter');
    await settle(fixture);
    expect(over).toEqual([max + 1, 0, max + 2, 0]);
  });

  it('M1-46 slice B keeps at most 100 markers and says how many it dropped', async () => {
    const host = fakeHost();
    const fixture = await mount(host);
    const dropped: number[] = [];
    fixture.componentInstance.markersDropped.subscribe((n) => dropped.push(n));
    const marker = (line: number): EditorMarker => ({
      line,
      message: 'm',
      severity: 'error',
    });
    const many = Array.from({ length: 107 }, (_, i) => marker(i + 1));
    fixture.componentRef.setInput('markers', many);
    await settle(fixture);
    expect(pick(host.editors, 0).markers).toEqual(many.slice(0, 100));
    expect(dropped).toEqual([7]);

    fixture.componentRef.setInput('markers', many.slice(0, 100));
    await settle(fixture);
    expect(pick(host.editors, 0).markers).toHaveLength(100);
    expect(dropped).toEqual([7]);
  });

  it('M1-46 slice B reports a failed load once, typed, and shows the hint', async () => {
    const reasons = [
      new EditorLoadError('not-bundled', 'no entry'),
      new Error('chunk failed'),
    ];
    const seen: EditorLoadError[] = [];
    for (const reason of reasons) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          {
            provide: MONACO_LOADER,
            useValue: { load: () => Promise.reject(reason) },
          },
        ],
      });
      const fixture = TestBed.createComponent(CodeEditor);
      fixture.componentRef.setInput('ariaLabel', 'x');
      fixture.componentRef.setInput('hint', 'Press Ctrl+M to leave.');
      fixture.componentInstance.loadFailed.subscribe((e) => seen.push(e));
      await settle(fixture);
      expect((fixture.nativeElement as HTMLElement).textContent).toContain(
        'Press Ctrl+M to leave.',
      );
    }
    expect(seen.map((e) => e.code)).toEqual(['not-bundled', 'module']);
    expect(pick(seen, 0)).toBe(reasons[0]);
    expect((pick(seen, 1).cause as Error).message).toBe('chunk failed');
  });

  it('M1-46 slice B says ready once, shows no hint unasked, and a late failure reports nothing', async () => {
    const host = fakeHost();
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const fixture = TestBed.createComponent(CodeEditor);
    fixture.componentRef.setInput('ariaLabel', 'x');
    let ready = 0;
    fixture.componentInstance.ready.subscribe(() => {
      ready++;
    });
    await settle(fixture);
    expect(ready).toBe(1);
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.code-editor-hint')).toBeNull();

    TestBed.resetTestingModule();
    let fail: (reason: Error) => void = () => undefined;
    const doomed = new Promise<never>((_, reject) => (fail = reject));
    TestBed.configureTestingModule({
      providers: [{ provide: MONACO_LOADER, useValue: { load: () => doomed } }],
    });
    const gone = TestBed.createComponent(CodeEditor);
    gone.componentRef.setInput('ariaLabel', 'x');
    const failures: EditorLoadError[] = [];
    gone.componentInstance.loadFailed.subscribe((e) => failures.push(e));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    gone.detectChanges();
    gone.destroy();
    fail(new Error('late'));
    await doomed.catch(() => undefined);
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
