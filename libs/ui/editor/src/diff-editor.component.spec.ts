import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { DiffEditor } from './diff-editor.component';
import {
  fakeHost,
  pick,
  provideFakeLoader,
  settle,
} from './editor-spec-support';
import { MONACO_LOADER } from './loader';

describe('<app-diff-editor>', () => {
  it('M1-46 AC-17 the diff editor shows two sides and disposes both', async () => {
    const host = fakeHost();
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const fixture = TestBed.createComponent(DiffEditor);
    fixture.componentRef.setInput('ariaLabel', 'Changes');
    fixture.componentRef.setInput('original', 'one');
    fixture.componentRef.setInput('modified', 'two');
    fixture.componentRef.setInput('language', 'json');
    const changes: string[] = [];
    fixture.componentInstance.modified.subscribe((v) => changes.push(v));
    let ready = 0;
    fixture.componentInstance.ready.subscribe(() => {
      ready++;
    });
    await settle(fixture);
    expect(ready).toBe(1);
    expect(host.themes).toEqual(['vs']);

    const diff = pick(host.diffs, 0);
    expect(host.diffs).toHaveLength(1);
    expect(diff.options).toEqual({
      original: 'one',
      modified: 'two',
      language: 'json',
      ariaLabel: 'Changes',
      originalEditable: false,
    });

    diff.type('two, edited');
    await settle(fixture);
    expect(changes).toEqual(['two, edited']);
    expect(fixture.componentInstance.modified()).toBe('two, edited');
    expect(diff.sets).toBe(0);

    fixture.componentRef.setInput('original', 'uno');
    fixture.componentRef.setInput('modified', 'dos');
    fixture.componentRef.setInput('language', 'xml');
    await settle(fixture);
    expect(diff.original).toBe('uno');
    expect(diff.modified).toBe('dos');
    expect(diff.language).toBe('xml');
    expect(diff.sets).toBe(1);
    expect(changes).toEqual(['two, edited']);

    fixture.destroy();
    expect(diff.disposed).toBe(1);
    expect(diff.listenersAdded).toBe(1);
    expect(diff.listenersDisposed).toBe(1);
  });

  it('M1-46 slice B a diff destroyed before the load resolves creates nothing', async () => {
    const host = fakeHost();
    let arrive: () => void = () => undefined;
    const late = new Promise<void>((resolve) => (arrive = resolve));
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MONACO_LOADER,
          useValue: { load: () => late.then(() => host) },
        },
      ],
    });
    const fixture = TestBed.createComponent(DiffEditor);
    fixture.componentRef.setInput('ariaLabel', 'Changes');
    fixture.detectChanges();
    fixture.destroy();
    arrive();
    await late;
    await Promise.resolve();
    expect(host.diffs).toHaveLength(0);
    expect(host.themes).toEqual([]);
  });

  it('M1-46 slice B a diff does not echo rewritten text, and a late failure reports nothing', async () => {
    const host = fakeHost((text) => text.replaceAll('\r\n', '\n'));
    TestBed.configureTestingModule({ providers: [provideFakeLoader(host)] });
    const fixture = TestBed.createComponent(DiffEditor);
    fixture.componentRef.setInput('ariaLabel', 'x');
    const changes: string[] = [];
    fixture.componentInstance.modified.subscribe((v) => changes.push(v));
    await settle(fixture);
    fixture.componentRef.setInput('modified', 'a\r\nb');
    await settle(fixture);
    expect(pick(host.diffs, 0).modified).toBe('a\nb');
    expect(changes).toEqual([]);
    pick(host.diffs, 0).type('c');
    expect(changes).toEqual(['c']);

    TestBed.resetTestingModule();
    let fail: (reason: Error) => void = () => undefined;
    const doomed = new Promise<never>((_, reject) => (fail = reject));
    TestBed.configureTestingModule({
      providers: [{ provide: MONACO_LOADER, useValue: { load: () => doomed } }],
    });
    const gone = TestBed.createComponent(DiffEditor);
    gone.componentRef.setInput('ariaLabel', 'x');
    const failures: unknown[] = [];
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
