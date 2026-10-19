export interface ActionOptions {
  /** `namespace.verb`, for example `queues.purge`. */
  name: string;
  /** The service module that owns the action: `svc-admin` or `admin`. */
  module: string;
  kind: string;
  /** `'POST /connections/{cid}/queues/{qkey}/purge'`. Omit for an action with no HTTP route. */
  http?: string;
  permission: string;
  risk?: string;
  planning?: string;
  mcp?: string;
  cli?: string;
  summary?: string;
  since?: string;
  /** The UI feature that gets the command stub, or `none`. Defaults to the module's stem. */
  feature?: string;
}
