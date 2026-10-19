// connections.test-http: test the management HTTP endpoint on its own, of a saved or an unsaved
// profile. A failed test is an answer (`ok: false` with a specific cause), not an error.
import { defineAction } from '../kit/define-action.ts';
import { HttpTestOutputSchema, TestTargetInputSchema } from './connections.ts';

export const ConnectionsTestHttpInputSchema = TestTargetInputSchema;

export const ConnectionsTestHttpOutputSchema = HttpTestOutputSchema;

export const connectionsTestHttp = defineAction({
  id: 'connections.test-http',
  kind: 'query',
  summary:
    'Test the management HTTP endpoint of a saved or unsaved profile, on its own',
  input: ConnectionsTestHttpInputSchema,
  output: ConnectionsTestHttpOutputSchema,
  permission: 'connection.manage',
  risk: 'none',
  planning: 'none',
  // It dials out with a credential, so the outcome is recorded; it changes nothing.
  audit: 'outcome',
  target: (input) =>
    input.cid === undefined ? {} : { connectionId: input.cid },
  // POST because a draft carries credentials, and a secret never travels in a URL (I-10).
  http: { method: 'POST', path: '/connections/test-http' },
  since: '1.0',
});
