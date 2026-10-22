import { TestBed } from '@angular/core/testing';
import {
  CommandRegistry,
  providePaletteScope,
  type Availability,
  type CommandDefinition,
} from '@app/ui-commands';
import { describe, expect, it } from 'vitest';

import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../shell/status-bar/status-fixtures';
import { mountShell, until, visit } from '../shell/test-fixtures';
import { provideCommandCapabilities } from './command-capabilities';

const SAVE: CommandDefinition = {
  id: 'test.save',
  title: 'Save',
  category: 'Test',
  action: 'views.create',
  run: () => undefined,
};
const BROWSE: CommandDefinition = {
  id: 'test.browse',
  title: 'Browse',
  category: 'Test',
  gate: 'streams.browse',
  run: () => undefined,
};

function backendWith(): StatusBackend {
  const backend = new StatusBackend();
  for (const cid of ['c1', 'c2', 'c3']) {
    backend.connections.set(cid, connectionBody(cid, `Cluster ${cid}`, 'dev'));
  }
  const profile = (extra: Record<string, unknown>): unknown => ({
    ...(brokerProfileBody('c1') as Record<string, unknown>),
    ...extra,
  });
  backend.profiles.set(
    'c1',
    profile({
      allowedActions: ['views.create'],
      gates: {
        'streams.browse': {
          enabled: false,
          reason: 'Needs a newer broker.',
          source: 'guardrail',
        },
      },
    }),
  ); // c3 has no profile: the engine fails the call
  backend.profiles.set('c2', profile({ allowedActions: [] }));
  return backend;
}

describe('the capabilities of the commands', () => {
  it("AC-15 action commands follow the engine's allowedActions", async () => {
    const backend = backendWith();
    const bed = await mountShell(undefined, backend, undefined, [
      providePaletteScope(),
      provideCommandCapabilities(),
    ]);
    const registry = TestBed.inject(CommandRegistry);
    registry.register(SAVE);
    registry.register(BROWSE);
    const availability = (id: string): Availability | undefined =>
      registry.commands().find((c) => c.id === id)?.availability;

    const kindOf = (id: string): string | null => {
      const found = availability(id);
      return found !== undefined && !found.enabled ? found.reason.kind : null;
    };

    // No connection in view: nothing is known, so the action command is closed, never open by default.
    await visit(bed, '/');
    expect(availability('test.save')).toEqual({
      enabled: false,
      reason: { kind: 'unknown' },
    });

    // The profile of c1 lists views.create: open. Its gate for streams is closed with the engine's words.
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () => availability('test.save')?.enabled === true,
      'the profile of c1',
    );
    expect(availability('test.browse')).toEqual({
      enabled: false,
      reason: {
        kind: 'gate',
        reason: 'Needs a newer broker.',
        source: 'guardrail',
      },
    });

    // The profile of c2 does not list it: closed, and a gate the profile does not send is closed too.
    await visit(bed, '/c/c2/explorer');
    await until(
      bed,
      () =>
        availability('test.save')?.enabled === false &&
        kindOf('test.save') === 'not-allowed',
      'the profile of c2',
    );
    expect(availability('test.save')).toEqual({
      enabled: false,
      reason: { kind: 'not-allowed', action: 'views.create' },
    });
    expect(availability('test.browse')).toEqual({
      enabled: false,
      reason: { kind: 'unknown' },
    });

    // A profile that cannot be read is not known; one still on its way is loading. Neither is open.
    await visit(bed, '/c/c3/explorer');
    await until(
      bed,
      () =>
        backend.profileRequests.includes('c3') &&
        kindOf('test.save') === 'unknown',
      'the failed profile of c3',
    );
    expect(availability('test.save')).toEqual({
      enabled: false,
      reason: { kind: 'unknown' },
    });
    backend.hold();
    await bed.harness.navigateByUrl('/c/c1/explorer');
    await until(
      bed,
      () => kindOf('test.save') === 'loading',
      'the profile to be loading',
    );
    backend.release();
    await until(
      bed,
      () => availability('test.save')?.enabled === true,
      'the profile of c1 again',
    );
  });
});
