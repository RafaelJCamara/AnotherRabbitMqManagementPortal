// The calls the connections pages make, in one place (M0-52, R12): what they send is what the contract takes, an
// engine failure is the rejection (an `EngineProblemError`, kept as received), and every change refreshes the
// shared directory so the list and the switcher show it. Nothing here keeps a secret: inputs pass through.
import { Injectable, inject } from '@angular/core';
import {
  connectionsCreate,
  connectionsDelete,
  connectionsGet,
  connectionsTestAmqp,
  connectionsTestHttp,
  connectionsUpdate,
  probeRun,
  profileGet,
  type ConnectionId,
  type ConnectionProfile,
  type InputOf,
  type OutputOf,
} from '@app/contracts';
import { ConnectionDirectory, EngineApi } from '@app/ui-data';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ConnectionsService {
  readonly #api = inject(EngineApi);
  readonly #directory = inject(ConnectionDirectory);

  async get(cid: ConnectionId): Promise<ConnectionProfile> {
    const out = await firstValueFrom(this.#api.call(connectionsGet, { cid }));
    return out.profile;
  }

  async create(
    input: InputOf<typeof connectionsCreate>,
  ): Promise<ConnectionProfile> {
    const out = await firstValueFrom(this.#api.call(connectionsCreate, input));
    await this.#directory.refresh();
    return out.profile;
  }

  async update(
    input: InputOf<typeof connectionsUpdate>,
  ): Promise<ConnectionProfile> {
    const out = await firstValueFrom(this.#api.call(connectionsUpdate, input));
    await this.#directory.refresh();
    return out.profile;
  }

  async remove(cid: ConnectionId): Promise<void> {
    await firstValueFrom(this.#api.call(connectionsDelete, { cid }));
    await this.#directory.refresh();
  }

  testHttp(
    target: InputOf<typeof connectionsTestHttp>,
  ): Promise<OutputOf<typeof connectionsTestHttp>> {
    return firstValueFrom(this.#api.call(connectionsTestHttp, target));
  }

  testAmqp(
    target: InputOf<typeof connectionsTestAmqp>,
  ): Promise<OutputOf<typeof connectionsTestAmqp>> {
    return firstValueFrom(this.#api.call(connectionsTestAmqp, target));
  }

  probe(cid: ConnectionId): Promise<OutputOf<typeof probeRun>> {
    return firstValueFrom(this.#api.call(probeRun, { cid }));
  }

  profile(cid: ConnectionId): Promise<OutputOf<typeof profileGet>> {
    return firstValueFrom(this.#api.call(profileGet, { cid }));
  }
}
