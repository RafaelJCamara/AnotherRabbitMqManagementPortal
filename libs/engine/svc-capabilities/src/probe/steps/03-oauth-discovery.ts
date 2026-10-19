// Step 3, OAuth discovery: `GET /js/oidc-oauth/bootstrap.js`, and `GET /api/auth` for 4.1 and
// earlier. The issuer is only ever read here, never pinned (that is svc-identity's). A page that does
// not say it plainly gives no issuer: an unreadable answer is "no OAuth known", not a guess.
//
// The lab broker (4.3.6) serves the script, `set_oauth_settings({"oauth_enabled":false});` among
// other lines, and answers `/api/auth` with 406: a release that does not serve an endpoint is not a
// failure of the probe, the step ends "unavailable" with no issuer (OQ-473 says what is unverified).
import { read, readText } from '../read';
import { AuthDiscoverySchema } from '../schemas';
import { failureReason, type Facts, type ProbeStep } from '../types';

const ISSUER_MAX = 2048;

/** An http(s) URL of sane length, or undefined. */
function issuerOf(text: string | undefined): string | undefined {
  if (text === undefined || text.length > ISSUER_MAX) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/** The page is a script; it carries the settings as JSON-looking text. */
export function oauthFromBootstrap(script: string): string | undefined {
  if (!/["']?oauth_enabled["']?\s*:\s*true/.test(script)) return undefined;
  const found = /["']?oauth_provider_url["']?\s*:\s*["']([^"']+)["']/.exec(
    script,
  );
  return issuerOf(found?.[1]);
}

export const oauthDiscoveryStep: ProbeStep = {
  id: 'oauth-discovery',
  async run(env, facts: Facts) {
    try {
      const issuer = oauthFromBootstrap(
        await readText(env, '/js/oidc-oauth/bootstrap.js'),
      );
      if (issuer !== undefined) {
        facts.oauth = { issuer, source: 'bootstrap.js' };
        return { status: 'ok', detail: 'OAuth is configured (bootstrap.js)' };
      }
    } catch {
      // Absent, refused or not served to this client: the older endpoint may still say.
      env.signal.throwIfAborted();
    }
    try {
      const auth = await read(env, '/api/auth', AuthDiscoverySchema);
      const issuer =
        auth.oauth_enabled === true
          ? issuerOf(auth.oauth_provider_url)
          : undefined;
      if (issuer !== undefined) {
        facts.oauth = { issuer, source: 'api/auth' };
        return { status: 'ok', detail: 'OAuth is configured (/api/auth)' };
      }
    } catch (error) {
      // 4.2 and later no longer serve it; only a broker that failed is a failure of the step.
      const { status } = failureReason(error);
      if (status === 'failed' && !isNotServed(error)) throw error;
    }
    return { status: 'unavailable', detail: 'no OAuth configuration found' };
  },
};

/** 406 and 400: the endpoint exists on no release that serves it to this client. */
function isNotServed(error: unknown): boolean {
  const status = (error as { broker?: { code?: unknown } } | null)?.broker
    ?.code;
  return status === 406 || status === 400;
}
