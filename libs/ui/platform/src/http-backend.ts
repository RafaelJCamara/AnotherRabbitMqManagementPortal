// HttpBackend over any EngineTransport. HttpClient, interceptors and httpResource keep working
// unchanged (blueprint 3.4: the same override `provideHttpClientTesting` uses), and only the
// carrier differs: a MessagePort tunnel or fetch.
import {
  HttpBackend,
  HttpErrorResponse,
  HttpHeaders,
  HttpResponse,
  type HttpEvent,
  type HttpRequest,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import {
  ENGINE_TRANSPORT,
  TransportError,
  isArrayBuffer,
  type TransportBody,
  type TransportResponse,
} from './engine-transport';

const ACCEPT = 'application/json, application/problem+json, text/plain, */*';

function requestBody(request: HttpRequest<unknown>): TransportBody | undefined {
  const body = request.serializeBody();
  if (body === null) return undefined;
  if (typeof body === 'string' || isArrayBuffer(body)) return body;
  throw new TypeError(
    'The engine transport carries string and ArrayBuffer bodies only.',
  );
}

function requestHeaders(request: HttpRequest<unknown>): Record<string, string> {
  // The caller's own Accept header, if any, replaces the default below.
  const headers: Record<string, string> = { accept: ACCEPT };
  for (const name of request.headers.keys()) {
    const values = request.headers.getAll(name);
    if (values !== null) headers[name.toLowerCase()] = values.join(', ');
  }
  const contentType =
    headers['content-type'] ?? request.detectContentTypeHeader();
  if (contentType !== null && request.body !== null) {
    headers['content-type'] = contentType;
  }
  return headers;
}

const decode = (body: TransportBody): string =>
  typeof body === 'string' ? body : new TextDecoder().decode(body);

function encode(body: TransportBody): ArrayBuffer {
  if (typeof body !== 'string') return body;
  const bytes = new TextEncoder().encode(body);
  // A buffer of this realm: HttpClient checks `instanceof ArrayBuffer` on what it gets back.
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/** The body as the request asked for it, or a parse failure for `responseType: 'json'`. */
function parseBody(
  request: HttpRequest<unknown>,
  body: TransportBody | undefined,
  ok: boolean,
): { value: unknown } | { failure: { error: unknown; text: string } } {
  if (body === undefined) return { value: null };
  switch (request.responseType) {
    case 'arraybuffer':
      return { value: encode(body) };
    case 'blob':
      return { value: new Blob([encode(body)]) };
    case 'text':
      return { value: decode(body) };
    case 'json': {
      const text = decode(body);
      if (text === '') return { value: null };
      try {
        return { value: JSON.parse(text) as unknown };
      } catch (error) {
        // A failing request keeps its raw text, like the XHR backend.
        return ok ? { failure: { error, text } } : { value: text };
      }
    }
  }
}

@Injectable({ providedIn: 'root' })
export class EngineTransportHttpBackend implements HttpBackend {
  readonly #transport = inject(ENGINE_TRANSPORT);

  handle(request: HttpRequest<unknown>): Observable<HttpEvent<unknown>> {
    return new Observable<HttpEvent<unknown>>((subscriber) => {
      const abort = new AbortController();
      const url = request.urlWithParams;
      const fail = (
        error: unknown,
        status: number,
        statusText: string,
        headers?: HttpHeaders,
      ): void => {
        subscriber.error(
          new HttpErrorResponse({
            error,
            status,
            statusText,
            url,
            ...(headers === undefined ? {} : { headers }),
          }),
        );
      };

      let response: Promise<TransportResponse>;
      try {
        const body = requestBody(request);
        response = this.#transport.request(
          {
            method: request.method,
            url,
            headers: requestHeaders(request),
            ...(body === undefined ? {} : { body }),
          },
          abort.signal,
        );
      } catch (error) {
        fail(error, 0, 'Unknown Error');
        return undefined;
      }

      response.then(
        (reply) => {
          const headers = new HttpHeaders({ ...reply.headers });
          const ok = reply.status >= 200 && reply.status < 300;
          const parsed = parseBody(request, reply.body, ok);
          if ('failure' in parsed) {
            fail(parsed.failure, reply.status, '', headers);
          } else if (ok) {
            subscriber.next(
              new HttpResponse({
                body: parsed.value,
                headers,
                status: reply.status,
                url,
              }),
            );
            subscriber.complete();
          } else {
            fail(parsed.value, reply.status, '', headers);
          }
        },
        (error: unknown) => {
          // The unsubscribe below aborts the request; nobody is listening then.
          if (error instanceof TransportError && error.reason === 'aborted') {
            return;
          }
          fail(error, 0, 'Unknown Error');
        },
      );
      return () => {
        abort.abort();
      };
    });
  }
}
