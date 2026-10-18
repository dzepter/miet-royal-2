/**
 * Manueller Live-Smoke gegen die Meta WhatsApp Business Cloud API (Order §40):
 * nur mit WHATSAPP_SMOKE=true UND WHATSAPP_SMOKE_TO=<wa_id> (Ziffern ohne
 * Plus), nie automatisch, nie in production, nie im Quality Gate. Sendet
 * GENAU EINE kurze Textnachricht an die angegebene Testnummer (die Nummer
 * muss dem Unternehmen innerhalb der letzten 24 h geschrieben haben, sonst
 * antwortet Meta mit 131047 – das ist ein erwartetes Ergebnis, kein Fehler
 * der Integration). Ausgabe ohne Secrets.
 *
 * Aufruf: WHATSAPP_SMOKE=true WHATSAPP_SMOKE_TO=4917612345678 pnpm whatsapp:smoke
 */
import { loadConfig } from '@mietroyal/config';
import { createWhatsAppGateway } from '../src/communication/whatsapp/gateways.ts';

if (process.env.WHATSAPP_SMOKE !== 'true') {
  console.error('Smoke-Test nur mit WHATSAPP_SMOKE=true (bewusster manueller Aufruf).');
  process.exit(2);
}
const to = (process.env.WHATSAPP_SMOKE_TO ?? '').trim();
if (!/^\d{5,20}$/.test(to)) {
  console.error('WHATSAPP_SMOKE_TO muss eine wa_id (nur Ziffern, mit Länderkennung) sein.');
  process.exit(2);
}
const config = loadConfig();
if (config.appEnv === 'production') {
  console.error('Smoke-Test ist in production nicht zulässig.');
  process.exit(2);
}
if (config.whatsapp.mode !== 'live') {
  console.error(
    `WhatsApp ist in APP_ENV=${config.appEnv} nicht live (mode=${config.whatsapp.mode}).`,
  );
  process.exit(2);
}
const gateway = createWhatsAppGateway(config);
console.log(
  `WhatsApp-Smoke (APP_ENV=${config.appEnv}, Host ${config.whatsapp.baseUrl}, ${config.whatsapp.graphApiVersion}) – sendet genau eine Nachricht an ***${to.slice(-4)}`,
);
const outcome = await gateway.sendText({
  to,
  text: 'Miet-Royal Smoke-Test – diese Nachricht wurde manuell ausgelöst. Bitte ignorieren.',
});
if (outcome.outcome === 'accepted') {
  console.log(`  angenommen (Message-ID vorhanden, Länge ${outcome.providerMessageId.length})`);
  process.exit(0);
}
console.error(`  ${outcome.outcome}: ${outcome.code}`);
process.exit(outcome.code === 'WINDOW_CLOSED' ? 0 : 1);
