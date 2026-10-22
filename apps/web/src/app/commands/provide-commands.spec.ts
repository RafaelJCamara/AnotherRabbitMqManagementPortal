import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CommandRegistry, KeymapStore } from '@app/ui-commands';
import { ENGINE_PARSE, provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  jsonResponse,
  waitFor,
} from '@app/ui-platform/testing';
import { describe, expect, it } from 'vitest';

import { SCOPE_LOADERS, provideI18n } from '../i18n/i18n.config';
import { markerLoaders } from '../i18n/test-fixtures';
import { provideCommands } from './provide-commands';

describe('provideCommands', () => {
  it('M1-41 AC-8b the app mounts the command host once, loads the keymap and opens the palette on Ctrl+K', async () => {
    const requests: string[] = [];
    const engine = new FakeEngine({
      handler: (request) => {
        requests.push(`${request.method} ${request.url}`);
        return jsonResponse(200, { bindings: {} });
      },
    });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideI18n(),
        { provide: SCOPE_LOADERS, useValue: markerLoaders() },
        provideEngineData(),
        { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
        { provide: ENGINE_PARSE, useValue: true },
        provideCommands(),
      ],
    });
    // The environment initializers run when the injector is first used, as they do at bootstrap.
    TestBed.inject(ApplicationRef);
    const hosts = document.querySelectorAll('[data-command-host]');
    expect(hosts).toHaveLength(1);

    // The host loaded the person's keymap and the app registered its commands.
    await waitFor(
      () => requests.includes('GET /api/v1/keybindings'),
      'the keymap to load',
    );
    await waitFor(
      () => TestBed.inject(KeymapStore).loadStatus() === 'ready',
      'the keymap to be ready',
    );
    expect(
      TestBed.inject(CommandRegistry)
        .commands()
        .map((c) => c.id),
    ).toEqual(
      expect.arrayContaining([
        'palette.open',
        'help.keyboard-shortcuts',
        'connection.add',
        'connection.manage',
        'view.toggle-theme',
      ]),
    );

    // Ctrl+K opens the palette from anywhere on the page, and it is a dialog the host owns.
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitFor(
      () => document.querySelector('[role="dialog"]') !== null,
      'the palette',
    );
    expect(document.querySelector('[role="combobox"]')).not.toBeNull();

    // Destroying the application removes the host.
    TestBed.resetTestingModule();
    expect(document.querySelectorAll('[data-command-host]')).toHaveLength(0);
  });
});
