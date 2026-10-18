// PlatformBridge v1 (contracts/bridge.ts): what the shell offers the UI. On the desktop the preload
// supplies it; in the browser `WebBridge` does. A feature codes against the interface only.
import { InjectionToken } from '@angular/core';
import {
  BRIDGE_VERSION,
  type AppInfo,
  type OpenExternalResult,
  type PlatformBridge,
  type SaveTarget,
} from '@app/contracts';

export const PLATFORM_BRIDGE = new InjectionToken<PlatformBridge>(
  'PLATFORM_BRIDGE',
);

const BRIDGE_METHODS = [
  'pickSaveTarget',
  'openExternal',
  'notify',
  'setMenu',
  'onMenuCommand',
  'appInfo',
] as const;

/** True for an object that has the bridge v1 shape. Checks the version, not what the methods do. */
export function isPlatformBridge(value: unknown): value is PlatformBridge {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.kind === 'desktop' || candidate.kind === 'web') &&
    candidate.bridgeVersion === BRIDGE_VERSION &&
    BRIDGE_METHODS.every((name) => typeof candidate[name] === 'function')
  );
}

export interface WebBridgeOptions {
  readonly appInfo: () => Promise<AppInfo>;
  /** Opens a URL in a new browsing context without access to this page. */
  readonly open?: (url: string) => void;
  /** Shows a system notification when the user already allowed it; otherwise does nothing. */
  readonly show?: (notification: { title: string; body: string }) => void;
}

/** Only https links leave the app from the browser. The link opens with `noopener,noreferrer`. */
const isOpenable = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

function defaultOpen(url: string): void {
  globalThis.open(url, '_blank', 'noopener,noreferrer');
}

function defaultShow(notification: { title: string; body: string }): void {
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    new Notification(notification.title, { body: notification.body });
  }
}

/** The bridge of the browser build. There is no native menu, no save dialog and no deep link. */
export class WebBridge implements PlatformBridge {
  readonly kind = 'web';
  readonly bridgeVersion = BRIDGE_VERSION;
  readonly #options: WebBridgeOptions;

  constructor(options: WebBridgeOptions) {
    this.#options = options;
  }

  /**
   * A browser cannot hand the engine a file path, so there is no save target. Exports reach the
   * user as downloads instead, and the caller falls back to that when this returns null.
   */
  pickSaveTarget(): Promise<SaveTarget | null> {
    return Promise.resolve(null);
  }

  openExternal(url: string): Promise<OpenExternalResult> {
    if (!isOpenable(url)) return Promise.resolve('blocked');
    (this.#options.open ?? defaultOpen)(url);
    return Promise.resolve('opened');
  }

  notify(notification: { title: string; body: string }): Promise<void> {
    (this.#options.show ?? defaultShow)(notification);
    return Promise.resolve();
  }

  setMenu(): void {
    // The browser has no native menu; the command palette is the only menu.
  }

  onMenuCommand(): () => void {
    return () => undefined;
  }

  appInfo(): Promise<AppInfo> {
    return this.#options.appInfo();
  }
}
