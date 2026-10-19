// Step 9, vendor fingerprints: the objects a provider creates (Amazon MQ's `AWS-DEFAULT-POLICY-*`,
// its operator policy and monitoring user) name the provider even behind a custom host name. The
// patterns are the registry's (`ownedObjects`); an object that matches is also listed as managed, so
// the UI shows it and never edits it (DC-54). Users are read only for an administrator.
import type { Provider } from '@app/domain-model';

import { allProviderPresets, globMatches } from '../providers';
import { read } from '../read';
import { listOf, PolicyItemSchema } from '../schemas';
import { failureReason, type Facts, type ProbeStep } from '../types';

const MAX_OBJECTS = 200;
type Kind = 'policy' | 'operator-policy' | 'user';
type Owned = NonNullable<Facts['vendor']>['objects'][number];

const ItemsSchema = listOf(PolicyItemSchema);

export const vendorFingerprintsStep: ProbeStep = {
  id: 'vendor-fingerprints',
  async run(env, facts: Facts) {
    const owned = allProviderPresets(env.registry).flatMap(({ id, preset }) =>
      preset.ownedObjects.map((object) => ({ provider: id, ...object })),
    );
    if (owned.length === 0) {
      return { status: 'skipped', detail: 'no provider owns objects' };
    }
    const admin = facts.identity?.tags.includes('administrator') === true;
    const lists: readonly { kind: Kind; path: string; enabled: boolean }[] = [
      { kind: 'policy', path: '/api/policies', enabled: true },
      {
        kind: 'operator-policy',
        path: '/api/operator-policies',
        enabled: true,
      },
      { kind: 'user', path: '/api/users', enabled: admin },
    ];

    const providers = new Set<Provider>();
    const objects: Owned[] = [];
    let readable = 0;
    for (const list of lists.filter((entry) => entry.enabled)) {
      let items: readonly { name: string; vhost?: string | undefined }[];
      try {
        items = await read(env, list.path, ItemsSchema);
      } catch (error) {
        if (failureReason(error).status === 'failed') throw error;
        continue;
      }
      readable += 1;
      for (const item of items) {
        const hit = owned.find(
          (object) =>
            object.kind === list.kind && globMatches(object.pattern, item.name),
        );
        if (hit === undefined) continue;
        providers.add(hit.provider);
        objects.push({
          kind: list.kind,
          ...(item.vhost === undefined ? {} : { vhost: item.vhost }),
          name: item.name.slice(0, 256),
        });
      }
    }
    if (readable === 0) {
      return { status: 'unavailable', detail: 'no list could be read' };
    }
    facts.vendor = {
      providers: [...providers],
      objects: objects.slice(0, MAX_OBJECTS),
    };
    return {
      status: 'ok',
      detail: `${String(objects.length)} provider-owned object(s)`,
    };
  },
};
