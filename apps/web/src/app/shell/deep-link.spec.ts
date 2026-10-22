import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { encodeObjectKey } from '@app/contracts';
import { PLATFORM_BRIDGE } from '@app/ui-platform';
import { describe, expect, it } from 'vitest';

import { parseDeepLink, provideDeepLinks } from './deep-link';

const key = encodeObjectKey('/', 'orders.q');

describe('deep links from the operating system (R10)', () => {
  it('AC-17 an OS link is an allow-listed navigation and nothing else', async () => {
    // The shapes that are accepted: the explorer and the entities of a connection.
    for (const [link, url] of [
      ['/c/c1/explorer', '/c/c1/explorer'],
      ['/c/c1/explorer/queues', '/c/c1/explorer/queues'],
      [
        '/c/prod.1/explorer/bindings?vhost=%2F',
        '/c/prod.1/explorer/bindings?vhost=%2F',
      ],
      [
        '/c/c1/explorer/queues?view=v1&vhost=orders',
        '/c/c1/explorer/queues?view=v1&vhost=orders',
      ],
      [`/c/c1/queues/${key}`, `/c/c1/queues/${key}`],
      [`/c/c1/queues/${key}/routing`, `/c/c1/queues/${key}/routing`],
      [`/c/c1/exchanges/${key}`, `/c/c1/exchanges/${key}`],
      [`/c/c1/connections/${key}`, `/c/c1/connections/${key}`],
      [`/c/c1/bindings/${key}`, `/c/c1/bindings/${key}`],
    ] as const) {
      expect(parseDeepLink(link), link).toBe(url);
    }

    // Everything else is dropped: schemes, other roots, traversal, actions, unknown queries, hostile text.
    const hostile = [
      '',
      '/',
      'app://c/c1/explorer',
      'rabbitmq://c/c1/explorer',
      'https://example.com/c/c1/explorer',
      '//evil.example/c/c1/explorer',
      '/connections',
      '/gallery',
      '/c',
      '/c/c1',
      '/c/c1/',
      '/c/c1/explorer/',
      '/c/c1/explorer/nope',
      '/c/c1/explorer/queues/extra',
      '/c/c1/settings',
      '/c/c1/../c2/explorer',
      '/c/c1/explorer/..',
      '/c/./explorer',
      '/c/../explorer',
      '/c/c 1/explorer',
      '/c/%2e%2e/explorer',
      '/c/c1\\explorer',
      '/c/c1/explorer?x=1',
      '/c/c1/explorer?vhost=a&vhost=b',
      '/c/c1/explorer?action=delete',
      '/c/c1/explorer#top',
      `/c/c1/queues/${key}?tab=routing`,
      `/c/c1/queues/${key}/routing/extra`,
      `/c/c1/queues/${key}/Routing`,
      '/c/c1/queues/not*a*key',
      `/c/c1/actions/${key}`,
      `/c/c1/queues/${key}/purge`.replace('purge', '../purge'),
      '/c/c1/explorer\u0000',
      '/c/c1/explorer\n/queues',
      `/c/c1/explorer?vhost=${'v'.repeat(300)}`,
      `/c/c1/queues/${'A'.repeat(2_000)}`,
    ];
    for (const link of hostile) {
      expect(parseDeepLink(link), JSON.stringify(link)).toBeNull();
    }

    // The handler navigates for a valid link, ignores the rest, and stops with the application.
    let listener: ((link: string) => void) | undefined;
    let stopped = 0;
    const bridge = {
      kind: 'desktop',
      bridgeVersion: 1,
      onDeepLink: (callback: (link: string) => void) => {
        listener = callback;
        return () => {
          stopped += 1;
        };
      },
    };
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: '**', children: [] }]),
        provideDeepLinks(),
        { provide: PLATFORM_BRIDGE, useValue: bridge },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    const router = TestBed.inject(Router);
    expect(listener).toBeDefined();

    listener?.(`/c/c2/queues/${key}/routing`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(router.url).toBe(`/c/c2/queues/${key}/routing`);
    for (const link of [
      'app://c/c1/explorer',
      '/c/c1/explorer?action=delete',
      '/c/c3/settings',
    ]) {
      listener?.(link);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(router.url).toBe(`/c/c2/queues/${key}/routing`); // the hostile ones went nowhere
    expect(stopped).toBe(0);
    TestBed.resetTestingModule();
    expect(stopped).toBe(1);

    // A bridge without the optional method (the browser's) is fine: nothing is subscribed.
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideDeepLinks(),
        {
          provide: PLATFORM_BRIDGE,
          useValue: { kind: 'web', bridgeVersion: 1 },
        },
      ],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    // And an app with no bridge at all.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideDeepLinks()],
    });
    await TestBed.inject(ApplicationInitStatus).donePromise;
  });
});
