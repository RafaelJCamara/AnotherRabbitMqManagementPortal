// What the action generator knows about the action it is asked for: every option is parsed and
// checked here, before any file is written, with a message that tells an agent what to change. The
// checks mirror the kit invariants of @app/contracts (`checkRegistry`); the unit spec of every
// generated action runs `checkRegistry` itself, so the two cannot drift unnoticed.
import { assertKebab, nameVariants, stem } from '../shared/names.ts';
import type { ActionOptions } from './schema.ts';

export const KINDS = ['query', 'command', 'peek', 'job'] as const;
export type Kind = (typeof KINDS)[number];
export const RISKS = ['none', 'low', 'medium', 'high', 'critical'] as const;
export type Risk = (typeof RISKS)[number];
export const PLANNINGS = ['none', 'optional', 'required'] as const;
export type Planning = (typeof PLANNINGS)[number];
export const MCP_MODES = ['none', 'read', 'mutating'] as const;
export type McpMode = (typeof MCP_MODES)[number];
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** `namespace.verb`, the same shape as `ID_FORMAT` in contracts/kit/invariants.ts. */
const ACTION_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
/**
 * `area.verb`, exactly: the role authorizer of the kernel matches two segments and refuses a grant
 * for any other shape, so a three-part permission could never be granted to a role (it fails
 * closed). The catalogue entries with a qualifier wait for the authorizer (OQ-322).
 */
const PERMISSION = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const CLI_COMMAND = /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/;
const SINCE = /^\d+\.\d+$/;
const PARAM = /^[A-Za-z][A-Za-z0-9]*$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
/** What a summary may not say about a read of messages (AGENTS.md section 1, DC-15). */
const FORBIDDEN_WORDING = /non[- ]?destructive|read[- ]?only/i;
const MAX_TEXT = 200;

export interface PathParam {
  readonly name: string;
  /** The zod schema the contract file uses for it. */
  readonly schema: 'ConnectionIdSchema' | 'ObjectKeySchema' | 'string';
  /** A value that passes the schema, for the generated specs. */
  readonly sample: string;
}

export interface ActionModel {
  readonly id: string;
  /** `explorer-queues-list`: the file stem everywhere. */
  readonly stem: string;
  /** `ExplorerQueuesList` and `explorerQueuesList`. */
  readonly pascal: string;
  readonly camel: string;
  /** `svc-explorer`. */
  readonly module: string;
  /** Explorer for svc-explorer: the name part of the module's own exports. */
  readonly modulePascal: string;
  readonly kind: Kind;
  readonly summary: string;
  readonly permission: string;
  readonly risk: Risk;
  readonly planning: Planning;
  readonly mcp: McpMode;
  readonly cli: string | undefined;
  readonly since: string;
  readonly http: { method: Method; path: string } | undefined;
  readonly params: readonly PathParam[];
  /** The UI feature that gets the command stub; undefined for `--feature=none`. */
  readonly feature: string | undefined;
  /** Anything but a query, or a query whose MCP tool is declared mutating. */
  readonly mutating: boolean;
  readonly audit: 'none' | 'attempt+outcome';
  /** Does `implementAction` need plan() and revalidate()? */
  readonly planned: boolean;
}

const oneOf = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  option: string,
): T | undefined => {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `--${option} must be one of ${allowed.join(', ')}; got "${value}".`,
  );
};

/** Text that ends up between quotes in source and in a spec: short, one line, no control characters. */
export function assertText(value: string, what: string): string {
  const text = value.trim();
  let controls = false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) controls = true;
  }
  if (text.length === 0 || text.length > MAX_TEXT || controls) {
    throw new Error(
      `${what} must be one line of 1 to ${String(MAX_TEXT)} characters.`,
    );
  }
  return text;
}

export function assertWording(text: string, what: string): void {
  if (FORBIDDEN_WORDING.test(text)) {
    throw new Error(
      `${what} must not call a read of messages "non-destructive" or "read-only"; say "side-effect-aware peek" (DC-15, AGENTS.md section 1).`,
    );
  }
}

export function assertPermission(value: string): string {
  if (!PERMISSION.test(value)) {
    throw new Error(
      `--permission "${value}" must look like area.verb (for example messages.purge), from the RBAC catalogue of blueprint 7.3.`,
    );
  }
  return value;
}

function paramOf(name: string): PathParam {
  if (name === 'cid' || name === 'connectionId') {
    return { name, schema: 'ConnectionIdSchema', sample: 'c1' };
  }
  if (name === 'qkey' || name === 'xkey' || name === 'objectKey') {
    // base64url of "/\u0000orders": a real ObjectKey for the default vhost.
    return { name, schema: 'ObjectKeySchema', sample: 'LwBvcmRlcnM' };
  }
  return { name, schema: 'string', sample: 'sample' };
}

/** `POST /connections/{cid}/queues/{qkey}/purge`, checked segment by segment. */
export function parseHttp(value: string): {
  http: { method: Method; path: string };
  params: PathParam[];
} {
  const match = /^([A-Za-z]+) (\/\S*)$/.exec(value.trim());
  const method = match?.[1]?.toUpperCase();
  const path = match?.[2];
  if (method === undefined || path === undefined) {
    throw new Error(
      `--http "${value}" must be METHOD /path, for example 'POST /connections/{cid}/queues/{qkey}/purge'.`,
    );
  }
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new Error(
      `--http method "${method}" must be one of ${METHODS.join(', ')}.`,
    );
  }
  const params: PathParam[] = [];
  for (const segment of path.slice(1).split('/')) {
    const param = /^\{([^{}]*)\}$/.exec(segment)?.[1];
    if (param !== undefined) {
      if (!PARAM.test(param) || params.some((have) => have.name === param)) {
        throw new Error(
          `--http path parameter "{${param}}" must be a unique name of letters and digits.`,
        );
      }
      params.push(paramOf(param));
    } else if (!SEGMENT.test(segment)) {
      throw new Error(
        `--http path segment "${segment}" may only hold letters, digits, - and _ (the router refuses anything else).`,
      );
    }
  }
  return { http: { method: method as Method, path }, params };
}

function defaultSummary(id: string): string {
  const words = id.replace(/[.-]/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** An id of an action, topic or job: lowercase words, dot separated (`queues.purge`). */
export function assertId(id: string, what: string): void {
  if (!ACTION_ID.test(id)) {
    throw new Error(
      `${what} "${id}" must look like namespace.name: lowercase, dot separated (for example queues.purge).`,
    );
  }
}

export function parseAction(options: ActionOptions): ActionModel {
  const id = options.name;
  assertId(id, 'Action id');
  const module = options.module;
  assertKebab(module, '--module');
  const moduleName = `svc-${stem(module, 'svc')}`;
  const kind = oneOf(options.kind, KINDS, 'kind');
  if (kind === undefined) {
    throw new Error(`--kind is required: one of ${KINDS.join(', ')}.`);
  }
  const permission = assertPermission(options.permission);
  const query = kind === 'query';

  const mcp = oneOf(options.mcp, MCP_MODES, 'mcp') ?? 'none';
  if (!query && mcp === 'read') {
    throw new Error(
      `--mcp=read would present a ${kind} action as a read tool; use --mcp=mutating or --mcp=none.`,
    );
  }
  // Anything but a query changes state or touches messages, and so does a query whose MCP tool
  // is declared mutating: the prod lock and the audit treat it as a mutation, so must the stub.
  const mutating = !query || mcp === 'mutating';

  // A mutation states its risk and its planning. Nothing is defaulted that could make it quieter.
  const risk =
    oneOf(options.risk, RISKS, 'risk') ?? (mutating ? undefined : 'none');
  const planning =
    oneOf(options.planning, PLANNINGS, 'planning') ??
    (mutating ? undefined : 'none');
  if (risk === undefined || planning === undefined) {
    throw new Error(
      `A ${kind} action that is exposed as a mutation changes state or touches messages: state --risk and --planning explicitly.`,
    );
  }
  if ((risk === 'high' || risk === 'critical') && planning === 'none') {
    throw new Error(
      `A ${risk} action must be planned: use --planning=optional or required (the environment policy can only raise it).`,
    );
  }

  const parsedHttp =
    options.http === undefined ? undefined : parseHttp(options.http);
  if (parsedHttp?.http.method === 'GET' && !query) {
    throw new Error(
      `GET can only be bound to a query action, not to kind '${kind}'.`,
    );
  }

  const cli = options.cli === undefined ? undefined : options.cli.trim();
  if (cli !== undefined && !CLI_COMMAND.test(cli)) {
    throw new Error(
      `--cli "${cli}" must be words of lowercase letters, digits and -, for example 'queues purge'.`,
    );
  }
  const since = options.since ?? '1.0';
  if (!SINCE.test(since))
    throw new Error(`--since "${since}" must be major.minor, for example 1.0.`);

  const summary = assertText(
    options.summary ?? defaultSummary(id),
    '--summary',
  );
  assertWording(summary, '--summary');

  const names = nameVariants(id.replace(/\./g, '-'));
  const feature =
    options.feature === 'none'
      ? undefined
      : (options.feature ?? stem(module, 'svc'));
  if (feature !== undefined) assertKebab(feature, '--feature');

  return {
    id,
    stem: names.kebab,
    pascal: names.pascal,
    camel: names.camel,
    module: moduleName,
    modulePascal: nameVariants(moduleName.slice('svc-'.length)).pascal,
    kind,
    summary,
    permission,
    risk,
    planning,
    mcp,
    cli,
    since,
    http: parsedHttp?.http,
    params: parsedHttp?.params ?? [],
    feature,
    mutating,
    audit: mutating ? 'attempt+outcome' : 'none',
    planned: mutating || planning !== 'none',
  };
}
