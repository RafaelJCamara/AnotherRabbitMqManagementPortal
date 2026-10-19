// One HTTP call to a lab broker, with the status and the raw text (the recorder keeps what the
// broker said, including a plain-text 404). Loopback only, no redirects, a hard timeout.

export interface Reply {
  readonly status: number;
  readonly text: string;
  readonly contentType: string;
}

export interface Login {
  readonly username: string;
  readonly password: string;
}

export async function call(
  origin: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  target: string,
  options: {
    readonly login?: Login;
    readonly body?: unknown;
    /** Default `application/json`; the Prometheus page is `text/plain` and answers 406 to JSON. */
    readonly accept?: string;
  } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    accept: options.accept ?? 'application/json',
  };
  if (options.login !== undefined) {
    const pair = `${options.login.username}:${options.login.password}`;
    headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${origin}${target}`, {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { body }),
  });
  return {
    status: response.status,
    text: await response.text(),
    contentType: response.headers.get('content-type') ?? '',
  };
}
