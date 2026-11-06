import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Phase 16 (CMS): fachliche Fehler des Website-CMS mit festem HTTP-Status und
 * maschinenlesbarem Code (Design §2.2). Meldungen sind neutral und enthalten nie
 * Inhalte, Tokens oder Storage-Keys; `issues` tragen nur Feldpfade + Meldung.
 */
export type CmsErrorCode =
  | 'NOT_FOUND'
  | 'CMS_DRAFT_CONFLICT'
  | 'CMS_PUBLISH_STALE'
  | 'CMS_ALREADY_PUBLISHED'
  | 'CMS_NOT_PUBLISHED'
  | 'CMS_UNPUBLISH_FORBIDDEN'
  | 'CMS_PATH_TAKEN'
  | 'CMS_CONTENT_INVALID'
  | 'CMS_PUBLISH_INCOMPLETE'
  | 'CMS_PRICE_TEXT_FORBIDDEN'
  | 'CMS_EXACT_ADDRESS_FORBIDDEN'
  | 'CMS_RECOMMENDATION_INVALID'
  | 'CMS_MEDIA_UNKNOWN'
  | 'CMS_MEDIA_REJECTED'
  | 'CMS_PREVIEW_UNAVAILABLE'
  | 'CMS_PREVIEW_INVALID';

const CMS_ERROR_STATUS: Record<CmsErrorCode, number> = {
  NOT_FOUND: 404,
  CMS_DRAFT_CONFLICT: 409,
  CMS_PUBLISH_STALE: 409,
  CMS_ALREADY_PUBLISHED: 409,
  CMS_NOT_PUBLISHED: 409,
  CMS_UNPUBLISH_FORBIDDEN: 409,
  CMS_PATH_TAKEN: 409,
  CMS_CONTENT_INVALID: 400,
  CMS_PUBLISH_INCOMPLETE: 400,
  CMS_PRICE_TEXT_FORBIDDEN: 400,
  CMS_EXACT_ADDRESS_FORBIDDEN: 400,
  CMS_RECOMMENDATION_INVALID: 400,
  CMS_MEDIA_UNKNOWN: 400,
  CMS_MEDIA_REJECTED: 400,
  CMS_PREVIEW_UNAVAILABLE: 409,
  CMS_PREVIEW_INVALID: 401,
};

export interface CmsIssue {
  /** Feldpfad (z. B. `content.blocks.2.body`) – nie der Wert. */
  path: string;
  message: string;
}

export class CmsError extends Error {
  readonly code: CmsErrorCode;
  readonly status: number;
  readonly issues: readonly CmsIssue[] | undefined;

  constructor(code: CmsErrorCode, message: string, issues?: readonly CmsIssue[]) {
    super(message);
    this.name = 'CmsError';
    this.code = code;
    this.status = CMS_ERROR_STATUS[code];
    this.issues = issues;
  }
}

export const CMS_MESSAGES = {
  NOT_FOUND: 'Eintrag nicht gefunden.',
  REVISION_NOT_FOUND: 'Revision nicht gefunden.',
  MEDIA_NOT_FOUND: 'Medium nicht gefunden.',
  DRAFT_CONFLICT: 'Der Entwurf wurde inzwischen geändert – bitte neu laden.',
  PUBLISH_STALE:
    'Veröffentlicht werden kann nur der aktuelle Entwurf. Der Entwurf wurde inzwischen geändert – bitte neu laden.',
  ALREADY_PUBLISHED: 'Dieser Stand ist bereits veröffentlicht.',
  NOT_PUBLISHED: 'Diese Seite ist nicht veröffentlicht.',
  UNPUBLISH_FORBIDDEN: 'Nur regionale Seiten und sekundäre Angebote können zurückgezogen werden.',
  PATH_TAKEN: 'Unter dieser Adresse gibt es bereits eine Seite.',
  CONTENT_INVALID: 'Der Inhalt erfüllt die Regeln dieses Seitentyps nicht.',
  PUBLISH_INCOMPLETE: 'Zum Veröffentlichen fehlen Pflichtangaben.',
  PRICE_TEXT_FORBIDDEN:
    'Preise dürfen nicht als Text im CMS stehen – sie kommen automatisch aus „Produkte & Preise“.',
  EXACT_ADDRESS_FORBIDDEN:
    'Die genaue Abholadresse darf auf der Website nicht erscheinen – bitte nur „Mainz-Hechtsheim“ nennen.',
  RECOMMENDATION_INVALID:
    'Empfehlungsregeln dürfen nur auf aktive Slush-Maschinen verweisen und sich nicht überschneiden.',
  MEDIA_UNKNOWN: 'Ein verwendetes Bild existiert nicht (mehr) in der Medienliste.',
  MEDIA_REJECTED: 'Nur JPEG-, PNG- oder WebP-Bilder bis 6 MB sind erlaubt.',
  MEDIA_TOO_LARGE: 'Das Bild muss zwischen 1 Byte und 6 MB groß sein.',
  PREVIEW_UNAVAILABLE:
    'Die Vorschau ist in dieser Umgebung nicht eingerichtet (öffentliche Web-Adresse fehlt).',
  PREVIEW_INVALID: 'Dieser Vorschau-Link ist ungültig oder abgelaufen.',
} as const;

/** Antwortet mit der strukturierten Fehlerform der API; andere Fehler laufen weiter. */
export function sendCmsError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (!(error instanceof CmsError)) return false;
  void reply.status(error.status).send({
    error: {
      code: error.code,
      message: error.message,
      correlationId: request.id,
      ...(error.issues === undefined || error.issues.length === 0 ? {} : { issues: error.issues }),
    },
  });
  return true;
}
