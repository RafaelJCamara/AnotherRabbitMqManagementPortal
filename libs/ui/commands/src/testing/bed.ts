// The command system as the specs mount it: Transloco with the real English scope, the real `EngineApi` over a
// fake engine that keeps the keybinding document, a clock the spec moves, a platform, and a capability snapshot
// the spec changes. Never part of the library build or its public API.
import {
  signal,
  type EnvironmentProviders,
  type Provider,
  type WritableSignal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ENGINE_PARSE, provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import { FakeEngine, MemoryTransport, waitFor } from '@app/ui-platform/testing';
import { provideTransloco } from '@jsverse/transloco';

import { COMMAND_CAPABILITIES, type CapabilitySnapshot } from '../availability';
import type { Platform } from '../chord';
import { CommandHost } from '../command-host.component';
import { providePaletteScope } from '../palette-scope';
import { COMMAND_PLATFORM } from '../registry';
import { COMMAND_TIMER } from '../timer';
import { FakeKeybindings } from './fake-keybindings';
import { ManualTimer } from './manual-timer';

export interface CommandBed {
  readonly fixture: ComponentFixture<CommandHost>;
  readonly el: HTMLElement;
  readonly keybindings: FakeKeybindings;
  readonly engine: FakeEngine;
  readonly timer: ManualTimer;
  readonly capabilities: WritableSignal<CapabilitySnapshot>;
}

/** Providers every command spec needs. `providers` are added last, so a spec can override any of them. */
export function commandProviders(
  engine: FakeEngine,
  options: {
    readonly platform?: Platform;
    readonly timer?: ManualTimer;
    readonly capabilities?: WritableSignal<CapabilitySnapshot>;
  } = {},
): (Provider | EnvironmentProviders)[] {
  return [
    provideTransloco({
      config: { availableLangs: ['en'], defaultLang: 'en', prodMode: true },
    }),
    providePaletteScope(),
    provideEngineData(),
    { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
    { provide: ENGINE_PARSE, useValue: true },
    { provide: COMMAND_PLATFORM, useValue: options.platform ?? 'other' },
    { provide: COMMAND_TIMER, useValue: options.timer ?? new ManualTimer() },
    ...(options.capabilities === undefined
      ? []
      : [{ provide: COMMAND_CAPABILITIES, useValue: options.capabilities }]),
  ];
}

export async function mountHost(
  options: {
    readonly keybindings?: FakeKeybindings;
    readonly platform?: Platform;
    readonly providers?: readonly Provider[];
  } = {},
): Promise<CommandBed> {
  const keybindings = options.keybindings ?? new FakeKeybindings();
  const timer = new ManualTimer();
  const capabilities = signal<CapabilitySnapshot>({ status: 'none' });
  const engine = new FakeEngine({ handler: keybindings.handler });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      ...commandProviders(engine, {
        timer,
        capabilities,
        ...(options.platform === undefined
          ? {}
          : { platform: options.platform }),
      }),
      ...(options.providers ?? []),
    ],
  });
  const fixture = TestBed.createComponent(CommandHost);
  const el = fixture.nativeElement as HTMLElement;
  document.body.append(el);
  await fixture.whenStable();
  return { fixture, el, keybindings, engine, timer, capabilities };
}

/** Lets translations and deferred views reach the DOM: they arrive through promises Angular does not track. */
export async function settle(
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  let previous = '';
  await waitFor(() => {
    fixture.detectChanges();
    const now = document.body.innerHTML;
    const stable = now === previous;
    previous = now;
    return stable;
  }, 'the view to settle');
}

/** Dispatches a key on `target` (the document by default), as a person would press it. */
export function press(
  key: string,
  init: KeyboardEventInit = {},
  target: EventTarget = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** Waits until `check` holds: deferred views, translations and the engine's answers arrive after the event. */
export async function until(
  fixture: ComponentFixture<unknown>,
  check: () => boolean,
  what: string,
): Promise<void> {
  await waitFor(() => {
    fixture.detectChanges();
    return check();
  }, what);
}
