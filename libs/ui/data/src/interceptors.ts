// HttpClient interceptors, in the order blueprint 10 gives: correlation, auth, problem. The problem
// interceptor is last in the chain, so it sees the raw error of the transport and turns it into a
// typed error before any caller does.
import {
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import {
  ENGINE_CREDENTIALS,
  TransportError,
  credentialHeaders,
  isEngineUrl,
} from '@app/ui-platform';
import { catchError, throwError } from 'rxjs';

import { EngineProblemError, parseProblem, syntheticProblem } from './errors';
import { randomId } from './ids';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Gives every request an id the engine logs and echoes in the Problem's `correlationId`. */
export const correlationInterceptor: HttpInterceptorFn = (request, next) =>
  request.headers.has(REQUEST_ID_HEADER)
    ? next(request)
    : next(request.clone({ setHeaders: { [REQUEST_ID_HEADER]: randomId() } }));

/** Adds the engine credentials to engine requests (same-origin paths) and to nothing else. */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const credentials = inject(ENGINE_CREDENTIALS);
  if (!isEngineUrl(request.url)) return next(request);
  const headers = credentialHeaders(credentials(), request.method);
  return Object.keys(headers).length === 0
    ? next(request)
    : next(request.clone({ setHeaders: headers }));
};

/**
 * Maps a failed call to a typed error: a Problem body becomes an EngineProblemError (with `gate`
 * and `warnings`), a carrier failure becomes the TransportError itself, and an error answer with no
 * Problem becomes a synthetic one, flagged as such.
 */
export const problemInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) return throwError(() => error);
      const body: unknown = error.error;
      if (body instanceof TransportError) return throwError(() => body);
      const location = error.headers.get('location') ?? undefined;
      const problem = parseProblem(body);
      if (problem !== undefined) {
        return throwError(() => new EngineProblemError(problem, { location }));
      }
      const correlationId =
        error.headers.get(REQUEST_ID_HEADER) ??
        request.headers.get(REQUEST_ID_HEADER) ??
        '';
      return throwError(
        () =>
          new EngineProblemError(
            syntheticProblem(error.status, correlationId),
            {
              location,
              synthetic: true,
            },
          ),
      );
    }),
  );

/** The chain `provideEngineData` installs. */
export const ENGINE_INTERCEPTORS: readonly HttpInterceptorFn[] = [
  correlationInterceptor,
  authInterceptor,
  problemInterceptor,
];
