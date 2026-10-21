/** The translate function the `*transloco` directive hands a template; pure helpers take it as an argument. */
export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;
