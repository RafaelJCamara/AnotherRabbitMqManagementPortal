import type { KeyObject } from 'node:crypto';

import type { Variant } from './args.ts';

export type { Variant } from './args.ts';

export interface StartBrokerOptions {
  /** An exact version from testing/broker-lab/versions.json, for example `4.3.6`. */
  readonly version: string;
  /** `plain` (default), `tls` (adds 5671, 15671, 5551) or `oauth` (oauth2 backend with a lab key). */
  readonly variant?: Variant;
  /** One broker (default) or the 3-node cluster behind HAProxy with Toxiproxy (plain only). */
  readonly nodes?: 1 | 3;
  /** Build the image first (default true; Docker caches the layers). */
  readonly build?: boolean;
  /** How long to wait for the broker to answer the management API. Default 180 seconds. */
  readonly readyTimeoutMs?: number;
}

/** What a running lab broker exposes. Every address is on the loopback interface. */
export interface BrokerHandle {
  readonly version: string;
  readonly variant: Variant;
  readonly nodes: 1 | 3;
  /** Pinned digest of the official image the lab image is built on (recorded as evidence). */
  readonly digest: string;
  /** `amqp://127.0.0.1:<port>` */
  readonly amqp: string;
  /** `amqps://127.0.0.1:<port>`, TLS variant only. */
  readonly amqps?: string;
  /** `http://127.0.0.1:<port>`; the management API is at `/api`. */
  readonly http: string;
  /** `https://127.0.0.1:<port>`, TLS variant only. */
  readonly https?: string;
  /**
   * `rabbitmq-stream://127.0.0.1:<port>`. The port is the same on the host and in the address the
   * broker advertises, so a stream client that follows the metadata reaches it.
   */
  readonly stream: string;
  /** `rabbitmq-stream+tls://127.0.0.1:<port>`, TLS variant only (the advertised port is not set). */
  readonly streamTls?: string;
  /** `http://127.0.0.1:<port>/metrics` */
  readonly prometheus: string;
  readonly credentials: {
    readonly username: string;
    readonly password: string;
  };
  /** The certificate to trust, TLS variant only. */
  readonly tls?: { readonly ca: string };
  /** The signing key and resource server, OAuth variant only (use `signLabToken`). */
  readonly oauth?: {
    readonly privateKey: KeyObject;
    readonly keyId: string;
    readonly resourceServerId: string;
  };
  /** Toxiproxy in front of HAProxy, 3-node only. */
  readonly toxiproxy?: {
    readonly api: string;
    readonly amqp: string;
    readonly management: string;
  };
  /** Removes the containers (and the compose project), volumes and temporary files. */
  stop(): Promise<void>;
}
