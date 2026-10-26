import type {
  EditorRealm,
  TrustedPolicyLike,
  TrustedPolicyRules,
  TrustedTypesFactoryLike,
} from './realm';

/** A value a fake policy minted, so a spec can see which policy made it and from what. */
export interface Minted {
  readonly kind: 'html' | 'script-url';
  readonly policy: string;
  readonly value: string;
}

/** A `trustedTypes` that records the names given to `createPolicy`. */
export class FakeTrustedTypes implements TrustedTypesFactoryLike {
  readonly created: string[] = [];
  /** Names the page's `trusted-types` directive does not list; creating one throws like a browser. */
  readonly refused = new Set<string>();

  createPolicy(name: string, rules: TrustedPolicyRules): TrustedPolicyLike {
    if (this.refused.has(name)) throw new TypeError(`policy ${name} refused`);
    this.created.push(name);
    return {
      createHTML: (input, ...rest) => {
        if (rules.createHTML === undefined)
          throw new TypeError('no createHTML');
        return {
          kind: 'html',
          policy: name,
          value: rules.createHTML(input, ...rest),
        } satisfies Minted;
      },
      createScriptURL: (input, ...rest) => {
        if (rules.createScriptURL === undefined) {
          throw new TypeError('no createScriptURL');
        }
        return {
          kind: 'script-url',
          policy: name,
          value: rules.createScriptURL(input, ...rest),
        } satisfies Minted;
      },
    };
  }
}

export interface WorkerCall {
  readonly url: unknown;
  readonly options: unknown;
}

export interface FakeRealm extends EditorRealm {
  readonly document: {
    querySelector: (selector: string) => { readonly content?: string } | null;
    createElement: (tagName: string) => unknown;
  };
  readonly workers: WorkerCall[];
  readonly trustedTypes: FakeTrustedTypes | undefined;
}

export function fakeRealm(
  options: { trustedTypes?: boolean; origin?: string; nonce?: string } = {},
): FakeRealm {
  const origin = options.origin ?? 'http://127.0.0.1:4200';
  const workers: WorkerCall[] = [];
  const trustedTypes =
    options.trustedTypes === false ? undefined : new FakeTrustedTypes();
  class FakeWorker {
    readonly url: unknown;
    constructor(url: unknown, workerOptions?: unknown) {
      this.url = url;
      workers.push({ url, options: workerOptions });
    }
  }
  return {
    workers,
    trustedTypes,
    document: {
      querySelector: () =>
        options.nonce === undefined ? null : { content: options.nonce },
      createElement: () => ({}),
    },
    location: { origin, href: `${origin}/c/dev/publish` },
    Worker: FakeWorker,
  };
}
