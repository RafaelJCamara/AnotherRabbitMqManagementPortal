// The explorer's specs: the real `EngineApi` and `LiveClient` over the fake engine, with the
// inventory answered by the model's deterministic fake (so a spec sees real HTTP shapes and a real
// live session, and the same rows as the model's own specs). Never part of the library build.
import { TestBed } from '@angular/core/testing';
import {
  explorerWindowTopic,
  type InputOf,
  type inventoryQuery,
} from '@app/contracts';
import {
  createFakeExplorerData,
  type FakeExplorerData,
} from '@app/explorer-model/testing';
import {
  EngineApi,
  ENGINE_PARSE,
  LiveClient,
  provideEngineData,
} from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  jsonResponse,
  problemResponse,
  type FakeHandler,
} from '@app/ui-platform/testing';

import { createEngineExplorerData } from '../data/engine-explorer-data';
import type { ExplorerData } from '@app/explorer-model';

type Request = Parameters<FakeHandler>[0];
type Response = Awaited<ReturnType<FakeHandler>>;
/** Answers a route the testbed does not know; `undefined` means "not mine" (a 404 Problem). */
type Routes = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

const INVENTORY_PATH = /^\/api\/v1\/connections\/([^/]+)\/inventory\/queries$/;

/**
 * Answers `POST /connections/{cid}/inventory/queries` from the model's fake, as the engine would (a 400
 * Problem for a query the fake refuses); `undefined` for any other request.
 */
export async function answerInventory(
  fake: FakeExplorerData,
  request: Request,
): Promise<Response | undefined> {
  const url = new URL(request.url, 'http://engine.test');
  const match = INVENTORY_PATH.exec(url.pathname);
  if (request.method !== 'POST' || match?.[1] === undefined) return undefined;
  const body = JSON.parse(
    typeof request.body === 'string' ? request.body : '{}',
  ) as Omit<InputOf<typeof inventoryQuery>, 'cid'>;
  const input = { ...body, cid: decodeURIComponent(match[1]) };
  try {
    return jsonResponse(
      200,
      await fake.query(
        input as InputOf<typeof inventoryQuery>,
        new AbortController().signal,
      ),
    );
  } catch (error) {
    return problemResponse({
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      detail: error instanceof Error ? error.message : 'failed',
      correlationId: 'fake-engine',
      retryable: false,
    });
  }
}

export interface ExplorerTestbed {
  readonly engine: FakeEngine;
  readonly fake: FakeExplorerData;
  readonly api: EngineApi;
  readonly live: LiveClient;
  /** The engine-backed port: HTTP through the fake engine, the topic through the live session. */
  readonly data: ExplorerData;
}

/**
 * Configures TestBed with the data layer on the in-memory carrier. `inventory.query` is answered by
 * `fake`; every other route goes to `routes` (a 404 Problem when it does not answer).
 */
export function configureExplorerTestbed(
  options: {
    readonly fake?: FakeExplorerData;
    readonly routes?: Routes;
  } = {},
): ExplorerTestbed {
  const fake = options.fake ?? createFakeExplorerData();
  const handler: FakeHandler = async (request) => {
    const url = new URL(request.url, 'http://engine.test');
    const answered = await answerInventory(fake, request);
    if (answered !== undefined) return answered;
    const routed = await options.routes?.(request);
    return (
      routed ??
      problemResponse({
        type: 'about:blank',
        title: 'Not found',
        status: 404,
        code: 'NOT_FOUND',
        detail: `${request.method} ${url.pathname}`,
        correlationId: 'fake-engine',
        retryable: false,
      })
    );
  };
  const engine = new FakeEngine({ handler, topics: [explorerWindowTopic] });
  TestBed.configureTestingModule({
    providers: [
      provideEngineData(),
      { provide: ENGINE_TRANSPORT, useValue: new MemoryTransport(engine) },
      { provide: ENGINE_PARSE, useValue: true },
    ],
  });
  const api = TestBed.inject(EngineApi);
  const live = TestBed.inject(LiveClient);
  return { engine, fake, api, live, data: createEngineExplorerData(api, live) };
}
