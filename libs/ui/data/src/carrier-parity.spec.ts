// AC-1: the same component, run against a fake MessagePort transport and against a fake WebSocket
// transport, gives the same results. The component reads a resource, makes a call that fails with a
// gated Problem, and follows a live topic, all through EngineApi, engineResource and the
// LiveClient; nothing in it knows which carrier it runs on.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  HttpWsTransport,
  MessagePortTransport,
  type EngineTransport,
} from '@app/ui-platform';
import {
  createFakeFetch,
  createFakePort,
  createFakeWebSocketFactory,
  tick,
  type FakeEngine,
} from '@app/ui-platform/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { EngineApi } from './engine-api';
import { engineResource } from './engine-resource';
import { isEngineProblem } from './errors';
import { LiveClient } from './live-client';
import {
  configureTestbed,
  eventsTopic,
  queuesGet,
  queuesPurge,
} from './test-fixtures';

@Component({
  selector: 'app-parity-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p id="queue">{{ queueText() }}</p>
    <p id="purge">{{ purgeText() }}</p>
    <p id="live">{{ live.state() }}</p>
    <ul id="events">
      @for (n of events(); track $index) {
        <li>{{ n }}</li>
      }
    </ul>
  `,
})
class ParityHost {
  protected readonly live = inject(LiveClient);
  protected readonly events = signal<number[]>([]);
  protected readonly purgeText = signal('');
  readonly #queue = engineResource(queuesGet, () => ({
    cid: 'c1',
    qkey: 'q1',
    verbose: true,
  }));
  protected readonly queueText = () => {
    const queue = this.#queue.value();
    return queue === undefined ? '' : `${queue.name}:${String(queue.messages)}`;
  };

  constructor() {
    inject(EngineApi)
      .call(queuesPurge, { cid: 'c1', qkey: 'blocked', reason: 'test' })
      .subscribe({
        error: (error: unknown) => {
          if (!isEngineProblem(error)) throw error;
          this.purgeText.set(
            [
              error.code,
              error.gate?.reason,
              error.warnings.map((w) => w.id).join('+'),
            ].join(' | '),
          );
        },
      });
    const subscription = this.live
      .subscribe(eventsTopic, { cid: 'c1' })
      .subscribe((event) => {
        if (event.kind === 'data') {
          this.events.update((all) => [...all, ...event.items.map((i) => i.n)]);
        }
      });
    inject(DestroyRef).onDestroy(() => {
      subscription.unsubscribe();
    });
  }
}

interface Carrier {
  readonly name: string;
  readonly make: (
    engine: FakeEngine,
    cleanup: (fn: () => void) => void,
  ) => EngineTransport;
}

const carriers: Carrier[] = [
  {
    name: 'fake MessagePort transport',
    make: (engine, cleanup) => {
      const port = createFakePort(engine);
      const transport = new MessagePortTransport(port.renderer, {
        validate: true,
      });
      cleanup(() => {
        transport.close();
        port.closeEngineSide();
      });
      return transport;
    },
  },
  {
    name: 'fake WebSocket transport',
    make: (engine) =>
      new HttpWsTransport({
        fetch: createFakeFetch(engine),
        webSocket: createFakeWebSocketFactory(engine),
        liveUrl: () => 'ws://engine.test/api/v1/live',
        validate: true,
      }),
  },
];

/** What a user and the engine could tell apart. Headers and ids differ by design and are left out. */
interface Outcome {
  readonly dom: Record<string, string>;
  readonly requests: string[];
  readonly clientFrames: string[];
}

describe('carrier parity', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    TestBed.resetTestingModule();
    for (const fn of cleanups.splice(0)) fn();
  });

  async function run(carrier: Carrier): Promise<Outcome> {
    const renders: (() => void)[] = [];
    const { engine } = configureTestbed({
      transport: (e) => carrier.make(e, (fn) => cleanups.push(fn)),
      live: {
        initialCredit: 8,
        afterRender: (callback) => renders.push(callback),
      },
    });
    const fixture: ComponentFixture<ParityHost> =
      TestBed.createComponent(ParityHost);
    const text = (id: string): string =>
      (fixture.nativeElement as HTMLElement)
        .querySelector(`#${id}`)
        ?.textContent.trim() ?? '';
    const until = async (done: () => boolean, what: string): Promise<void> => {
      for (let round = 0; round < 300; round += 1) {
        fixture.detectChanges();
        if (done()) return;
        await tick();
      }
      throw new Error(`timed out waiting for ${what}`);
    };

    await until(
      () =>
        text('queue') !== '' &&
        text('purge') !== '' &&
        engine.clientFrames.some((f) => f.t === 'sub'),
      'the read, the failed call and the subscription',
    );
    for (let n = 1; n <= 3; n += 1) engine.publish('test.events', { n });
    await until(
      () =>
        (fixture.nativeElement as HTMLElement).querySelectorAll('li').length ===
        3,
      'three events',
    );
    // The batch is on screen: now the page grants credit.
    for (const callback of renders.splice(0)) callback();
    await until(
      () => engine.clientFrames.some((f) => f.t === 'credit'),
      'the credit',
    );

    return {
      dom: {
        queue: text('queue'),
        purge: text('purge'),
        live: text('live'),
        events: [
          ...(fixture.nativeElement as HTMLElement).querySelectorAll('li'),
        ]
          .map((li) => li.textContent.trim())
          .join(','),
      },
      requests: engine.requests
        .filter((r) => !r.url.endsWith('/live/tickets'))
        .map(
          (r) =>
            `${r.method} ${r.url}${typeof r.body === 'string' ? ` ${r.body}` : ''}`,
        )
        .sort(),
      clientFrames: engine.clientFrames.map((f) => {
        switch (f.t) {
          case 'sub':
            return `sub ${String(f.sid)} ${f.topic} ${JSON.stringify(f.params)} ${String(f.credit)}`;
          case 'credit':
            return `credit ${String(f.sid)} ${String(f.n)}`;
          default:
            return f.t;
        }
      }),
    };
  }

  const expected: Outcome = {
    dom: {
      queue: 'q1:42',
      purge:
        'GATE_BLOCKED | Statistics are disabled on this broker. | W-purge-1+W-purge-2',
      live: 'ready',
      events: '1,2,3',
    },
    requests: [
      'GET /api/v1/connections/c1/queues/q1?verbose=true',
      'POST /api/v1/connections/c1/queues/blocked/purge {"reason":"test"}',
    ],
    clientFrames: ['hello', 'sub 1 test.events {"cid":"c1"} 8', 'credit 1 3'],
  };

  it.each(carriers)(
    'renders the expected results on the $name',
    async (carrier) => {
      expect(await run(carrier)).toEqual(expected);
    },
  );

  it('AC-1 gives identical results on the MessagePort and the WebSocket transport', async () => {
    const [port, socket] = carriers;
    if (port === undefined || socket === undefined)
      throw new Error('two carriers');
    const onPort = await run(port);
    TestBed.resetTestingModule();
    for (const fn of cleanups.splice(0)) fn();
    const onSocket = await run(socket);
    expect(onSocket).toEqual(onPort);
  });
});
