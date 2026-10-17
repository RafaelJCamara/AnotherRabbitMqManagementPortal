export interface SemanticsCellOptions {
  /** A number when given as `--era=4.3`: the Nx CLI parses it that way. */
  era: string | number;
  queueType: string;
  protocol: string;
  action: string;
  cf: string;
  limit?: string;
  delayedRetry?: string;
}
