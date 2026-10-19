export interface TopicOptions {
  /** The topic id, `namespace.name`, for example `tap.messages`. */
  name: string;
  /** The service module that owns the topic: `svc-tap` or `tap`. */
  module: string;
  flow: string;
  qos: string;
  permission: string;
  /** Required for `latest`, where it is the rate that coalescing runs at. */
  maxHz?: number | string;
  ringItems?: number | string;
  ringBytes?: number | string;
}
