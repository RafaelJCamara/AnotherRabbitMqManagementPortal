// A gate's `source` is free text from the engine: an id such as `prod-lock`, or a documentation
// link. Only an absolute https URL without credentials becomes a link; anything else is shown as
// plain text, so a source can never become a `javascript:` or `data:` target or a phishing URL
// with a user name in front of the host.
export interface SourceLink {
  readonly href: string;
  readonly host: string;
}

/** Whitespace and control characters, which URL parsing would silently strip or normalise. */
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f]/;

export function parseSourceLink(source: string | undefined): SourceLink | null {
  if (source === undefined || UNSAFE_CHARACTERS.test(source)) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname === ''
  ) {
    return null;
  }
  return { href: url.href, host: url.hostname };
}
