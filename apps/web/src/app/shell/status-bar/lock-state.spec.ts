import { TestBed } from '@angular/core/testing';
import { ARMING_CLOCK, ArmingStore, type ArmingClock } from '@app/ui-data';
import { describe, expect, it } from 'vitest';

import {
  mountShell,
  routed,
  settleShell,
  until,
  visit,
} from '../test-fixtures';
import {
  StatusBackend,
  brokerProfileBody,
  connectionBody,
} from './status-fixtures';

/** A clock the spec moves. */
class ManualClock implements ArmingClock {
  at = 1_000_000;
  readonly timers = new Map<number, { due: number; run: () => void }>();
  #next = 1;
  now(): number {
    return this.at;
  }
  after(ms: number, run: () => void): () => void {
    const id = this.#next++;
    this.timers.set(id, { due: this.at + ms, run });
    return () => {
      this.timers.delete(id);
    };
  }
  advance(ms: number): void {
    this.at += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.at) {
        this.timers.delete(id);
        timer.run();
      }
    }
  }
}

const lock = (host: HTMLElement): string | undefined =>
  host.querySelector('app-status-bar .lock .value')?.textContent.trim();

describe('the lock segment of the status bar', () => {
  it('AC-10 reads locked until this page armed the active connection, armed while the window is open, and locked again at its end', async () => {
    const backend = new StatusBackend();
    for (const cid of ['c1', 'c2']) {
      backend.connections.set(
        cid,
        connectionBody(cid, `Broker ${cid}`, 'prod'),
      );
      backend.profiles.set(cid, brokerProfileBody(cid));
    }
    const clock = new ManualClock();
    const bed = await mountShell(undefined, backend, undefined, [
      { provide: ARMING_CLOCK, useValue: clock },
    ]);
    await visit(bed, '/c/c1/explorer');
    await until(bed, () => lock(routed(bed)) !== undefined, 'the status bar');
    expect(lock(routed(bed))).toBe('[[status.lock.locked]]');

    // The unlock is the engine's ops.arm; the bar follows what it answered.
    const outcome = await TestBed.inject(ArmingStore).arm('c1');
    expect(outcome.ok).toBe(true);
    expect(backend.armRequests).toEqual(['arm c1']);
    await settleShell(bed);
    expect(lock(routed(bed))).toBe('[[status.lock.armed]]');

    // Another connection is not armed by it.
    await visit(bed, '/c/c2/explorer');
    expect(lock(routed(bed))).toBe('[[status.lock.locked]]');
    await visit(bed, '/c/c1/explorer');
    expect(lock(routed(bed))).toBe('[[status.lock.armed]]');

    // The window runs out and the bar says locked again, with no further call.
    clock.advance(15 * 60_000);
    await settleShell(bed);
    expect(lock(routed(bed))).toBe('[[status.lock.locked]]');
    expect(backend.armRequests).toEqual(['arm c1']);

    // Locking again by hand reads the same.
    await TestBed.inject(ArmingStore).arm('c1');
    await settleShell(bed);
    expect(lock(routed(bed))).toBe('[[status.lock.armed]]');
    await TestBed.inject(ArmingStore).disarm('c1');
    await settleShell(bed);
    expect(lock(routed(bed))).toBe('[[status.lock.locked]]');
    expect(backend.armRequests).toEqual(['arm c1', 'arm c1', 'disarm c1']);
  });
});
