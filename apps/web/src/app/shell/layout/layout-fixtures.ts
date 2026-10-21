// Test support for the layout: an engine that stores layouts per connection (the behaviour of
// `layouts.get` and `layouts.put` over the golden path, without the guardrail), a manual clock for
// the save delay and a fixed viewport. Only the specs use it.
import type { EnvironmentProviders, Provider } from '@angular/core';
import type { Problem } from '@app/contracts';
import { ConnectionIdSchema, type ConnectionId } from '@app/contracts';
import { provideEngineData } from '@app/ui-data';
import { ENGINE_TRANSPORT } from '@app/ui-platform';
import {
  FakeEngine,
  MemoryTransport,
  jsonResponse,
  problemResponse,
} from '@app/ui-platform/testing';
import type { TransportRequest, TransportResponse } from '@app/ui-platform';

import type { Viewport } from './fit-layout';
import type { ShellLayout } from './shell-layout';
import { LAYOUT_TIMER, VIEWPORT, type LayoutTimer } from './shell-layout-store';

export const cidOf = (value: string): ConnectionId =>
  ConnectionIdSchema.parse(value);

const LAYOUT_URL = /^\/api\/v1\/connections\/([^/]+)\/layout$/;

export const problem = (
  status: number,
  code: Problem['code'],
  extra: Partial<Problem> = {},
): Problem => ({
  type: 'about:blank',
  title: `Problem ${String(status)}`,
  status,
  code,
  correlationId: 'fixture',
  retryable: status >= 500,
  ...extra,
});

/** A fake engine that keeps one layout document per connection and records every call. */
export class LayoutBackend {
  /** The stored documents, as `layouts.get` would return them. */
  readonly docs = new Map<string, unknown>();
  readonly gets: string[] = [];
  readonly puts: { cid: string; layout: unknown }[] = [];
  /** Answers for the next `layouts.put` calls, oldest first; an empty queue answers 200. */
  readonly putAnswers: TransportResponse[] = [];
  /** When set, every `layouts.get` gets this answer. */
  getAnswer: TransportResponse | undefined;
  readonly engine = new FakeEngine({
    handler: (request) => this.handle(request),
  });

  /** Answers one request; a subclass handles more URLs and passes the rest on. */
  handle(
    request: TransportRequest,
  ): TransportResponse | Promise<TransportResponse> {
    const match = LAYOUT_URL.exec(request.url);
    const cid = match?.[1];
    if (cid === undefined) {
      return problemResponse(problem(404, 'NOT_FOUND', { title: 'Not found' }));
    }
    if (request.method === 'GET') {
      this.gets.push(cid);
      if (this.getAnswer !== undefined) return this.getAnswer;
      const layout = this.docs.get(cid) ?? null;
      return jsonResponse(200, {
        layout,
        updatedAt: layout === null ? null : 1,
      });
    }
    const body = JSON.parse(
      typeof request.body === 'string' ? request.body : '{}',
    ) as { layout: unknown };
    this.puts.push({ cid, layout: body.layout });
    const answer = this.putAnswers.shift();
    if (answer !== undefined) return answer;
    this.docs.set(cid, body.layout);
    return jsonResponse(200, {});
  }
}

/** A clock for the save delay that moves only when the spec says so. */
export class ManualTimer {
  #next = 1;
  readonly #pending = new Map<number, () => void>();
  readonly delays: number[] = [];

  readonly timer: LayoutTimer = (callback, ms) => {
    const id = this.#next++;
    this.delays.push(ms);
    this.#pending.set(id, callback);
    return () => {
      this.#pending.delete(id);
    };
  };

  get pending(): number {
    return this.#pending.size;
  }

  /** Runs every timer that is armed now. */
  fire(): void {
    const due = [...this.#pending.values()];
    this.#pending.clear();
    for (const callback of due) callback();
  }
}

export const VIEWPORT_1280 = { width: 1280, height: 720 } as const;

/** The providers a spec of the store or the shell needs behind `EngineApi`. */
export function layoutProviders(
  backend: LayoutBackend,
  timer: ManualTimer = new ManualTimer(),
  viewport: Viewport = VIEWPORT_1280,
): (EnvironmentProviders | Provider)[] {
  return [
    provideEngineData(),
    {
      provide: ENGINE_TRANSPORT,
      useValue: new MemoryTransport(backend.engine),
    },
    { provide: LAYOUT_TIMER, useValue: timer.timer },
    { provide: VIEWPORT, useValue: () => viewport },
  ];
}

/** Three tabs in the first editor group and one in the second, sizes that fit 1280x720. */
export function twoGroupLayout(cid: string): ShellLayout {
  const tab = (id: string, path: string, label: string) => ({
    id,
    url: `/c/${cid}/${path}`,
    label,
  });
  return {
    version: 1,
    sidebar: { visible: true, width: 260, active: 'explorer' },
    editor: {
      orientation: 'row',
      groups: [
        {
          weight: 600,
          tabs: [
            tab('t1', 'explorer', 'One'),
            tab('t2', 'two', 'Two'),
            tab('t3', 'three', 'Three'),
          ],
          activeTab: 't2',
        },
        { weight: 348, tabs: [tab('t4', 'four', 'Four')], activeTab: 't4' },
      ],
      activeGroup: 0,
    },
    panel: { visible: false, height: 200, active: 'jobs' },
  };
}
