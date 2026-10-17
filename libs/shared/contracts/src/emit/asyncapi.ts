// AsyncAPI 3.0 from the topic registry and the live frames (ADR-003, ADR-005). One multiplexed
// channel carries every subscription; each topic also gets a channel that documents its `sub`
// params and its item payload. The engine receives ClientFrames and sends ServerFrames and items.
import { ClientFrameSchema, ServerFrameSchema } from '../live-frames.ts';
import { assertRegistry, type Registry } from '../kit/invariants.ts';
import { SPEC_VERSION, schemaOf, type JsonObject } from './json-schema.ts';

/** `a.b` becomes `a_b` so the id is a safe component and operation key. */
const key = (id: string) => id.replaceAll(/[^A-Za-z0-9]/g, '_');

export function emitAsyncApi(registry: Registry): JsonObject {
  assertRegistry(registry);
  const channels: JsonObject = {
    live: {
      address: '/api/v1/live',
      description:
        'The multiplexed live channel (WebSocket, or the desktop MessagePort with the same frames).',
      messages: {
        ClientFrame: { $ref: '#/components/messages/ClientFrame' },
        ServerFrame: { $ref: '#/components/messages/ServerFrame' },
      },
    },
  };
  const operations: JsonObject = {
    receiveClientFrame: {
      action: 'receive',
      channel: { $ref: '#/channels/live' },
      messages: [{ $ref: '#/channels/live/messages/ClientFrame' }],
    },
    sendServerFrame: {
      action: 'send',
      channel: { $ref: '#/channels/live' },
      messages: [{ $ref: '#/channels/live/messages/ServerFrame' }],
    },
  };
  const messages: JsonObject = {
    ClientFrame: {
      name: 'ClientFrame',
      payload: schemaOf(ClientFrameSchema, 'input'),
    },
    ServerFrame: {
      name: 'ServerFrame',
      payload: schemaOf(ServerFrameSchema, 'output'),
    },
  };

  for (const topic of [...registry.topics].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const name = key(topic.id);
    const channel: JsonObject = {
      address: topic.id,
      description: `Topic ${topic.id}: subscribe with 'sub' and the params message; items arrive in data, snapshot or delta frames.`,
      messages: {
        params: {
          name: `${name}.params`,
          payload: schemaOf(topic.params, 'input'),
        },
        item: { name: `${name}.item`, payload: schemaOf(topic.item, 'output') },
      },
      'x-qos': topic.qos,
      'x-flow': topic.flow,
      'x-permission': topic.permission,
      'x-ring': { ...topic.ring },
    };
    if (topic.maxHz !== undefined) channel['x-max-hz'] = topic.maxHz;
    channels[name] = channel;
    operations[`publish_${name}`] = {
      action: 'send',
      channel: { $ref: `#/channels/${name}` },
      messages: [{ $ref: `#/channels/${name}/messages/item` }],
    };
  }

  return {
    asyncapi: '3.0.0',
    info: {
      title: '<Product> engine live API',
      version: SPEC_VERSION,
      description:
        'Generated from the @app/contracts topic registry (ADR-003). Do not edit by hand: run `pnpm nx run contracts:api-docs`.',
    },
    channels,
    operations,
    components: { messages },
  };
}
