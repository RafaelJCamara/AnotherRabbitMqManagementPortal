// The translations of the @cloudamqp/amqp-client shim, without a broker: what the adapter reads
// from an error or a value must come out the same whichever library produced it. The broker-backed
// half of the contract is in the `*.contract.spec.ts` files (`adapter-amqp091:contract`).
import { describe, expect, it } from 'vitest';

import { mapAmqplibError } from '../src/errors.ts';
import {
  cloudamqpDriver,
  fromLibraryProperties,
  fromLibraryTable,
  toLibraryProperties,
  toLibraryTable,
  translateError,
} from './cloudamqp-driver.ts';

describe('the cloudamqp shim: errors as the adapter reads them', () => {
  it('AC-1 a channel closed by the broker maps like amqplib: NOT_FOUND on a channel, reply code kept', () => {
    const library = new Error(
      "channel 2 closed: NOT_FOUND - no queue 'q' in vhost '/' (404)",
    );
    const mapped = mapAmqplibError(
      translateError(library),
      'a passive declare',
    );
    expect(mapped).toMatchObject({
      code: 'NOT_FOUND',
      reason: 'channel-closed',
      broker: { protocol: 'amqp091', code: 404 },
    });
  });

  it('AC-1 a refused login in the handshake maps to auth-refused', () => {
    const library = new Error(
      'connection closed: ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN. (403)',
    );
    const mapped = mapAmqplibError(
      translateError(library, 'handshake'),
      'connecting',
    );
    expect(mapped).toMatchObject({
      reason: 'auth-refused',
      code: 'UNAUTHENTICATED',
    });
  });

  it('AC-1 a connection the broker forces closed is retryable and BROKER_UNREACHABLE', () => {
    const library = new Error(
      'connection closed: CONNECTION_FORCED - Closed via management plugin (320)',
    );
    const mapped = mapAmqplibError(translateError(library), 'the connection');
    expect(mapped).toMatchObject({
      code: 'BROKER_UNREACHABLE',
      retryable: true,
      broker: { code: 320 },
    });
  });

  it('AC-1 an operation on a closed channel is the "already closed" error, and other errors pass through', () => {
    const closed = translateError(new Error('Channel is closed'));
    expect(mapAmqplibError(closed, 'a get')).toMatchObject({
      reason: 'channel-closed',
    });
    const other = new Error('Socket closed');
    expect(translateError(other)).toBe(other);
    expect(mapAmqplibError(other, 'the connection')).toMatchObject({
      reason: 'connection-closed',
    });
  });
});

describe('the cloudamqp shim: values as the adapter writes and reads them', () => {
  it('AC-1 typed header values become library values: long as int64, timestamp as a date, nested tables and arrays', () => {
    const table = toLibraryTable({
      s: 'text',
      flag: true,
      n: { '!': 'long', value: 7 },
      big: { '!': 'long', value: 2 ** 40 },
      small: { '!': 'short', value: 3 },
      when: { '!': 'timestamp', value: 1_700_000_000 },
      list: ['a', { '!': 'int', value: 5 }],
      nested: { k: false },
    });
    expect(table).toEqual({
      s: 'text',
      flag: true,
      n: 7n,
      big: BigInt(2 ** 40),
      small: 3,
      when: new Date(1_700_000_000_000),
      list: ['a', 5],
      nested: { k: false },
    });
  });

  it('AC-1 a decimal header cannot be written and says so', () => {
    expect(() =>
      toLibraryTable({
        d: { '!': 'decimal', value: { places: 2, digits: 5 } },
      }),
    ).toThrow(/cannot write a decimal/);
  });

  it('AC-1 values read from the library come back in amqplib notation', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const read = fromLibraryTable({
      when: new Date(1_700_000_000_000),
      raw: bytes,
      list: [new Date(2_000), 'x'],
      nested: { n: 1 },
    });
    expect(read).toEqual({
      when: { '!': 'timestamp', value: 1_700_000_000 },
      raw: Buffer.from([1, 2, 3]),
      list: [{ '!': 'timestamp', value: 2 }, 'x'],
      nested: { n: 1 },
    });
    // A copy, not a view into the library's frame buffer.
    expect(Buffer.isBuffer(read.raw)).toBe(true);
  });

  it('AC-1 publish options become properties without the routing flag, and a timestamp stays in seconds both ways', () => {
    const properties = toLibraryProperties({
      mandatory: true,
      contentType: 'text/plain',
      deliveryMode: 2,
      timestamp: 1_700_000_000,
      headers: { h: { '!': 'long', value: 1 } },
    });
    expect(properties).toEqual({
      contentType: 'text/plain',
      deliveryMode: 2,
      timestamp: new Date(1_700_000_000_000),
      headers: { h: 1n },
    });
    expect(
      fromLibraryProperties({
        contentType: 'text/plain',
        timestamp: new Date(1_700_000_000_000),
        headers: { h: 1 },
      }),
    ).toEqual({
      contentType: 'text/plain',
      timestamp: 1_700_000_000,
      headers: { h: 1 },
    });
  });
});

describe('the cloudamqp shim: logins', () => {
  it('AC-1 PLAIN is `\\0user\\0password` and EXTERNAL is an empty response', () => {
    const plain = cloudamqpDriver.plain('guest', 'pw');
    expect(plain.mechanism).toBe('PLAIN');
    expect(plain.response().toString('utf8')).toBe('\0guest\0pw');
    const external = cloudamqpDriver.external();
    expect(external.mechanism).toBe('EXTERNAL');
    expect(external.response()).toHaveLength(0);
  });

  it('AC-1 EXTERNAL is refused before anything is dialled: 4.1.1 offers PLAIN only (expected skip of the contract)', async () => {
    await expect(
      cloudamqpDriver.connect(
        {
          protocol: 'amqp',
          hostname: '192.0.2.1',
          port: 1,
          vhost: '%2F',
          heartbeat: 30,
        },
        {
          path: '/nonexistent',
          timeout: 1_000,
          noDelay: true,
          clientProperties: {},
          credentials: cloudamqpDriver.external(),
        },
      ),
    ).rejects.toThrow(/PLAIN only, not EXTERNAL/);
  });
});
