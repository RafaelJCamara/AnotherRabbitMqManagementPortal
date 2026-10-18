// Configuration errors name what is wrong (a key, an environment variable, a file) and never
// echo a value: the value may be a secret (I-10).

export interface ConfigIssue {
  /** Dotted path of the key, for example `server.publicUrl`. Empty for a file-level problem. */
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(
      `Invalid configuration:\n${issues
        .map((issue) =>
          issue.path === ''
            ? `  - ${issue.message}`
            : `  - ${issue.path}: ${issue.message}`,
        )
        .join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
