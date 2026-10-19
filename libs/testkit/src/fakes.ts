// Port fakes for specs that need an action to read or write the management API without a broker.
// They answer from a table, record every request, and refuse what the table does not know, so a
// spec cannot pass by accident on a path nobody wrote down. A response goes through the schema the
// request carries, as the real adapter does, so a fake cannot return a shape the code would not see.
import type {
  MgmtGetRequest,
  MgmtReadPort,
  MgmtSendRequest,
  MgmtWritePort,
} from '@app/ports';

export interface FakeMgmtRead extends MgmtReadPort {
  /** Every request, in order, whether or not it was answered. */
  readonly requests: readonly MgmtGetRequest<unknown>[];
}

export interface FakeMgmtWrite extends MgmtWritePort {
  readonly requests: readonly MgmtSendRequest<unknown>[];
}

/** `GET`s answered by path (the part of the URL below the host, without the query). */
export function createFakeMgmtRead(
  responses: Readonly<Record<string, unknown>>,
): FakeMgmtRead {
  const requests: MgmtGetRequest<unknown>[] = [];
  return {
    requests,
    get<T>(request: MgmtGetRequest<T>): Promise<T> {
      requests.push(request);
      if (!Object.hasOwn(responses, request.path)) {
        return Promise.reject(
          new Error(`the fake management API has no GET ${request.path}`),
        );
      }
      return Promise.resolve().then(() =>
        request.schema.parse(responses[request.path]),
      );
    },
    stream: (request) =>
      Promise.reject(
        new Error(`the fake management API does not stream ${request.path}`),
      ),
  };
}

/** `PUT`, `POST` and `DELETE`s answered by `METHOD path`, for example `DELETE /api/queues/%2F/q/contents`. */
export function createFakeMgmtWrite(
  responses: Readonly<Record<string, unknown>>,
): FakeMgmtWrite {
  const requests: MgmtSendRequest<unknown>[] = [];
  return {
    requests,
    send<T>(request: MgmtSendRequest<T>): Promise<T> {
      requests.push(request);
      const key = `${request.method} ${request.path}`;
      if (!Object.hasOwn(responses, key)) {
        return Promise.reject(
          new Error(`the fake management API has no ${key}`),
        );
      }
      return Promise.resolve().then(() => request.schema.parse(responses[key]));
    },
  };
}
