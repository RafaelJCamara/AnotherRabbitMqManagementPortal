// Step 8, flags: `GET /api/feature-flags` and `GET /api/deprecated-features/used`. The state of
// `rabbitmq_4.3.0` decides the era; a broker that does not list flags (LavinMQ) leaves them unknown.
import { failureReason, type ProbeStep } from '../types';
import { read } from '../read';
import { FeatureFlagsSchema, NamedListSchema } from '../schemas';

const MAX_ENTRIES = 500;
const MAX_NAME = 128;

export const featureFlagsStep: ProbeStep = {
  id: 'feature-flags',
  async run(env, facts) {
    const flags = await read(env, '/api/feature-flags', FeatureFlagsSchema);
    facts.featureFlags = Object.fromEntries(
      flags
        .slice(0, MAX_ENTRIES)
        .map((flag) => [flag.name.slice(0, MAX_NAME), flag.state]),
    );
    // The deprecated features in use are a bonus: a broker without the endpoint still has its flags.
    try {
      const used = await read(
        env,
        '/api/deprecated-features/used',
        NamedListSchema,
      );
      facts.deprecatedUsed = used
        .slice(0, MAX_ENTRIES)
        .map((feature) => feature.name.slice(0, MAX_NAME));
    } catch (error) {
      if (failureReason(error).status === 'failed') throw error;
    }
    return { status: 'ok', detail: `${String(flags.length)} flag(s)` };
  },
};
