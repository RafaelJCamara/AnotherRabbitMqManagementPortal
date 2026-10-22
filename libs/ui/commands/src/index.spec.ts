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
      'COMMAND_TIMER',
      'CommandContext',
      'CommandHost',
      'CommandRegistry',
      'KEYMAP_SAVE_DELAY_MS',
      'Keymap',
      'KeymapStore',
      'NO_CAPABILITIES',
      'PALETTE_LIMIT',
      'PALETTE_SCOPE',
      'PALETTE_SCOPE_LOADER',
      'PaletteControl',
      'RESERVED_CHORDS',
      'acceleratorOf',
      'availabilityOf',
      'bindingTable',
      'blockedChords',
      'buildMenuModel',
      'canonicalChord',
      'chordOfEvent',
      'defaultChords',
      'describeReason',
      'displayChord',
      'effectiveChords',
      'findConflicts',
      'formatChord',
      'matchesChord',
      'paletteScope',
      'parseChord',
      'physicalChord',
      'planAssign',
      'providePaletteScope',
      'rankCommands',
      'registerCommands',
      'reservedCollisions',
      'reservedReason',
      'scopedText',
      'syncNativeMenu',
      'toRanges',
      'withUnbound',
      'withoutOverride',
    ]);
  });
});
