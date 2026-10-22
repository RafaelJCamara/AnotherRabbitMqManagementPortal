// The smallest part of this library the web shell loads up front (M1-42): the address of an entity and the kinds.
// The shell parses addresses (the connection switcher's notice, the workspace tab of a deep link, the links from the
// operating system) in its main bundle, while the rest of the library (the window source, the entity watch, the
// view definition) belongs to the lazy explorer chunks. Importing `@app/explorer-model` from the shell would pull the
// whole barrel in; this entry point does not. Exported as `@app/explorer-model/entity` (an alias in
// `tsconfig.base.json`, as `/testing` is).
export { EXPLORER_KINDS } from './inventory-model';
export {
  DEFAULT_EXCHANGE_LABEL,
  bindingParts,
  entityLabel,
  entityPath,
  entityUrl,
  parseEntityPath,
  type EntityRef,
  type ParsedEntityAddress,
} from './entity-address';
