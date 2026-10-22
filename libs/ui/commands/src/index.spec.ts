import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('ui-commands public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'Announcer',
      'CHORD_MAX_CHARS',
      'COMMAND_CAPABILITIES',
      'COMMAND_ID',
      'COMMAND_PLATFORM',
      'CommandContext',
      'CommandRegistry',
      'Keymap',
      'NO_CAPABILITIES',
      'PALETTE_LIMIT',
      'RESERVED_CHORDS',
      'acceleratorOf',
      'availabilityOf',
      'bindingTable',
      'blockedChords',
      'buildMenuModel',
      'canonicalChord',
      'defaultChords',
      'displayChord',
      'effectiveChords',
      'findConflicts',
      'formatChord',
      'matchesChord',
      'parseChord',
      'physicalChord',
      'planAssign',
      'rankCommands',
      'registerCommands',
      'reservedCollisions',
      'reservedReason',
      'syncNativeMenu',
      'toRanges',
      'withUnbound',
      'withoutOverride',
    ]);
  });
});
