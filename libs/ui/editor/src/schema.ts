import type { EditorHost, JsonSchema, SchemaEntry, SchemaPort } from './facade';

/**
 * Monaco's JSON diagnostics options are global to the page, so one editor cannot set its schema
 * without replacing the others'. The registry keeps one entry per model URI and gives the port the
 * whole list on every change: an editor binds its own model's URI and removes exactly that entry
 * when its schema is cleared or the editor is destroyed.
 */
export class SchemaRegistry {
  private readonly entries = new Map<string, SchemaEntry>();

  constructor(private readonly port: SchemaPort) {}

  set(modelUri: string, schema: JsonSchema): void {
    this.entries.set(modelUri, {
      uri: `app-schema://${modelUri}`,
      fileMatch: [modelUri],
      schema,
    });
    this.publish();
  }

  /** A model without an entry changes nothing (and calls nothing). */
  remove(modelUri: string): void {
    if (this.entries.delete(modelUri)) this.publish();
  }

  private publish(): void {
    this.port.setSchemas([...this.entries.values()]);
  }
}

const REGISTRIES = new WeakMap<EditorHost, SchemaRegistry>();

/** The one registry of a host, so every editor of the page shares the global option fairly. */
export function schemaRegistryFor(host: EditorHost): SchemaRegistry {
  let registry = REGISTRIES.get(host);
  if (registry === undefined) {
    registry = new SchemaRegistry(host.schemas);
    REGISTRIES.set(host, registry);
  }
  return registry;
}
