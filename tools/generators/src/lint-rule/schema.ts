export interface LintRuleOptions {
  id: string;
  severity?: 'info' | 'warn' | 'error';
  /** A number when given as `--since=4.3`: the Nx CLI parses it that way. */
  since: string | number;
}
