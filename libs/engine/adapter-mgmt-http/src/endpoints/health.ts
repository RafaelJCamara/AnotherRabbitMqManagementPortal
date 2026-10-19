// Health checks (`/api/health/checks/...`) and definitions export. A failing check answers 503
// with `{"status":"failed","reason":...}`, which the client reports as `unavailable` with the
// reason in `broker.text`; a passing one answers 200 `{"status":"ok"}`.
import { z } from 'zod';

import { defineEndpoint } from './define.ts';

export const HealthResultSchema = z.object({
  status: z.string(),
  reason: z.string().optional(),
});
export type HealthResult = z.infer<typeof HealthResultSchema>;

function check(id: string, template: string) {
  return defineEndpoint({
    id: `health.${id}`,
    template: `/api/health/checks/${template}`,
    schema: HealthResultSchema,
  });
}

export const health = {
  alarms: check('alarms', 'alarms'),
  localAlarms: check('localAlarms', 'local-alarms'),
  virtualHosts: check('virtualHosts', 'virtual-hosts'),
  nodeIsQuorumCritical: check(
    'nodeIsQuorumCritical',
    'node-is-quorum-critical',
  ),
  portListener: check('portListener', 'port-listener/{port}'),
  protocolListener: check('protocolListener', 'protocol-listener/{protocol}'),
  certificateExpiration: check(
    'certificateExpiration',
    'certificate-expiration/{within}/{unit}',
  ),
};

const Items = z.array(z.record(z.string(), z.unknown()));

/** The top level of a definitions export; the items are read by the topology import, not here. */
export const DefinitionsSchema = z.object({
  rabbit_version: z.string().optional(),
  rabbitmq_version: z.string().optional(),
  product_name: z.string().optional(),
  vhosts: Items.optional(),
  users: Items.optional(),
  permissions: Items.optional(),
  queues: Items.optional(),
  exchanges: Items.optional(),
  bindings: Items.optional(),
  policies: Items.optional(),
  operator_policies: Items.optional(),
  parameters: Items.optional(),
  global_parameters: Items.optional(),
});
export type MgmtDefinitions = z.infer<typeof DefinitionsSchema>;

/** Large: read with `MgmtReadPort.stream` and parse the chunks, not with `get`. */
export const definitions = {
  all: defineEndpoint({
    id: 'definitions.all',
    template: '/api/definitions',
    schema: DefinitionsSchema,
  }),
  inVhost: defineEndpoint({
    id: 'definitions.inVhost',
    template: '/api/definitions/{vhost}',
    schema: DefinitionsSchema,
  }),
};
