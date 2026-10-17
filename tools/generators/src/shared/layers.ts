// The type:* and runtime:* tags of blueprint 2.1, and what each layer implies for a new project:
// where it lives, which runtimes it may have, and whether it is an Angular project. The
// dependency rules themselves live in eslint.config.mjs; this table only picks sane defaults and
// refuses combinations the rules could never allow.

export const LAYER_TYPES = [
  'contracts',
  'pure',
  'port',
  'kernel',
  'adapter',
  'net',
  'service',
  'transport',
  'ui-platform',
  'ui-data',
  'ui-design',
  'ui-lib',
  'ui-feature',
  'sdk',
  'test',
] as const;
export type LayerType = (typeof LAYER_TYPES)[number];

export const RUNTIMES = [
  'isomorphic',
  'node',
  'browser',
  'electron-main',
  'electron-preload',
] as const;
export type Runtime = (typeof RUNTIMES)[number];

interface Layer {
  /** Parent directory of a new project of this layer. */
  directory: string;
  /** Allowed runtimes; the first one is the default. */
  runtimes: readonly Runtime[];
  /** Angular project: ngc typecheck, decorators, jsdom tests. */
  angular: boolean;
}

const engine = (runtimes: readonly Runtime[]): Layer => ({
  directory: 'libs/engine',
  runtimes,
  angular: false,
});
const ui: Layer = {
  directory: 'libs/ui',
  runtimes: ['browser', 'isomorphic'],
  angular: true,
};

export const LAYERS: Record<LayerType, Layer> = {
  contracts: {
    directory: 'libs/shared',
    runtimes: ['isomorphic'],
    angular: false,
  },
  pure: { directory: 'libs/shared', runtimes: ['isomorphic'], angular: false },
  port: engine(['node', 'isomorphic']),
  kernel: engine(['node']),
  adapter: engine(['node']),
  net: engine(['node']),
  service: engine(['node']),
  transport: engine(['node']),
  'ui-platform': ui,
  'ui-data': ui,
  'ui-design': ui,
  'ui-lib': ui,
  'ui-feature': ui,
  sdk: {
    directory: 'libs/sdk',
    runtimes: ['isomorphic', 'node'],
    angular: false,
  },
  test: {
    directory: 'libs',
    runtimes: ['node', 'browser', 'isomorphic'],
    angular: false,
  },
};

/**
 * The only top-level directories eslint.config.mjs scans for projects. A project anywhere else
 * would get no tags-based confinement zone, so the generators refuse to create one there.
 */
export const PROJECT_ROOTS = [
  'apps',
  'libs',
  'tools',
  'testing',
  'packaging',
] as const;

export function isLayerType(value: string): value is LayerType {
  return (LAYER_TYPES as readonly string[]).includes(value);
}

export function defaultRuntime(type: LayerType): Runtime {
  return LAYERS[type].runtimes[0] ?? 'node';
}

/** Throws when `runtime` is not allowed for `type`. */
export function assertRuntime(type: LayerType, runtime: Runtime): void {
  const allowed = LAYERS[type].runtimes;
  if (!allowed.includes(runtime)) {
    throw new Error(
      `type:${type} projects may only be ${allowed.map((r) => `runtime:${r}`).join(' or ')}, not runtime:${runtime} (blueprint 2.1).`,
    );
  }
}
