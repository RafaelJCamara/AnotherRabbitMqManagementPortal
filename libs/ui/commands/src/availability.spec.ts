import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { Announcer } from './announcer';
import {
  COMMAND_CAPABILITIES,
  availabilityOf,
  type CapabilitySnapshot,
} from './availability';
import type { CommandDefinition } from './command';
import { CommandRegistry } from './registry';

const READY: CapabilitySnapshot = {
  status: 'ready',
  allowedActions: ['views.create'],
  gates: {
    'streams.browse': {
      enabled: false,
      reason: 'Needs RabbitMQ 3.9 or newer.',
      source: 'https://example.com/docs',
    },
    'amqp.peek': {
      enabled: true,
      mode: 'degraded',
      reason: 'Side effects apply.',
    },
  },
};

describe('availability', () => {
  it("AC-5 closed commands carry the engine's reason and never run", async () => {
    // A gate the engine closed: its reason and source as sent.
    expect(availabilityOf({ gate: 'streams.browse' }, READY)).toEqual({
      enabled: false,
      reason: {
        kind: 'gate',
        reason: 'Needs RabbitMQ 3.9 or newer.',
        source: 'https://example.com/docs',
      },
    });
    // A degraded gate is open (the engine said enabled); a gate the engine did not send is closed.
    expect(availabilityOf({ gate: 'amqp.peek' }, READY)).toEqual({
      enabled: true,
    });
    expect(availabilityOf({ gate: 'tap.firehose' }, READY)).toEqual({
      enabled: false,
      reason: { kind: 'unknown' },
    });
    // A decision a feature holds: anything but enabled === true is closed.
    expect(availabilityOf({ gate: () => ({ enabled: false }) }, READY)).toEqual(
      {
        enabled: false,
        reason: { kind: 'gate', reason: '' },
      },
    );
    expect(availabilityOf({ gate: () => null }, READY).enabled).toBe(false);
    expect(availabilityOf({ gate: () => undefined }, READY).enabled).toBe(
      false,
    );
    // An action is open only when the engine's list has it.
    expect(availabilityOf({ action: 'views.create' }, READY)).toEqual({
      enabled: true,
    });
    expect(availabilityOf({ action: 'views.delete' }, READY)).toEqual({
      enabled: false,
      reason: { kind: 'not-allowed', action: 'views.delete' },
    });
    expect(
      availabilityOf({ action: 'views.create' }, { status: 'ready' }),
    ).toEqual({
      enabled: false,
      reason: { kind: 'not-allowed', action: 'views.create' },
    });
    // Loading, unknown and no connection close an action command, each with its own reason.
    expect(
      availabilityOf({ action: 'views.create' }, { status: 'loading' }),
    ).toEqual({
      enabled: false,
      reason: { kind: 'loading' },
    });
    for (const status of ['unknown', 'none'] as const) {
      expect(availabilityOf({ action: 'views.create' }, { status })).toEqual({
        enabled: false,
        reason: { kind: 'unknown' },
      });
    }
    // A command with no requirement is open even while nothing is known; the feature's own reason closes it.
    expect(availabilityOf({}, { status: 'none' })).toEqual({ enabled: true });
    expect(availabilityOf({ unavailable: () => null }, READY)).toEqual({
      enabled: true,
    });
    expect(
      availabilityOf({ unavailable: () => 'Wait 10 seconds.' }, READY),
    ).toEqual({
      enabled: false,
      reason: { kind: 'own', text: 'Wait 10 seconds.' },
    });
    // The gate decides before the action and the action before the feature's reason.
    expect(
      availabilityOf(
        {
          gate: 'streams.browse',
          action: 'views.create',
          unavailable: () => 'later',
        },
        READY,
      ),
    ).toMatchObject({ reason: { kind: 'gate' } });

    // Through the registry: a closed command is never run and its reason is announced.
    const snapshot = signal<CapabilitySnapshot>(READY);
    TestBed.configureTestingModule({
      providers: [{ provide: COMMAND_CAPABILITIES, useValue: snapshot }],
    });
    const registry = TestBed.inject(CommandRegistry);
    const run = vi.fn();
    const closed: CommandDefinition = {
      id: 'views.remove',
      title: 'Delete the view',
      category: 'View',
      action: 'views.delete',
      run,
    };
    const open: CommandDefinition = {
      ...closed,
      id: 'views.save',
      action: 'views.create',
      title: 'Save',
    };
    registry.register(closed);
    registry.register(open);

    const outcome = await registry.execute('views.remove');
    expect(outcome.status).toBe('closed');
    expect(run).not.toHaveBeenCalled();
    expect(TestBed.inject(Announcer).latest()).toMatchObject({
      key: 'closed',
      params: {
        title: 'Delete the view',
        reason: { kind: 'not-allowed', action: 'views.delete' },
      },
    });
    expect(await registry.execute('views.save')).toEqual({ status: 'ran' });
    expect(run).toHaveBeenCalledTimes(1);

    // The snapshot is live: when the engine's list changes, the same command opens.
    snapshot.set({ ...READY, allowedActions: ['views.delete'] });
    expect(
      registry.commands().find((c) => c.id === 'views.remove')?.availability
        .enabled,
    ).toBe(true);
    expect(
      registry.commands().find((c) => c.id === 'views.save')?.availability
        .enabled,
    ).toBe(false);
  });
});
