// Team mode (Docker or Helm, blueprint 1.3) arrives with M3: Postgres, OIDC, role authorisation and
// the Vault or KMS key wraps. Until then it refuses to start, before it opens a file, takes a lock
// or binds a socket, so a half-configured team server cannot come up with the local mode's
// single-user authorisation.
import { ModeRefusedError, type ModeFactory } from './types.ts';

export const createTeamMode: ModeFactory = () =>
  Promise.reject(
    new ModeRefusedError(
      'Team mode is not available in this build: the team server arrives with M3.',
    ),
  );
