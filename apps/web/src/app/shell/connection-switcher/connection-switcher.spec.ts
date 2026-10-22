import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ConnectionDirectory } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from '../status-bar/status-fixtures';
import {
  mountShell,
  routed,
  settleShell,
  until,
  visit,
} from '../test-fixtures';
import { ADDRESS_EXISTS, type AddressExists } from './switch-target';

function backendWith(): StatusBackend {
  const backend = new StatusBackend();
  for (const [cid, name, env] of [
    ['c1', 'Staging cluster', 'staging'],
    ['c2', 'Orders prod', 'prod'],
    ['c3', 'Lab', 'dev'],
  ] as const) {
    backend.connections.set(cid, connectionBody(cid, name, env));
    backend.profiles.set(cid, brokerProfileBody(cid));
  }
  return backend;
}

const select = (host: HTMLElement): HTMLSelectElement => {
  const found = host.querySelector<HTMLSelectElement>('#connection-switcher');
  if (found === null) throw new Error('the switcher is not there');
  return found;
};

async function choose(
  bed: Awaited<ReturnType<typeof mountShell>>,
  cid: string,
): Promise<void> {
  const el = select(routed(bed));
  el.value = cid;
  el.dispatchEvent(new Event('change'));
  await settleShell(bed);
}

describe('the connection switcher', () => {
  it('AC-9 lists the connections grouped by class, production first, with the active one selected and a link to manage them', async () => {
    const backend = backendWith();
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    const host = routed(bed);
    const groups = [...host.querySelectorAll('#connection-switcher optgroup')];
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([
      '[[status.env.prod]]',
      '[[status.env.staging]]',
      '[[status.env.dev]]',
    ]);
    expect(
      [...host.querySelectorAll('#connection-switcher option')].map((o) =>
        o.textContent.trim(),
      ),
    ).toEqual(['Orders prod', 'Staging cluster', 'Lab']);
    expect(select(host).value).toBe('c1');
    expect(
      host.querySelector('label[for="connection-switcher"]')?.textContent,
    ).toContain('[[shell.switcher.label]]');
    expect(host.querySelector('.switcher a')?.getAttribute('href')).toBe(
      '/connections',
    );
    // One list read serves the switcher; it is not read again by the shell opening another page.
    expect(backend.listRequests).toBe(1);
  });

  it('AC-2 switching from staging to prod opens the same explorer page on prod, and the tree follows', async () => {
    const bed = await mountShell(undefined, backendWith());
    await visit(bed, '/c/c1/explorer/bindings?vhost=%2F');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe(
      '/c/c2/explorer/bindings?vhost=%2F',
    );
    const host = routed(bed);
    expect(select(host).value).toBe('c2');
    expect(host.querySelector('.switcher .notice')).toBeNull();
    // The tree is drawn for the connection now shown: the overview and the four kinds.
    expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(5);
  });

  it('AC-2 an address that does not exist on prod opens the explorer root there with a notice naming it, which can be dismissed', async () => {
    const asked: [string, string][] = [];
    const exists: AddressExists = (cid, address) => {
      asked.push([cid, address]);
      return Promise.resolve(false);
    };
    const bed = await mountShell(undefined, backendWith(), undefined, [
      { provide: ADDRESS_EXISTS, useValue: exists },
    ]);
    await visit(bed, '/c/c1/explorer/queues/orders.q');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe('/c/c2/explorer');
    expect(asked).toEqual([['c2', '/explorer/queues/orders.q']]);
    const notice = routed(bed).querySelector('.switcher .notice');
    expect(notice?.textContent).toContain('[[shell.switcher.missing]]');
    // Dismissing it removes it.
    notice?.querySelector('button')?.click();
    await settleShell(bed);
    expect(routed(bed).querySelector('.switcher .notice')).toBeNull();
  });

  it('AC-2 an address that exists on prod is carried over without a notice', async () => {
    const bed = await mountShell(undefined, backendWith(), undefined, [
      { provide: ADDRESS_EXISTS, useValue: () => Promise.resolve(true) },
    ]);
    await visit(bed, '/c/c1/explorer/queues/orders.q');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    await choose(bed, 'c2');
    expect(TestBed.inject(Router).url).toBe('/c/c2/explorer/queues/orders.q');
    expect(routed(bed).querySelector('.switcher .notice')).toBeNull();
  });

  it('AC-9 a created or deleted connection shows after the directory is refreshed, and the active one that is not listed stands in', async () => {
    const backend = backendWith();
    const bed = await mountShell(undefined, backend);
    await visit(bed, '/c/c1/explorer');
    await until(
      bed,
      () =>
        routed(bed).querySelectorAll('#connection-switcher option').length >= 3,
      'the connections',
    );
    backend.connections.set('c4', connectionBody('c4', 'New broker', 'test'));
    backend.connections.delete('c3');
    await TestBed.inject(ConnectionDirectory).refresh();
    await settleShell(bed);
    expect(
      [...routed(bed).querySelectorAll('#connection-switcher option')].map(
        (o) => o.textContent.trim(),
      ),
    ).toEqual(['Orders prod', 'Staging cluster', 'New broker']);
    // An address whose connection is not in the list yet shows its id until the list has it.
    await visit(bed, '/c/c9/explorer');
    expect(select(routed(bed)).value).toBe('c9');
  });
});
