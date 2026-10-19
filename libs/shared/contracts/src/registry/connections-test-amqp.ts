// connections.test-amqp: test the AMQP endpoint on its own, of a saved or an unsaved profile. It
// opens a connection to the vhost and closes it: no channel is used, no message is touched.
import { defineAction } from '../kit/define-action.ts';
import { AmqpTestOutputSchema, TestTargetInputSchema } from './connections.ts';

export const ConnectionsTestAmqpInputSchema = TestTargetInputSchema;

export const ConnectionsTestAmqpOutputSchema = AmqpTestOutputSchema;

export const connectionsTestAmqp = defineAction({
  id: 'connections.test-amqp',
  kind: 'query',
  summary: 'Test the AMQP endpoint of a saved or unsaved profile, on its own',
  input: ConnectionsTestAmqpInputSchema,
  output: ConnectionsTestAmqpOutputSchema,
  permission: 'connection.manage',
  risk: 'none',
  planning: 'none',
  audit: 'outcome',
  target: (input) =>
    input.cid === undefined ? {} : { connectionId: input.cid },
  http: { method: 'POST', path: '/connections/test-amqp' },
  since: '1.0',
});
