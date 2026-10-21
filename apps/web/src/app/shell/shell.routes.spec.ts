import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { ActiveConnection } from './active-connection';
import { mountShell, routed, visit } from './test-fixtures';

describe('shell routes', () => {
  it('AC-4 routes under /c/:cid resolve, unknown children keep the shell, a bad id calls nothing', async () => {
    const bed = await mountShell();
    const connection = TestBed.inject(ActiveConnection);

    // A known child: the shell for c1 with the explorer in the workspace.
    await visit(bed, '/c/c1/explorer');
    let host = routed(bed);
    expect(host.tagName.toLowerCase()).toBe('app-shell');
    expect(connection.cid()).toBe('c1');
    expect(host.querySelector('main app-overview h1')?.textContent).toBe(
      '[[explorer.overview.title]]',
    );
    expect(host.querySelector('footer .value')?.textContent).toBe('c1');
    expect(host.querySelector('app-not-found')).toBeNull();

    // An unknown child: the shell stays, the workspace says not found.
    await visit(bed, '/c/c1/nope');
    host = routed(bed);
    expect(host.tagName.toLowerCase()).toBe('app-shell');
    expect(connection.cid()).toBe('c1');
    expect(host.querySelector('main app-not-found h1')?.textContent).toBe(
      '[[system.notFound.title]]',
    );
    expect(host.querySelector('app-overview')).toBeNull();

    // An id that is not a plain token: no connection, no engine call, nothing routed into the
    // workspace.
    const before = bed.engine.requests.length;
    await visit(bed, '/c/not%20an%20id/explorer');
    host = routed(bed);
    expect(host.tagName.toLowerCase()).toBe('app-shell');
    expect(connection.cid()).toBeNull();
    expect(host.querySelector('main app-no-connection h1')?.textContent).toBe(
      '[[system.noConnection.title]]',
    );
    expect(host.querySelector('app-overview')).toBeNull();
    expect(host.querySelector('footer .value')).toBeNull();

    expect(bed.engine.requests.length).toBe(before);
  });

  it('opens /c/:cid at the explorer and shows no connection outside /c/:cid', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c2');
    expect(routed(bed).querySelector('app-overview')).not.toBeNull();

    await visit(bed, '/');
    expect(routed(bed).tagName.toLowerCase()).toBe('app-no-connection');
    await visit(bed, '/somewhere/else');
    expect(routed(bed).tagName.toLowerCase()).toBe('app-no-connection');
    expect(TestBed.inject(ActiveConnection).cid()).toBeNull();
    // The only requests are the ones for the one connection that was shown.
    expect(bed.engine.requests.map((request) => request.url).sort()).toEqual([
      '/api/v1/connections/c2',
      '/api/v1/connections/c2/layout',
      '/api/v1/connections/c2/overview', // the explorer's overview page
      '/api/v1/connections/c2/profile',
    ]);
  });

  it('clears the connection when the shell goes away', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    expect(TestBed.inject(ActiveConnection).cid()).toBe('c1');
    await visit(bed, '/');
    expect(TestBed.inject(ActiveConnection).cid()).toBeNull();
  });

  it('marks the explorer link of the activity bar as the current page', async () => {
    const bed = await mountShell();
    await visit(bed, '/c/c1/explorer');
    const link = routed(bed).querySelector('nav a');
    expect(link?.getAttribute('href')).toBe('/c/c1/explorer');
    expect(link?.getAttribute('aria-current')).toBe('page');
  });
});
