export interface JobOptions {
  /** The job type, `namespace.name`, for example `queues.purge-many`. */
  name: string;
  /** The service module that owns the job: `svc-admin` or `admin`. */
  module: string;
  /** Can the job continue from a saved checkpoint after an interruption? Default true. */
  resumable?: boolean;
}
