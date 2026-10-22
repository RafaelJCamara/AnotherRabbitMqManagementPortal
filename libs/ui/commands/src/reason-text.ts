// Words for the things the command system reports: why a command is closed, and what the live region says.
// Pure functions of a translate function, so the palette, the cheat sheet, the host and the menu use one text.
import type { Announcement } from './announcer';
import type { DisabledReason } from './availability';

/** The translate function a `*transloco` template hands out. */
export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

/** Why a command is closed, in words: the engine's own reason as sent, with its source when it sent one. */
export function describeReason(reason: DisabledReason, t: Translate): string {
  switch (reason.kind) {
    case 'gate': {
      const text = reason.reason.trim();
      const body = text === '' ? t('palette.reason.gateNoReason') : text;
      return reason.source === undefined || reason.source === ''
        ? body
        : t('palette.reason.withSource', {
            reason: body,
            source: reason.source,
          });
    }
    case 'not-allowed':
      return t('palette.reason.notAllowed', { action: reason.action });
    case 'loading':
      return t('palette.reason.loading');
    case 'unknown':
      return t('palette.reason.unknown');
    case 'own':
      return reason.text;
  }
}

const isReason = (value: unknown): value is DisabledReason =>
  typeof value === 'object' && value !== null && 'kind' in value;

/** The sentence for the polite live region. */
export function announcementText(
  announcement: Announcement,
  t: Translate,
): string {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(announcement.params)) {
    params[name] = isReason(value) ? describeReason(value, t) : value;
  }
  return t(`palette.announce.${announcement.key}`, params);
}
