// Generators for `pnpm nx g @app/generators:<name>` (M0-08). generators.json maps each name to
// its factory; this barrel exists for the `@app/generators` path alias and for the unit tests.
export { adapterGenerator } from './adapter/generator.ts';
export { conformanceCellGenerator } from './conformance-cell/generator.ts';
export { decoderGenerator } from './decoder/generator.ts';
export { eslintRuleGenerator } from './eslint-rule/generator.ts';
export { libraryGenerator } from './library/generator.ts';
export { lintRuleGenerator } from './lint-rule/generator.ts';
export { migrationGenerator } from './migration/generator.ts';
export { semanticsCellGenerator } from './semantics-cell/generator.ts';
export { serviceModuleGenerator } from './service-module/generator.ts';
export { uiFeatureGenerator } from './ui-feature/generator.ts';
