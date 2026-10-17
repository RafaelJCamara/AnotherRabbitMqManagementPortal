// Contracts are written once, in zod, and generate the OpenAPI/AsyncAPI specs, the MCP tools and the
// UI validators (ADR-003). A schema that accepts anything (`z.any()`) or lets unknown keys through
// (`.passthrough()`, `z.looseObject`, `.loose()`, `.catchall(...)`) leaks into every generated
// artefact, so each field has to be spelled out. The rule works on names, so it needs neither zod
// nor @app/contracts to be installed: it follows imports from `zod`, `zod/*` and `@app/contracts`.
import { defineRule, propertyName, trailingName } from '../utils.ts';

const SCHEMA_SOURCES = /^(?:zod(?:\/.*)?|@app\/contracts)$/;

/** zod functions that build a schema which accepts anything or any extra keys. */
const LOOSE_FACTORIES = new Set(['any', 'looseObject']);
/** Methods that open an object schema to unknown keys; flagged wherever they appear. */
const ALWAYS_LOOSE_METHODS = new Set(['passthrough', 'nonstrict']);
/** Methods generic enough to need a zod import in the file before they count. */
const LOOSE_METHODS = new Set(['loose', 'catchall']);

export const explicitZodSchemas = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require explicit zod schemas: no z.any(), z.looseObject(), .passthrough(), .loose() or .catchall().',
    },
    schema: [],
    messages: {
      factory:
        "'{{name}}' accepts any value or key. Spell out the fields so the generated specs, MCP tools and UI validators stay exact.",
      method:
        "'.{{name}}()' lets unknown keys through. Spell out the fields, or use a strict object.",
    },
  },
  create(context) {
    const namespaces = new Set<string>();
    const factories = new Map<string, string>();
    let importsSchemaLibrary = false;

    return {
      ImportDeclaration(node) {
        if (!SCHEMA_SOURCES.test(String(node.source.value))) return;
        importsSchemaLibrary = true;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') {
            namespaces.add(specifier.local.name);
            continue;
          }
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (imported === 'z') namespaces.add(specifier.local.name);
          else if (LOOSE_FACTORIES.has(imported)) {
            factories.set(specifier.local.name, imported);
          }
        }
      },

      CallExpression(node) {
        const { callee } = node;
        if (callee.type === 'Super') return;

        // z.any(), z.looseObject({...}), and `any()` imported by name.
        if (callee.type === 'Identifier') {
          const name = factories.get(callee.name);
          if (name !== undefined) {
            context.report({
              node,
              messageId: 'factory',
              data: { name: `z.${name}` },
            });
          }
          return;
        }
        if (callee.type !== 'MemberExpression') return;

        const name = propertyName(callee);
        if (name === null) return;
        if (
          callee.object.type === 'Identifier' &&
          namespaces.has(callee.object.name) &&
          LOOSE_FACTORIES.has(name)
        ) {
          context.report({
            node,
            messageId: 'factory',
            data: { name: `${callee.object.name}.${name}` },
          });
          return;
        }

        const isLoose =
          ALWAYS_LOOSE_METHODS.has(name) ||
          (importsSchemaLibrary && LOOSE_METHODS.has(name));
        if (!isLoose) return;
        // `.catchall(z.never())` is how a strict object is spelled in zod 3.
        if (name === 'catchall') {
          const [argument] = node.arguments;
          const argumentCallee =
            argument?.type === 'CallExpression' ? argument.callee : null;
          if (
            argumentCallee &&
            argumentCallee.type !== 'Super' &&
            trailingName(argumentCallee) === 'never'
          ) {
            return;
          }
        }
        context.report({ node, messageId: 'method', data: { name } });
      },
    };
  },
});
