import { typescriptTester } from '../test-utils.ts';
import { noBrokerVersionCompare } from './no-broker-version-compare.ts';

typescriptTester().run('no-broker-version-compare', noBrokerVersionCompare, {
  valid: [
    // Looking a behaviour up in the registry is the intended way.
    "const cell = semantics.lookup(profile.era, 'quorum', 'nack');",
    'if (profile.gates.shovelMove.enabled) run();',
    // Version-looking strings that are not compared.
    "const pinned = ['4.3.0', '4.2.9'];",
    "const label = `RabbitMQ ${'4.3.0'}`;",
    "expect(version).toBe('4.3.0');",
    // Equality with non-version strings and numbers.
    "if (kind === 'quorum') run();",
    'if (count >= 4) run();',
    'if (a.localeCompare(b) < 0) run();',
    // A local helper that does not take a literal version.
    'if (compareVersions(a, b) > 0) run();',
    // semver helpers that do not compare.
    "import semver from 'semver'; semver.valid(version);",
  ],
  invalid: [
    {
      code: "if (version === '4.3.0') run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (version >= '4.3.0') run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "const newer = '4.0.0' < broker.version;",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (brokerVersion !== 'v3.13.7') run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (version.startsWith('4.3') && version == '4.3.x') run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: 'if (version.major >= 4) run();',
      errors: [{ messageId: 'compare' }],
    },
    {
      code: 'if (4 > parsed.minor) run();',
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "import * as semver from 'semver'; if (semver.gte(version, minimum)) run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "import semver from 'semver'; semver.satisfies(version, range);",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "import { gte as atLeast } from 'semver'; if (atLeast(version, minimum)) run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "import gte from 'semver/functions/gte'; gte(version, minimum);",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (compareVersions(version, '4.3.0') >= 0) run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (versions.gte(current, '4.3.0')) run();",
      errors: [{ messageId: 'compare' }],
    },
    {
      code: "if (version.localeCompare('4.3.0', undefined, { numeric: true }) >= 0) run();",
      errors: [{ messageId: 'compare' }],
    },
  ],
});
