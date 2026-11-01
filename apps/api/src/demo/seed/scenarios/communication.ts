import type { DemoScenario } from '../context.ts';
import { DEMO_CUSTOMERS, DEMO_SEED_KEYS, withDemoTestAddress } from '../data.ts';

/**
 * Kommunikation (Order §10): eingehende Kunden-E-Mail zum Angebotsentwurf
 * (ConversationService.createInbound – der Service-Einstieg des IMAP-
 * Eingangs) und eine Staff-Antwort über ConversationService.replyByEmail
 * (Mail-Outbox; in der Demo ohne Whitelist-Eintrag `blocked`, nie ein echter
 * Versand – mit konfigurierter Demo-Testdomain (Order §9) `queued`, der
 * Demo-Worker stellt sie an die Senke zu). Zusätzlich eine unbeantwortete
 * Anfrage-Mail als Übungsaufgabe (Kommunikations-Übung: die Antwort an die
 * Demo-Testadresse kann tatsächlich `sent` werden, Order §78).
 * WhatsApp-Eingänge gibt es in der Demo nur über den (simulierten) Webhook –
 * hier bewusst nicht per Fixture eingespielt.
 */
export const communicationScenario: DemoScenario = {
  name: 'communication',
  async run(ctx) {
    const { conversations, outbox } = ctx.services;
    // Absenderadressen = Kundenadressen des Seeds (ggf. Demo-Testdomain, siehe customers.ts).
    const orgBasic = withDemoTestAddress(ctx.config, DEMO_CUSTOMERS.orgBasic);
    const privateBasic = withDemoTestAddress(ctx.config, DEMO_CUSTOMERS.privateBasic);
    const draftProcessId = await ctx.resolve(DEMO_SEED_KEYS.processOfferDraft);
    const orgCustomerId = await ctx.resolve(DEMO_SEED_KEYS.customerOrgBasic);
    const inbound = await conversations.createInbound({
      processId: draftProcessId,
      customerId: orgCustomerId,
      channel: 'email',
      sender: {
        name: orgBasic.contactPerson ?? null,
        email: orgBasic.email,
      },
      subject: 'Rückfrage zum Angebot – Sommerfest',
      body:
        'Guten Tag,\n\nkönnten Sie die Maschine schon am Vormittag liefern? ' +
        'Und wäre eine dritte Sirupsorte möglich?\n\nViele Grüße\nJonas Vorstand',
      providerMessageId: '<demo-sommerfest-rueckfrage@example.com>',
      replyToProviderMessageId: null,
      receivedAt: ctx.clock.hoursAgo(5),
    });
    await ctx.register(DEMO_SEED_KEYS.conversationEmailInbound, 'conversation_message', inbound.id);

    const reply = await conversations.replyByEmail(outbox, {
      processId: draftProcessId,
      body:
        'vielen Dank für Ihre Nachricht. Eine Lieferung am Vormittag ist möglich – ' +
        'wir tragen das Zeitfenster 09:00–11:00 Uhr ein. Eine dritte Sirupsorte ' +
        'ergänzen wir gern als Zusatzposition im Angebot.',
      staffUserId: ctx.actorId,
      appEnv: ctx.config.appEnv,
    });
    await ctx.register(
      DEMO_SEED_KEYS.conversationEmailReply,
      'conversation_message',
      reply.messageId,
    );

    const inquiryProcessId = await ctx.resolve(DEMO_SEED_KEYS.processInquiryNew);
    const privateCustomerId = await ctx.resolve(DEMO_SEED_KEYS.customerPrivateBasic);
    const unanswered = await conversations.createInbound({
      processId: inquiryProcessId,
      customerId: privateCustomerId,
      channel: 'email',
      sender: {
        name: `${privateBasic.firstName} ${privateBasic.lastName}`,
        email: privateBasic.email,
      },
      subject: 'Frage zur Abholung',
      body:
        'Hallo,\n\nkann ich die Maschine auch schon am Donnerstagabend abholen? ' +
        'Und wie groß ist sie ungefähr – passt sie in einen Kleinwagen?\n\nDanke, Lena Beispiel',
      providerMessageId: '<demo-abholung-frage@example.com>',
      replyToProviderMessageId: null,
      receivedAt: ctx.clock.hoursAgo(26),
    });
    await ctx.register(
      DEMO_SEED_KEYS.conversationEmailUnanswered,
      'conversation_message',
      unanswered.id,
    );
  },
};
