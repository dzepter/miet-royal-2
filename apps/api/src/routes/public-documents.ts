import type { AppConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from '../auth/http.ts';
import type { CustomerDocumentLinkService } from '../communication/document-links.ts';

/**
 * Öffentlicher Dokumentzugang (Phase 12, Order §13): GENAU ein unveränderliches
 * Dokument je Token (z. B. Rückgabeprotokoll aus der Schaden-/Fehlteil-
 * Information). Kein Login; Autorität ist ausschließlich das Token (nur als
 * Hash gespeichert). Ungültig/abgelaufen/widerrufen ⇒ neutrales 404; IP-Rate-
 * Limit; Antwort nie cachebar; Pfad im Request-Log maskiert (app.ts).
 * Die Web-App-Seite `/dokument/<token>` (Mail-Link) lädt dieses Dokument.
 */
interface PublicDocumentRouteOptions {
  config: AppConfig;
  documentLinks: CustomerDocumentLinkService;
  rateLimitEnabled: boolean;
}

/** Jede Form ⇒ neutrales 404 (die Formatprüfung macht `resolve`, nie ein 400 mit Details). */
const tokenParams = z.object({ token: z.string().max(256) });

export function registerPublicDocumentRoutes(
  app: FastifyInstance,
  options: PublicDocumentRouteOptions,
): void {
  const publicLimit = (max: number) =>
    options.rateLimitEnabled
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
          },
        }
      : false;

  app.get('/public/documents/:token', { config: publicLimit(30) }, async (request, reply) => {
    const params = parseOrThrow(tokenParams, request.params, 'params');
    const resolved = await options.documentLinks.resolve(params.token);
    if (resolved === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Dieses Dokument ist nicht verfügbar.');
      return;
    }
    const filename = `${resolved.document.type.replace(/[^a-z_]/g, '')}.pdf`;
    return reply
      .header('content-type', resolved.document.mimeType)
      .header('content-disposition', `inline; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(Buffer.from(resolved.bytes));
  });
}
