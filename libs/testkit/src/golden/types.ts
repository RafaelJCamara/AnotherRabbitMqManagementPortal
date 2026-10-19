// Shapes shared by the golden-fixture recorder (M0-25) and its specs. The manifest is what a reader
// (the `test-golden` specs of adapter-mgmt-http, a person reviewing a diff) learns about a recording
// without a broker: which product and version answered, from which image, in which statistics
// mode, from which seed, and what every file is.
import type { Product } from '@app/domain-model';

/** `default` is a product with no statistics switch (LavinMQ). */
export type StatsMode = 'stats-on' | 'stats-off' | 'default';

export type EntryKind = 'endpoint' | 'error-probe' | 'prometheus';

export type ProbeAuth =
  | 'guest'
  | 'wrong-password'
  | 'unknown-user'
  | 'no-management-tag';

export type QueryValue = string | number | boolean;

export interface FixtureEntry {
  /** An endpoint id of the adapter catalogue (`queues.list`), `error.<name>` or `prometheus.<name>`. */
  readonly id: string;
  readonly kind: EntryKind;
  readonly method: 'GET' | 'POST';
  /** The path as the caller hands it to the client, scrubbed. */
  readonly path: string;
  /** The query as the caller hands it to the client (before the client shapes it). */
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** The request body as it went out on the wire (for `POST`), scrubbed. */
  readonly body?: unknown;
  /** Path and query as the adapter sends them for this broker profile (for Prometheus: as sent). */
  readonly sent: string;
  readonly auth: ProbeAuth;
  /** The HTTP status the broker answered. */
  readonly status: number;
  /** File name next to the manifest (`.json` for a JSON answer, `.txt` or `.prom` otherwise). */
  readonly file: string;
  readonly bytes: number;
  /** For a JSON answer: whether it is the paged envelope (`items`, `page`, ...) and not a bare array. */
  readonly envelope?: boolean;
}

export interface FixtureManifest {
  readonly schema: 1;
  readonly kind: 'mgmt' | 'prometheus';
  readonly product: Product;
  /** What the broker itself reported (`rabbitmq_version`, `lavinmq_version`). */
  readonly version: string;
  /** Image reference without the digest, for example `rabbitmq:4.3.6-management`. */
  readonly image: string;
  /** The digest the image was pinned to. */
  readonly digest: string;
  readonly stats: 'on' | 'off' | 'n/a';
  /** Broker configuration added to the lab defaults for this recording. */
  readonly brokerConfig: readonly string[];
  readonly seed: {
    readonly id: string;
    /** SHA-256 of `testing/fixtures/seed.json` as recorded. */
    readonly sha256: string;
    /** Optional seed steps the broker refused, with the status it answered. */
    readonly refused: readonly string[];
  };
  /** The recorder that wrote this, so a reader knows where to look. */
  readonly recorder: string;
  readonly entries: readonly FixtureEntry[];
  /** Endpoints of the catalogue that were not requested in this recording, and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** One recording as files, relative to the fixtures root. */
export interface RecordedFiles {
  /** `mgmt/<target>/<mode>/manifest.json` and the answers next to it. */
  readonly files: ReadonlyMap<string, string>;
  readonly directories: readonly string[];
}
