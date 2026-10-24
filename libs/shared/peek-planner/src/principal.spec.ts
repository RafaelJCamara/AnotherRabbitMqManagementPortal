import { describe, expect, it } from 'vitest';

import { isHumanInteractive } from './principal.ts';
import { human, mcpClient, unattended } from './testing.ts';
import type { PeekPrincipal } from './types.ts';

describe('R11 human interactive principals', () => {
  it('accepts a person on a screen or a command line', () => {
    expect(isHumanInteractive(human)).toBe(true);
    expect(isHumanInteractive({ ...human, surface: 'cli' })).toBe(true);
    expect(
      isHumanInteractive({
        kind: 'team-user',
        surface: 'ui',
        unattended: false,
      }),
    ).toBe(true);
    expect(
      isHumanInteractive({
        kind: 'api-token',
        surface: 'cli',
        unattended: false,
      }),
    ).toBe(true);
  });

  it('rejects an MCP client, a job, the system and any unattended principal', () => {
    expect(isHumanInteractive(mcpClient)).toBe(false);
    expect(isHumanInteractive(unattended)).toBe(false);
    expect(
      isHumanInteractive({
        kind: 'system',
        surface: 'system',
        unattended: false,
      }),
    ).toBe(false);
    expect(isHumanInteractive({ ...human, unattended: true })).toBe(false);
    expect(isHumanInteractive({ ...human, surface: 'mcp' })).toBe(false);
    expect(isHumanInteractive({ ...human, kind: 'mcp-client' })).toBe(false);
  });

  it('is not fooled by whom the principal acts for or on behalf of', () => {
    // An MCP client acting for a person is still an MCP client.
    expect(isHumanInteractive({ ...mcpClient, onBehalfOf: human })).toBe(false);
    // A person's session acting for an unattended job is not interactive either.
    expect(isHumanInteractive({ ...human, onBehalfOf: unattended })).toBe(
      false,
    );
    expect(isHumanInteractive({ ...human, onBehalfOf: human })).toBe(true);
  });

  it('treats a delegation chain longer than the kernel allows as not a person', () => {
    let chain: PeekPrincipal = human;
    for (let i = 0; i < 4; i += 1) chain = { ...human, onBehalfOf: chain };
    expect(isHumanInteractive(chain)).toBe(false);
    let ok: PeekPrincipal = human;
    for (let i = 0; i < 3; i += 1) ok = { ...human, onBehalfOf: ok };
    expect(isHumanInteractive(ok)).toBe(true);
  });
});
