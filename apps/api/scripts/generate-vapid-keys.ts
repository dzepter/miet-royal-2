import webpush from 'web-push';

/**
 * Phase 12 (push): VAPID-Schlüsselpaar für Web Push erzeugen (RFC 8292).
 * Gibt die Werte NUR auf stdout aus – nichts wird gespeichert, geloggt oder
 * in die Datenbank geschrieben. Je Umgebung (production/staging/demo) ein
 * eigenes Paar erzeugen und als PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY
 * in der Server-Umgebung (nie im Repo) hinterlegen.
 *
 *   pnpm --filter @mietroyal/api push:generate-vapid-keys
 */
const keys = webpush.generateVAPIDKeys();
process.stdout.write(
  [
    '# Web Push – VAPID (einmalig je Umgebung erzeugen, privat halten)',
    `PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
    'PUSH_VAPID_SUBJECT=mailto:it@example.de',
    '',
  ].join('\n'),
);
