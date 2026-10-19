import { describe, expect, it } from 'vitest';

import * as api from './index';

describe('live public API', () => {
  // Update this list, and the README, together with every export you add.
  it('exports exactly the documented names', () => {
    expect(Object.keys(api).sort()).toEqual([
      'DEFAULT_MAX_CLIENT_FRAME_BYTES',
      'DEFAULT_MAX_CONNECTIONS',
      'LiveHub',
      'MAX_TICKETS',
      'TICKET_TTL_MS',
      'createTicketStore',
      'createTopicRegistry',
    ]);
  });
});
