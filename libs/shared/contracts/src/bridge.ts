// PlatformBridge v1: what the shell (desktop preload or the browser) offers the UI. The UI codes
// against this interface only; ui-platform supplies the desktop and web implementations.
import { z } from 'zod';
import { EngineModeSchema } from './config/env.ts';

export const BRIDGE_VERSION = 1;

export const SaveTargetSchema = z.strictObject({ fileToken: z.string() });
export type SaveTarget = z.infer<typeof SaveTargetSchema>;

export const OpenExternalResultSchema = z.enum([
  'opened',
  'blocked',
  'cancelled',
]);
export type OpenExternalResult = z.infer<typeof OpenExternalResultSchema>;

export const AppInfoSchema = z.strictObject({
  version: z.string(),
  mode: EngineModeSchema,
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export interface PlatformBridge {
  readonly kind: 'desktop' | 'web';
  readonly bridgeVersion: typeof BRIDGE_VERSION;
  /** Desktop only: asks main for the one engine MessagePort of this page load. */
  requestEnginePort?(): void;
  /** Large exports never cross the port: the engine writes to the target this token names. */
  pickSaveTarget(options: {
    suggestedName: string;
  }): Promise<SaveTarget | null>;
  openExternal(url: string): Promise<OpenExternalResult>;
  notify(notification: { title: string; body: string }): Promise<void>;
  setMenu(menu: unknown): void;
  onMenuCommand(listener: (commandId: string) => void): () => void;
  onDeepLink?(listener: (path: string) => void): () => void;
  appInfo(): Promise<AppInfo>;
}
