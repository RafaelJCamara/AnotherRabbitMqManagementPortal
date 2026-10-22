import {
  connectionsCreate,
  connectionsTestAmqp,
  connectionsTestHttp,
  connectionsUpdate,
  ConnectionIdSchema,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { CANARY, profileFixture } from '../testing/fixtures';
import {
  emptyValues,
  holdsSecret,
  movedEndpoints,
  toCreateInput,
  toEndpoints,
  toUpdateInput,
  validate,
  valuesFromProfile,
  type FormValues,
} from './form-model';

const CREATE = { kind: 'create' } as const;

function typed(patch: {
  name?: string;
  envClass?: FormValues['envClass'];
  uri?: string;
  sameLogin?: boolean;
  http?: Partial<FormValues['http']>;
  amqp?: Partial<FormValues['amqp']>;
}): FormValues {
  const base = emptyValues();
  return {
    ...base,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.envClass === undefined ? {} : { envClass: patch.envClass }),
    ...(patch.uri === undefined ? {} : { uri: patch.uri }),
    ...(patch.sameLogin === undefined ? {} : { sameLogin: patch.sameLogin }),
    http: { ...base.http, ...patch.http },
    amqp: { ...base.amqp, ...patch.amqp },
  };
}

const LAB = typed({
  name: ' Lab ',
  http: { host: '127.0.0.1', port: '15672', username: 'guest', secret: CANARY },
  amqp: { host: '127.0.0.1', port: '5672' },
});

describe('the connection form model', () => {
  it('AC-3 a filled create form becomes exactly one connections.create input the contract accepts', () => {
    const input = toCreateInput(LAB);
    expect(input).toEqual({
      name: 'Lab',
      envClass: 'dev',
      http: {
        host: '127.0.0.1',
        port: 15672,
        auth: { kind: 'basic', username: 'guest', password: CANARY },
      },
      // The shared login: the management login is the AMQP login.
      amqp: {
        host: '127.0.0.1',
        port: 5672,
        auth: { kind: 'plain', username: 'guest', password: CANARY },
      },
    });
    expect(connectionsCreate.input.safeParse(input).success).toBe(true);
    expect(validate(LAB, CREATE)).toEqual({});
  });

  it('AC-3 empty optional fields are left out so the engine derives them, and a separate AMQP login is sent as typed', () => {
    const input = toCreateInput(
      typed({
        name: 'Two logins',
        envClass: 'staging',
        sameLogin: false,
        http: { host: 'mq.example', username: 'ops', secret: 'one' },
        amqp: { username: 'app', secret: 'two', vhost: '/orders' },
      }),
    );
    expect(input).toEqual({
      name: 'Two logins',
      envClass: 'staging',
      http: {
        host: 'mq.example',
        auth: { kind: 'basic', username: 'ops', password: 'one' },
      },
      amqp: {
        vhost: '/orders',
        auth: { kind: 'plain', username: 'app', password: 'two' },
      },
    });
  });

  it('AC-3 a pasted URI is sent in the uri field and nothing is derived from it by the page', () => {
    const input = toCreateInput(
      typed({
        name: 'From a URI',
        uri: ` amqp://u:${CANARY}@mq.example:5671/v `,
      }),
    );
    expect(input).toEqual({
      name: 'From a URI',
      envClass: 'dev',
      uri: `amqp://u:${CANARY}@mq.example:5671/v`,
    });
    expect(
      validate(typed({ name: 'x', uri: 'amqp://u:p@h/' }), CREATE),
    ).toEqual({});
  });

  it('AC-3 an explicit TLS choice and a none login are sent; the bearer token goes as a token', () => {
    const input = toCreateInput(
      typed({
        name: 'Edge',
        http: {
          host: 'mq',
          tls: true,
          pathPrefix: ' /rabbitmq ',
          auth: 'bearer',
          secret: 'tok',
        },
        amqp: { host: 'mq', tls: true, auth: 'none' },
      }),
    );
    expect(input.http).toEqual({
      host: 'mq',
      tls: true,
      pathPrefix: '/rabbitmq',
      auth: { kind: 'bearer', token: 'tok' },
    });
    expect(input.amqp).toEqual({
      host: 'mq',
      tls: true,
      auth: { kind: 'none' },
    });
    expect(connectionsCreate.input.safeParse(input).success).toBe(true);
  });

  it('AC-5 the draft of a test is the same endpoints the create would send, and both tests accept it', () => {
    const draft = toEndpoints(LAB);
    expect(draft).toEqual({
      http: toCreateInput(LAB).http,
      amqp: toCreateInput(LAB).amqp,
    });
    expect(connectionsTestHttp.input.safeParse({ draft }).success).toBe(true);
    expect(connectionsTestAmqp.input.safeParse({ draft }).success).toBe(true);
  });

  it('AC-3 says which field is wrong before the engine does', () => {
    expect(validate(emptyValues(), CREATE)).toEqual({
      name: 'required',
      'http.host': 'required',
      'http.username': 'required',
      'http.secret': 'required',
    });
    const bad = typed({
      name: 'x'.repeat(81),
      http: {
        host: 'a b',
        port: '70000',
        pathPrefix: 'no-slash',
        username: '',
        secret: '',
      },
      amqp: {
        host: 'mq',
        port: 'abc',
        vhost: 'a\u0001b',
        username: 'u',
        secret: '',
      },
      sameLogin: false,
    });
    expect(validate(bad, CREATE)).toEqual({
      name: 'tooLong',
      'http.host': 'invalid',
      'http.port': 'port',
      'http.pathPrefix': 'pathPrefix',
      'http.username': 'required',
      'http.secret': 'required',
      'amqp.port': 'port',
      'amqp.vhost': 'invalid',
      'amqp.secret': 'required',
    });
  });

  it('AC-3 a URI stands in for the logins and the host, and the none login needs none', () => {
    expect(validate(typed({ name: 'a', uri: 'amqp://h/' }), CREATE)).toEqual(
      {},
    );
    expect(
      validate(
        typed({
          name: 'a',
          http: { host: 'h', auth: 'none' },
          amqp: { auth: 'none' },
        }),
        CREATE,
      ),
    ).toEqual({});
  });

  it('AC-4 a loaded profile gives empty secret fields and sends no secret unless one is typed', () => {
    const profile = profileFixture('c1');
    const values = valuesFromProfile(profile);
    expect(values.http.secret).toBe('');
    expect(values.amqp.secret).toBe('');
    expect(values.uri).toBe('');
    expect(holdsSecret(values)).toBe(false);
    const update = toUpdateInput(
      ConnectionIdSchema.parse('c1'),
      { ...values, name: 'Renamed' },
      profile,
    );
    expect(update).toEqual({
      cid: 'c1',
      name: 'Renamed',
      envClass: 'dev',
      http: {
        host: '127.0.0.1',
        port: 15672,
        tls: false,
        pathPrefix: null,
        auth: { kind: 'basic', username: 'guest' },
      },
      amqp: {
        host: '127.0.0.1',
        port: 5672,
        tls: false,
        vhost: '/',
        auth: { kind: 'plain', username: 'guest' },
      },
    });
    expect(JSON.stringify(update)).not.toMatch(/password|token/);
    expect(connectionsUpdate.input.safeParse(update).success).toBe(true);
  });

  it('AC-4 a typed secret is sent once, in the field of its protocol, and holdsSecret says one is held', () => {
    const profile = profileFixture('c1');
    const base = valuesFromProfile(profile);
    const values: FormValues = {
      ...base,
      http: { ...base.http, secret: CANARY },
    };
    expect(holdsSecret(values)).toBe(true);
    const update = toUpdateInput(
      ConnectionIdSchema.parse('c1'),
      values,
      profile,
    );
    expect(update.http?.auth).toEqual({
      kind: 'basic',
      username: 'guest',
      password: CANARY,
    });
    expect(update.amqp?.auth).toEqual({ kind: 'plain', username: 'guest' });
    expect(holdsSecret(typed({ uri: 'amqp://h/' }))).toBe(true);
  });

  it('AC-4 moving an endpoint asks for its secret again, as the engine does (OQ-444)', () => {
    const profile = profileFixture('c1');
    const base = valuesFromProfile(profile);
    const moved: FormValues = {
      ...base,
      http: { ...base.http, host: 'other.example' },
    };
    expect(movedEndpoints(moved, profile)).toEqual({ http: true, amqp: false });
    const mode = { kind: 'edit', profile } as const;
    expect(validate(moved, mode)).toEqual({ 'http.secret': 'secretAgain' });
    expect(
      validate({ ...moved, http: { ...moved.http, secret: 'new' } }, mode),
    ).toEqual({});
    // A profile with no stored secret has nothing to carry over.
    const bare = profileFixture('c2', { secretsSet: false });
    expect(
      validate(
        {
          ...valuesFromProfile(bare),
          http: { ...valuesFromProfile(bare).http, port: '1' },
        },
        { kind: 'edit', profile: bare },
      ),
    ).toEqual({});
    // Nothing moved, nothing asked.
    expect(movedEndpoints(base, profile)).toEqual({ http: false, amqp: false });
    expect(validate(base, mode)).toEqual({});
  });

  it('AC-4 changing the kind of a login needs the new login; removing it needs none', () => {
    const profile = profileFixture('c1');
    const base = valuesFromProfile(profile);
    const mode = { kind: 'edit', profile } as const;
    expect(
      validate({ ...base, http: { ...base.http, auth: 'bearer' } }, mode),
    ).toEqual({ 'http.secret': 'required' });
    expect(
      validate({ ...base, http: { ...base.http, auth: 'none' } }, mode),
    ).toEqual({});
  });

  it('AC-7 the class is a plain field of the input; the form starts on dev and offers all five', () => {
    expect(emptyValues().envClass).toBe('dev');
    expect(toCreateInput({ ...LAB, envClass: 'prod' }).envClass).toBe('prod');
  });
});
