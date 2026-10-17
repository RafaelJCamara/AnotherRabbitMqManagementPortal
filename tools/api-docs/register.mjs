// Lets Node resolve the `@app/contracts` path alias (tsconfig.base.json) when it runs the emitter
// directly on TypeScript: `node --import ./tools/api-docs/register.mjs tools/api-docs/emit-specs.ts`.
import { registerHooks } from 'node:module';

const contracts = new URL(
  '../../libs/shared/contracts/src/index.ts',
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@app/contracts') {
      return { url: contracts, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
