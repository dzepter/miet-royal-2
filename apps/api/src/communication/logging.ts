/**
 * Pino-Redaction für Kommunikations-Geheimnisse (Phase 12, Order §38): SMTP-/
 * IMAP-Passwörter, WhatsApp-Token/App-Secret, Push-Private-Key und der
 * Communication-Payload-Key dürfen unter keinem Pfad im Log landen – egal ob
 * ein Config-Objekt direkt, unter `config` oder in einem verschachtelten
 * Kontext geloggt wird. API (app.ts) und Worker (main.ts) nutzen dieselbe Liste.
 */
const SECRET_PATHS = [
  'mail.smtp.password',
  'mail.imap.password',
  'smtp.password',
  'imap.password',
  'whatsapp.accessToken',
  'whatsapp.appSecret',
  'push.vapidPrivateKey',
  'communication.payloadKey',
  'communication.payloadKeyPrevious',
] as const;

export const COMMUNICATION_LOG_REDACT_PATHS: readonly string[] = SECRET_PATHS.flatMap((path) => [
  path,
  `*.${path}`,
  `config.${path}`,
  `*.config.${path}`,
]);
