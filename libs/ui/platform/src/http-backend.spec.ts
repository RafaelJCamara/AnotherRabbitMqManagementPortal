import {
  HttpBackend,
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
} from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ENGINE_TRANSPORT,
  TransportError,
  type EngineTransport,
  type LiveChannel,
  type TransportRequest,
  type TransportResponse,
} from './engine-transport';
import { EngineTransportHttpBackend } from './http-backend';
import { MessagePortTransport } from './messageport-transport';
import {
  FakeEngine,
  createFakePort,
  jsonResponse,
  problemResponse,
  tick,
} from './testing';

type Handler = (
  request: TransportRequest,
  signal: AbortSignal | undefined,
) => Promise<TransportResponse>;

/** A transport that records requests and answers with the handler. */
function stubTransport(handler: Handler): EngineTransport & {
  readonly seen: TransportRequest[];
  readonly signals: (AbortSignal | undefined)[];
} {
  const seen: TransportRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    kind: 'http',
    seen,
    signals,
    request: (request, signal) => {
      seen.push(request);
      signals.push(signal);
      return handler(request, signal);
    },
    openLive: (): LiveChannel => {
      throw new Error('not used');
    },
  };
}

function client(transport: EngineTransport): HttpClient {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      { provide: ENGINE_TRANSPORT, useValue: transport },
      { provide: HttpBackend, useExisting: EngineTransportHttpBackend },
    ],
  });
  return TestBed.inject(HttpClient);
}

const reply = (
  status: number,
  body?: string | ArrayBuffer,
  headers: Record<string, string> = {},
): Promise<TransportResponse> =>
  Promise.resolve({
    status,
    headers,
    ...(body === undefined ? {} : { body }),
  });

describe('EngineTransportHttpBackend', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  it('answers an HttpClient call through a real MessagePort transport', async () => {
    const engine = new FakeEngine({
      handler: () => jsonResponse(200, { engineVersion: '1.2.3' }),
    });
    const port = createFakePort(engine);
    const transport = new MessagePortTransport(port.renderer);
    closers.push(() => {
      transport.close();
      port.closeEngineSide();
    });
    const body = await firstValueFrom(client(transport).get('/api/v1/meta'));
    expect(body).toEqual({ engineVersion: '1.2.3' });
    expect(engine.requests[0]?.url).toBe('/api/v1/meta');
  });

  it('sends method, URL with query, lower-case headers and a JSON body with its content type', async () => {
    const transport = stubTransport(() => reply(200, '{}'));
    await firstValueFrom(
      client(transport).post(
        '/api/v1/x',
        { a: 1 },
        {
          params: { q: 'one two' },
          headers: { 'X-Thing': 'a', 'X-Thing-2': 'b' },
        },
      ),
    );
    expect(transport.seen[0]).toEqual({
      method: 'POST',
      url: '/api/v1/x?q=one%20two',
      headers: {
        'x-thing': 'a',
        'x-thing-2': 'b',
        accept: 'application/json, application/problem+json, text/plain, */*',
        'content-type': 'application/json',
      },
      body: '{"a":1}',
    });
  });

  it('sends no body and no content type for a GET', async () => {
    const transport = stubTransport(() => reply(200, '{}'));
    await firstValueFrom(client(transport).get('/api/v1/x'));
    expect(transport.seen[0]).not.toHaveProperty('body');
    expect(transport.seen[0]?.headers).not.toHaveProperty('content-type');
  });

  it('carries an ArrayBuffer body through unchanged', async () => {
    const transport = stubTransport(() => reply(200));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await firstValueFrom(
      client(transport).put('/api/v1/blob', bytes, { responseType: 'text' }),
    );
    expect(new Uint8Array(transport.seen[0]?.body as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('refuses a body type the transports cannot carry', async () => {
    const transport = stubTransport(() => reply(200));
    const error = await firstValueFrom(
      client(transport).post('/api/v1/x', new FormData()),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect((error as HttpErrorResponse).error).toBeInstanceOf(TypeError);
    expect(transport.seen).toEqual([]);
  });

  it('shapes the answer by responseType', async () => {
    const transport = stubTransport(() => reply(200, '{"a":1}'));
    const http = client(transport);
    expect(await firstValueFrom(http.get('/x'))).toEqual({ a: 1 });
    expect(await firstValueFrom(http.get('/x', { responseType: 'text' }))).toBe(
      '{"a":1}',
    );
    const buffer = await firstValueFrom(
      http.get('/x', { responseType: 'arraybuffer' }),
    );
    expect(new TextDecoder().decode(buffer)).toBe('{"a":1}');
    const blob = await firstValueFrom(http.get('/x', { responseType: 'blob' }));
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(7);
  });

  it('decodes a binary body as text or JSON when asked', async () => {
    const encoded = new TextEncoder().encode('{"a":2}');
    const transport = stubTransport(() =>
      reply(
        200,
        encoded.buffer.slice(
          encoded.byteOffset,
          encoded.byteOffset + encoded.byteLength,
        ),
      ),
    );
    expect(await firstValueFrom(client(transport).get('/x'))).toEqual({ a: 2 });
  });

  it('gives a null body for an empty answer', async () => {
    const transport = stubTransport(() => reply(204));
    expect(await firstValueFrom(client(transport).delete('/x'))).toBeNull();
    const blank = stubTransport(() => reply(200, ''));
    TestBed.resetTestingModule();
    expect(await firstValueFrom(client(blank).get('/x'))).toBeNull();
  });

  it('exposes the response headers', async () => {
    const transport = stubTransport(() =>
      reply(200, '{}', { 'x-request-id': 'abc' }),
    );
    const response = await firstValueFrom(
      client(transport).get('/x', { observe: 'response' }),
    );
    expect(response.headers.get('X-Request-Id')).toBe('abc');
    expect(response.status).toBe(200);
  });

  it('fails a non-2xx answer with an HttpErrorResponse that holds the parsed body and headers', async () => {
    const engine = new FakeEngine({
      handler: () =>
        problemResponse(
          {
            type: 'about:blank',
            title: 'Nope',
            status: 422,
            code: 'GATE_BLOCKED',
            correlationId: 'c1',
            retryable: false,
          },
          { location: '/api/v1/plans/p1' },
        ),
    });
    const port = createFakePort(engine);
    const transport = new MessagePortTransport(port.renderer);
    closers.push(() => {
      transport.close();
      port.closeEngineSide();
    });
    const error = await firstValueFrom(
      client(transport).get('/api/v1/x'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    const failure = error as HttpErrorResponse;
    expect(failure.status).toBe(422);
    expect(failure.error).toMatchObject({ code: 'GATE_BLOCKED' });
    expect(failure.headers.get('location')).toBe('/api/v1/plans/p1');
  });

  it('keeps the raw text of an error answer that is not JSON', async () => {
    const transport = stubTransport(() =>
      reply(502, '<html>Bad gateway</html>'),
    );
    const error = (await firstValueFrom(client(transport).get('/x')).catch(
      (e: unknown) => e,
    )) as HttpErrorResponse;
    expect(error.status).toBe(502);
    expect(error.error).toBe('<html>Bad gateway</html>');
  });

  it('fails a 2xx answer that is not JSON as a parse error that still carries the status', async () => {
    const transport = stubTransport(() => reply(200, 'not json'));
    const error = (await firstValueFrom(client(transport).get('/x')).catch(
      (e: unknown) => e,
    )) as HttpErrorResponse;
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect(error.status).toBe(200);
    expect(error.error).toMatchObject({ text: 'not json' });
  });

  it('turns a transport failure into an HttpErrorResponse of status 0 holding the TransportError', async () => {
    const failure = new TransportError('network', 'down');
    const transport = stubTransport(() => Promise.reject(failure));
    const error = (await firstValueFrom(client(transport).get('/x')).catch(
      (e: unknown) => e,
    )) as HttpErrorResponse;
    expect(error.status).toBe(0);
    expect(error.error).toBe(failure);
  });

  it('aborts the transport request when the caller unsubscribes, and stays silent', async () => {
    const transport = stubTransport(() => new Promise(() => undefined));
    const emitted: unknown[] = [];
    const subscription = client(transport)
      .get('/slow')
      .subscribe({
        next: (value) => emitted.push(value),
        error: (error: unknown) => emitted.push(error),
      });
    await tick();
    expect(transport.signals[0]?.aborted).toBe(false);
    subscription.unsubscribe();
    expect(transport.signals[0]?.aborted).toBe(true);
    await tick();
    expect(emitted).toEqual([]);
  });

  it('does not report the abort it caused as an error', async () => {
    const transport = stubTransport(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new TransportError('aborted', 'aborted'));
          });
        }),
    );
    const errors: unknown[] = [];
    const subscription = client(transport)
      .get('/slow')
      .subscribe({ error: (error: unknown) => errors.push(error) });
    subscription.unsubscribe();
    await tick();
    expect(errors).toEqual([]);
  });
});
