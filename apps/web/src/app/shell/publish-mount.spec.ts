import { fakeHost, provideFakeLoader } from '@app/ui-editor/testing';
import { describe, expect, it } from 'vitest';

import { shellRoute } from './shell.routes';
import { mountShell, routed, until, visit } from './test-fixtures';

/** The studio is a lazy library: neither the app nor its specs import it statically. */
async function mountWithStudio() {
  const { MESSAGES_SCOPE_LOADER } = await import('@app/feature-messages');
  const { markedMessagesScope } = await import('@app/feature-messages/testing');
  return await mountShell(undefined, undefined, undefined, [
    { provide: MESSAGES_SCOPE_LOADER, useValue: markedMessagesScope },
    provideFakeLoader(fakeHost()),
  ]);
}

describe('the publish studio under the shell', () => {
  it('M1-46 AC-19 mounts the studio lazily and does nothing without a connection', async () => {
    // Lazy: the route carries a loader and nothing of the feature, so its code is not in the initial chunk.
    const route = shellRoute.children?.find(
      (child) => child.path === 'publish',
    );
    expect(route?.loadChildren).toBeTypeOf('function');
    expect(route?.component).toBeUndefined();
    expect(route?.loadComponent).toBeUndefined();
    expect(route?.children).toBeUndefined();

    const bed = await mountWithStudio();
    await visit(bed, '/c/c1/publish');
    await until(
      bed,
      () => routed(bed).querySelector('main app-publish-studio h1') !== null,
      'the studio heading',
    );
    const host = routed(bed);
    expect(host.tagName.toLowerCase()).toBe('app-shell');
    expect(host.querySelector('main app-publish-studio h1')?.textContent).toBe(
      '[[publish.title]]',
    );
    expect(host.querySelector('app-not-found')).toBeNull();

    // An address under the studio is not the studio's: the shell's own not-found view.
    await visit(bed, '/c/c1/publish/unknown');
    expect(routed(bed).querySelector('main app-not-found')).not.toBeNull();
    expect(routed(bed).querySelector('app-publish-studio')).toBeNull();

    // An id that is not a plain token is no connection: nothing of the studio, and no call at all.
    const before = bed.engine.requests.length;
    await visit(bed, '/c/not%20an%20id/publish');
    expect(routed(bed).querySelector('main app-no-connection')).not.toBeNull();
    expect(routed(bed).querySelector('app-publish-studio')).toBeNull();
    expect(bed.engine.requests.length).toBe(before);
  });
});
