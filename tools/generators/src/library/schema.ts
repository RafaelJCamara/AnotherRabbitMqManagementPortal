import type { LayerType, Runtime } from '../shared/layers.ts';

export interface LibraryOptions {
  name: string;
  type: LayerType;
  runtime?: Runtime;
  directory?: string;
  importPath?: string;
  description?: string;
  trustCritical?: boolean;
}
