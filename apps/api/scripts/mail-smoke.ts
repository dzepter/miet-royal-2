/**
 * Manueller Live-Smoke des SMTP-Versands (Phase 12, Order §40): nur mit
 * MAIL_SMOKE=true UND MAIL_SMOKE_TO=<Adresse>, nie automatisch, nie im
 * Quality Gate, nie in production. Sendet genau EINE Testmail (ohne
 * Kundendaten, ohne Outbox-Zeile) direkt über das konfigurierte Gateway;
 * Ausgabe nur Ergebnis/Code – keine Zugangsdaten.
 *
 * Aufruf: MAIL_SMOKE=true MAIL_SMOKE_TO=du@example.org pnpm mail:smoke
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mietroyal/config';
import { createOutboundMailGateway } from '../src/communication/mail/gateways.ts';
import { mailMessageIdFor } from '../src/communication/mail/outbox.ts';
import { renderMail } from '../src/communication/mail/templates/index.ts';

if (process.env.MAIL_SMOKE !== 'true' || !process.env.MAIL_SMOKE_TO) {
  console.error(
    'Smoke-Test nur mit MAIL_SMOKE=true und MAIL_SMOKE_TO=<Adresse> (bewusster manueller Aufruf).',
  );
  process.exit(2);
}
const config = loadConfig();
if (config.appEnv === 'production') {
  console.error('Smoke-Test ist in production nicht zulässig.');
  process.exit(2);
}
if (!config.mail.enabled) {
  console.error(
    `Mail ist in APP_ENV=${config.appEnv} nicht aktiv (MAIL_ENABLED/SMTP-Daten prüfen).`,
  );
  process.exit(2);
}
const to = process.env.MAIL_SMOKE_TO.trim().toLowerCase();
const gateway = createOutboundMailGateway(config);
console.log(
  `Mail-Smoke (APP_ENV=${config.appEnv}, Gateway ${gateway.kind}, Host ${config.mail.smtp?.host ?? '–'})`,
);
const verify = await gateway.verify();
console.log(
  `  Verbindung/Login: ${verify.ok ? 'ok' : `fehlgeschlagen (${verify.code ?? 'UNKNOWN'})`}`,
);
if (!verify.ok) process.exit(1);
const id = randomUUID();
const rendered = renderMail(
  'manual_customer_reply',
  {
    salutation: 'Hallo,',
    processNumber: 'SMOKE-TEST',
    body: `Dies ist eine Testnachricht des Miet-Royal-Mailversands (${new Date().toISOString()}).`,
  },
  {},
  { appEnv: config.appEnv, publicWebBaseUrl: config.mail.publicWebBaseUrl },
);
const outcome = await gateway.send({
  messageId: mailMessageIdFor(id, config),
  to: { email: to, name: null },
  from: { email: config.mail.fromAddress ?? '', name: config.mail.fromName },
  replyTo: config.mail.replyAddress,
  subject: rendered.subject,
  text: rendered.text,
  html: rendered.html,
  inReplyTo: null,
  references: [],
  attachments: [],
});
console.log(
  `  Versand: ${outcome.outcome}${outcome.outcome === 'sent' ? ` (${outcome.providerCode ?? '–'})` : ` (${outcome.code})`}`,
);
process.exit(outcome.outcome === 'sent' ? 0 : 1);
