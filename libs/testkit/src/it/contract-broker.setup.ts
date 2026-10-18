// Vitest global setup of the AMQP 0-9-1 contract suite (M0-28): starts the one lab broker the
// suite runs against and hands its addresses to the test workers in `CONTRACT_BROKER`.
//
// The specs live in `libs/engine/adapter-amqp091/contract` and may not import the testkit (a
// `type:adapter` project may not import `type:test`, OQ-187), so the broker reaches them through
// the environment, as plain data. `run-contract.ts` sets `CONTRACT_BROKER_VERSION`.
import { startBroker } from '../broker-lab.ts';

export interface ContractBroker {
  readonly version: string;
  readonly digest: string;
  /** `amqp://127.0.0.1:<port>` */
  readonly amqp: string;
  /** `http://127.0.0.1:<port>` */
  readonly http: string;
  /** The docker container, for `docker exec <container> rabbitmqctl ...`. */
  readonly container: string;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
}

export default async function setup(): Promise<() => Promise<void>> {
  const version = process.env.CONTRACT_BROKER_VERSION;
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      'CONTRACT_BROKER_VERSION must be an exact version; run the suite with `pnpm nx run adapter-amqp091:contract`',
    );
  }
  const broker = await startBroker({ version, variant: 'plain' });
  if (broker.container === undefined) {
    await broker.stop();
    throw new Error('the lab broker did not report its container');
  }
  const handle: ContractBroker = {
    version: broker.version,
    digest: broker.digest,
    amqp: broker.amqp,
    http: broker.http,
    container: broker.container,
    credentials: broker.credentials,
  };
  process.env.CONTRACT_BROKER = JSON.stringify(handle);
  return async () => {
    delete process.env.CONTRACT_BROKER;
    await broker.stop();
  };
}
