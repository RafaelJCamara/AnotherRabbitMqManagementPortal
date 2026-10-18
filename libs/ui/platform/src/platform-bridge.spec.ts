import { BRIDGE_VERSION, type PlatformBridge } from '@app/contracts';
import { describe, expect, it, vi } from 'vitest';

import { WebBridge, isPlatformBridge } from './platform-bridge';

function bridge(
  options: Partial<ConstructorParameters<typeof WebBridge>[0]> = {},
): WebBridge {
  return new WebBridge({
    appInfo: () => Promise.resolve({ version: '1.0.0', mode: 'local' }),
    ...options,
  });
}

describe('WebBridge', () => {
  it('is a web bridge of version 1', () => {
    const web = bridge();
    expect(web.kind).toBe('web');
    expect(web.bridgeVersion).toBe(BRIDGE_VERSION);
    expect(isPlatformBridge(web)).toBe(true);
  });

  it('opens an https link in a new context and nothing else', async () => {
    const open = vi.fn();
    const web = bridge({ open });
    expect(await web.openExternal('https://example.com/docs')).toBe('opened');
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/docs');
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(await web.openExternal(url)).toBe('blocked');
    }
    expect(open).toHaveBeenCalledOnce();
  });

  it('has no save target: exports reach the user as downloads', async () => {
    expect(await bridge().pickSaveTarget()).toBeNull();
  });

  it('has no native menu, and unsubscribing is safe', () => {
    const web = bridge();
    expect(() => {
      web.setMenu();
    }).not.toThrow();
    expect(web.onMenuCommand()).toBeTypeOf('function');
    expect(() => {
      web.onMenuCommand()();
    }).not.toThrow();
  });

  it('shows a notification through the injected function', async () => {
    const show = vi.fn();
    await bridge({ show }).notify({ title: 'T', body: 'B' });
    expect(show).toHaveBeenCalledExactlyOnceWith({ title: 'T', body: 'B' });
  });

  it('answers appInfo from the engine facts it was given', async () => {
    expect(await bridge().appInfo()).toEqual({
      version: '1.0.0',
      mode: 'local',
    });
  });
});

describe('isPlatformBridge', () => {
  const valid: PlatformBridge = {
    kind: 'desktop',
    bridgeVersion: BRIDGE_VERSION,
    pickSaveTarget: () => Promise.resolve(null),
    openExternal: () => Promise.resolve('blocked'),
    notify: () => Promise.resolve(),
    setMenu: () => undefined,
    onMenuCommand: () => () => undefined,
    appInfo: () => Promise.resolve({ version: '1', mode: 'desktop' }),
  };

  it('accepts the bridge shape of version 1', () => {
    expect(isPlatformBridge(valid)).toBe(true);
  });

  it('rejects other versions, unknown kinds and missing methods', () => {
    expect(isPlatformBridge({ ...valid, bridgeVersion: 2 })).toBe(false);
    expect(isPlatformBridge({ ...valid, kind: 'other' })).toBe(false);
    expect(isPlatformBridge({ ...valid, openExternal: undefined })).toBe(false);
    expect(isPlatformBridge(null)).toBe(false);
    expect(isPlatformBridge('bridge')).toBe(false);
  });
});
