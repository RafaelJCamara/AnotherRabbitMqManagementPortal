// What every mode file receives and returns (ADR-001). A mode swaps adapters and nothing else: the
// profile is data for `composeEngine`, so the rest of the engine never learns the mode's name.
import type { Logger } from '@app/kernel';

import type { ModeProfile } from '../compose-core.ts';
import type { EngineArgs } from '../entry/args.ts';
import type { CtlPort } from '../entry/ctl.ts';

export interface ModeHost {
  readonly args: EngineArgs;
  /** The supervisor's channel, when there is one (desktop main; any parent that forked us). */
  readonly ctl: CtlPort | undefined;
  /** The directory of the running bundle, to find the web build next to it. */
  readonly bundleDir: string;
  readonly logger: Logger;
}

export interface ModeBoot {
  readonly profile: ModeProfile;
  /**
   * The line a person copies to open the engine, from the address it bound. It carries the launch
   * token in the URL fragment (which is never sent to a server), so it goes to the console once and
   * never to the logger.
   */
  readonly launchUrl?: (address: { host: string; port: number }) => string;
}

export type ModeFactory = (host: ModeHost) => Promise<ModeBoot>;

/** The mode cannot start in this build; the message is safe to print. */
export class ModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeRefusedError';
  }
}
