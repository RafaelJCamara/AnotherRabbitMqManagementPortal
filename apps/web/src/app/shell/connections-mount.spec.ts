import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from './status-bar/status-fixtures';
import { mountShell, routed, settleShell, visit } from './test-fixtures';

function backendWith(): StatusBackend {
  const backend = new StatusBackend();
  for (const [cid, name, env] of [
    ['c1', 'Staging cluster', 'staging'],
    ['c2', 'Orders prod', 'prod'],
  ] as const) {
    backend.connections.set(cid, connectionBody(cid, name, env));
    backend.profiles.set(cid, brokerProfileBody(cid));
  }
  return backend;
}

/** The feature is a lazy library: neither the app nor its specs import it statically. */
async function mountWithConnections(backend: StatusBackend) {
  const { CONNECTIONS_SCOPE_LOADER } = await import('@app/feature-connections');
  const { markedConnectionsScope } =
    await import('@app/feature-connections/testing');
  return await mountShell(undefined, backend, undefined, [
    { provide: CONNECTIONS_SCOPE_LOADER, useValue: markedConnectionsScope },
  ]);
}

describe('the connections pages under the app', () => {
  it('AC-3 /connections mounts the list outside the shell, with a way to add a connection and to open each one', async () => {
    const bed = await mountWithConnections(backendWith());
    await visit(bed, '/connections');
    const host = routed(bed);
    // The connections frame, not the shell: no sidebar, no status bar.
    expect(host.tagName.toLowerCase()).toBe('app-connections-layout');
    expect(host.querySelector('app-shell, app-status-bar')).toBeNull();
    expect(host.querySelector('app-connection-list h1')?.textContent).toBe(
      '[[connections.title]]',
    );
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(
      rows.map((row) => row.querySelector('th')?.textContent.trim()),
    ).toEqual(['Staging cluster', 'Orders prod']);
    expect(
      host.querySelector('header a[href="/connections/new"]'),
    ).not.toBeNull();
    expect(rows[1]?.querySelector('a[href="/c/c2/explorer"]')).not.toBeNull();
  });

  it("AC-3 the pages of one connection and the create form are reachable by address, and an unknown address is the app's own", async () => {
    const bed = await mountWithConnections(backendWith());
    await visit(bed, '/connections/new');
    expect(
      routed(bed).querySelector('app-connection-form h1')?.textContent,
    ).toContain('[[connections.form.createTitle]]');
    await visit(bed, '/connections/c2');
    expect(
      routed(bed).querySelector('app-connection-page h1')?.textContent,
    ).toBe('Orders prod');
    await visit(bed, '/connections/c2/edit');
    expect(
      routed(bed).querySelector('app-connection-form h1')?.textContent,
    ).toContain('[[connections.form.editTitle]]');
    // A third segment belongs to nothing: the app's no-connection view answers, as for any unknown address.
    await visit(bed, '/connections/c2/edit/nope');
    expect(routed(bed).tagName.toLowerCase()).toBe('app-no-connection');
  });

  it('AC-3 the no-connection view leads to the connections page', async () => {
    const bed = await mountWithConnections(backendWith());
    await visit(bed, '/');
    expect(routed(bed).tagName.toLowerCase()).toBe('app-no-connection');
    const link = routed(bed).querySelector('a[href="/connections"]');
    expect(link?.textContent).toBe('[[system.noConnection.manage]]');
    (link as HTMLElement).click();
    await settleShell(bed);
    expect(TestBed.inject(Router).url).toBe('/connections');
  });
});
