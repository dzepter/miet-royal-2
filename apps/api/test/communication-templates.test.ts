/**
 * Phase 12 (mail) – Unit: Vorlagen (text+html, Signatur, [DEMO], Escaping/
 * XSS, keine Bilder/Fremd-URLs), Header-/CRLF-Injection (Betreff, Name,
 * Empfänger), SMTP-Fehlerklassifikation, Demo-Whitelist, Outbox-Backoff
 * (Pflichttests 10–13 anteilig sowie SECURITY 185ff Header/XSS).
 */
import { describe, expect, it } from 'vitest';
import {
  classifySmtpError,
  DisabledMailGateway,
  FakeMailGateway,
  SmtpMailGateway,
} from '../src/communication/mail/gateways.ts';
import { mailRetryDelayMs, MAIL_MAX_ATTEMPTS } from '../src/communication/mail/send-job.ts';
import {
  assertNoHeaderInjection,
  escapeHtml,
  formatEuroCents,
  MAIL_TEMPLATE_VERSIONS,
  MailRenderError,
  renderMail,
  renderMailSubject,
  type MailRenderOptions,
} from '../src/communication/mail/templates/index.ts';
import { isDemoWhitelisted } from '../src/communication/mail/whitelist.ts';
import {
  MAIL_SIGNATURE,
  type MailDeliveryKind,
  type OutboundMailMessage,
} from '../src/communication/types.ts';

const BASE = 'https://web.test.example';
const options: MailRenderOptions = { appEnv: 'production', publicWebBaseUrl: BASE };

/** Beispiel-Kontext + Secrets je Vorlagenart (Vertrag für die Fachmodule). */
const SAMPLES: Record<
  MailDeliveryKind,
  { context: Record<string, unknown>; secrets: Record<string, string> }
> = {
  offer: {
    context: {
      salutation: 'Hallo Max Mustermann,',
      processNumber: 'MR-2026-0001',
      eventDate: '2026-11-20',
      validUntil: '2026-11-01T10:00:00Z',
    },
    secrets: { offerToken: 'offer-token-ABCDEFGH123456' },
  },
  order_confirmation: {
    context: { processNumber: 'MR-2026-0001', eventDate: '2026-11-20' },
    secrets: {},
  },
  handover_protocol: {
    context: { processNumber: 'MR-2026-0001', handoverAt: '2026-11-19T09:00:00Z' },
    secrets: {},
  },
  return_protocol: {
    context: { processNumber: 'MR-2026-0001', returnAt: '2026-11-22T09:00:00Z' },
    secrets: {},
  },
  settlement_damage_missing_notice: {
    context: {
      processNumber: 'MR-2026-0001',
      positions: [
        { label: 'Schaden Sahnemaschine: Deckel gebrochen', amountCents: 4500 },
        { label: 'Fehlteil: Portionierer', amountCents: 1250 },
      ],
      totalCents: 5750,
    },
    secrets: { documentToken: 'document-token-ABCDEFGH123456' },
  },
  cancellation_confirmation: {
    context: { processNumber: 'MR-2026-0001', chargeCents: 12_000 },
    secrets: {},
  },
  reminder_7_days: {
    context: {
      processNumber: 'MR-2026-0001',
      eventDate: '2026-11-20',
      appointmentKind: 'pickup',
      appointmentAt: '2026-11-19T09:00:00Z',
      address: 'Musterstraße 1, 55116 Mainz',
      returnAt: '2026-11-22T09:00:00Z',
    },
    secrets: { actionToken: 'action-token-ABCDEFGH123456' },
  },
  reminder_1_day: {
    context: {
      processNumber: 'MR-2026-0001',
      appointmentKind: 'delivery',
      appointmentAt: '2026-11-19T09:00:00Z',
      windowEnd: '2026-11-19T11:00:00Z',
      address: 'Festplatz 2, 55116 Mainz',
    },
    secrets: { actionToken: 'action-token-ABCDEFGH123456' },
  },
  appointment_changed: {
    context: {
      processNumber: 'MR-2026-0001',
      appointmentKind: 'pickup',
      oldAt: '2026-11-19T09:00:00Z',
      newAt: '2026-11-19T13:00:00Z',
    },
    secrets: {},
  },
  voucher_delivery: {
    context: { salutation: 'Hallo Max,', validUntil: '2027-11-20T00:00:00Z' },
    secrets: { voucherCode: 'MR20ABCDEFGHJKMN' },
  },
  invoice_delivery: {
    context: { processNumber: 'MR-2026-0001', invoiceNumber: 'RE-2026-0042' },
    secrets: {},
  },
  manual_customer_reply: {
    context: {
      processNumber: 'MR-2026-0001',
      body: 'Gerne, das passt so.\nBis Freitag!',
      staffName: 'Anna',
    },
    secrets: {},
  },
};

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;

describe('Mailvorlagen (Tests 11–13: text+html, Signatur, [DEMO]; 10: kein Tracking)', () => {
  for (const kind of Object.keys(SAMPLES) as MailDeliveryKind[]) {
    it(`${kind}: liefert Betreff, text/plain und HTML mit Signatur, ohne Bilder oder fremde URLs`, () => {
      const sample = SAMPLES[kind];
      const rendered = renderMail(kind, sample.context, sample.secrets, options);
      expect(rendered.subject.length).toBeGreaterThan(5);
      expect(rendered.templateVersion).toBe(MAIL_TEMPLATE_VERSIONS[kind]);
      expect(rendered.text).toContain(MAIL_SIGNATURE);
      expect(rendered.html).toContain('Mit freundlichen Grüßen<br>Miet-Royal Mainz');
      expect(rendered.text.trim().length).toBeGreaterThan(40);
      expect(rendered.html).toMatch(/^<!DOCTYPE html>/);
      // Kein Tracking: keine Bilder, keine Skripte, keine externen Ressourcen.
      expect(rendered.html).not.toMatch(/<img|<script|<link|<iframe|<object|<embed|url\(/i);
      for (const url of rendered.html.match(URL_PATTERN) ?? [])
        expect(url.startsWith(BASE)).toBe(true);
      for (const url of rendered.text.match(URL_PATTERN) ?? [])
        expect(url.startsWith(BASE)).toBe(true);
      // Betreff ohne [DEMO] in production; mit Präfix in demo.
      expect(rendered.subject.startsWith('[DEMO]')).toBe(false);
      const demo = renderMail(kind, sample.context, sample.secrets, { ...options, appEnv: 'demo' });
      expect(demo.subject.startsWith('[DEMO] ')).toBe(true);
      expect(renderMailSubject(kind, sample.context, { appEnv: 'demo' })).toBe(demo.subject);
    });
  }

  it('offer/notice/reminder: Links aus Token + Basis-URL; Gutscheincode formatiert; Beträge in Euro', () => {
    const offer = renderMail('offer', SAMPLES.offer.context, SAMPLES.offer.secrets, options);
    expect(offer.text).toContain(`${BASE}/angebot/offer-token-ABCDEFGH123456`);
    expect(offer.html).toContain(`href="${BASE}/angebot/offer-token-ABCDEFGH123456"`);
    const notice = renderMail(
      'settlement_damage_missing_notice',
      SAMPLES.settlement_damage_missing_notice.context,
      SAMPLES.settlement_damage_missing_notice.secrets,
      options,
    );
    expect(notice.text).toContain(`${BASE}/dokument/document-token-ABCDEFGH123456`);
    expect(notice.text).toContain('45,00');
    expect(notice.text).toContain('Gesamtsumme: 57,50');
    expect(notice.text).not.toMatch(/Frist|24 Stunden|Mahnung/i);
    const reminder = renderMail(
      'reminder_1_day',
      SAMPLES.reminder_1_day.context,
      SAMPLES.reminder_1_day.secrets,
      options,
    );
    expect(reminder.text).toContain('Kontakt vor Ort ändern');
    expect(reminder.text).toContain(`${BASE}/kontakt/action-token-ABCDEFGH123456`);
    const pickup = renderMail(
      'reminder_7_days',
      SAMPLES.reminder_7_days.context,
      SAMPLES.reminder_7_days.secrets,
      options,
    );
    expect(pickup.text).toContain('aufrecht transportieren');
    expect(pickup.text).toContain('Abholperson ändern');
    expect(pickup.text).toContain('Musterstraße 1, 55116 Mainz');
    const voucher = renderMail(
      'voucher_delivery',
      SAMPLES.voucher_delivery.context,
      SAMPLES.voucher_delivery.secrets,
      options,
    );
    expect(voucher.text).toContain('MR20-ABCD-EFGH-JKMN');
    expect(voucher.text).toContain('20 %');
    expect(formatEuroCents(123_456)).toBe('1.234,56\u00a0€');
  });

  it('Basis-URL fehlt ⇒ PUBLIC_WEB_BASE_URL_MISSING (nur Linkvorlagen); Betreff bleibt ableitbar', () => {
    expect(() =>
      renderMail('offer', SAMPLES.offer.context, SAMPLES.offer.secrets, {
        appEnv: 'production',
        publicWebBaseUrl: null,
      }),
    ).toThrow(MailRenderError);
    expect(
      renderMail(
        'invoice_delivery',
        SAMPLES.invoice_delivery.context,
        {},
        { appEnv: 'production', publicWebBaseUrl: null },
      ).subject,
    ).toContain('RE-2026-0042');
    expect(renderMailSubject('offer', SAMPLES.offer.context, { appEnv: 'production' })).toContain(
      'MR-2026-0001',
    );
  });

  it('ungültiger Kontext / fehlende Secrets ⇒ CONTEXT_INVALID / SECRETS_INVALID (nur Feldpfade, keine Werte)', () => {
    try {
      renderMail('offer', { processNumber: 'X' }, SAMPLES.offer.secrets, options);
      expect.fail('erwartet MailRenderError');
    } catch (error) {
      expect(error).toBeInstanceOf(MailRenderError);
      expect((error as MailRenderError).code).toBe('CONTEXT_INVALID');
      expect((error as MailRenderError).paths).toContain('validUntil');
    }
    try {
      renderMail('offer', SAMPLES.offer.context, {}, options);
      expect.fail('erwartet MailRenderError');
    } catch (error) {
      expect((error as MailRenderError).code).toBe('SECRETS_INVALID');
      expect((error as MailRenderError).message).not.toContain('offer-token');
    }
  });
});

describe('Escaping / XSS (SECURITY: HTML/XSS, kein Roh-HTML aus Kundendaten)', () => {
  it('escapeHtml neutralisiert alle Sonderzeichen', () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;',
    );
  });

  it('Kundendaten (Anrede, Freitext, Positionen, Adresse) erscheinen nur escaped im HTML', () => {
    const payload = `<img src=x onerror=alert(1)><script>alert('x')</script>`;
    const reply = renderMail(
      'manual_customer_reply',
      { processNumber: 'MR-1', body: payload, salutation: payload },
      {},
      options,
    );
    expect(reply.html).not.toContain('<img');
    expect(reply.html).not.toContain('<script');
    expect(reply.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(reply.text).toContain(payload);
    const notice = renderMail(
      'settlement_damage_missing_notice',
      { processNumber: 'MR-1', positions: [{ label: payload, amountCents: 100 }], totalCents: 100 },
      { documentToken: 'document-token-ABCDEFGH123456' },
      options,
    );
    expect(notice.html).not.toMatch(/<img|<script/);
    const reminder = renderMail(
      'reminder_1_day',
      { ...SAMPLES.reminder_1_day.context, address: `"><a href="https://evil.example">x</a>` },
      {},
      options,
    );
    expect(reminder.html).not.toContain('https://evil.example">x</a>');
    expect(reminder.html).toContain(
      '&quot;&gt;&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;',
    );
  });

  it('Token mit Sonderzeichen werden URL-kodiert – kein Ausbruch aus dem href', () => {
    const offer = renderMail(
      'offer',
      SAMPLES.offer.context,
      { offerToken: 'abc"><script>x</script>' },
      options,
    );
    expect(offer.html).not.toContain('<script>');
    expect(offer.html).toContain('/angebot/abc%22%3E%3Cscript%3Ex%3C%2Fscript%3E');
  });
});

describe('Header-/CRLF-Injection (SECURITY: Header/CRLF/Recipient Injection)', () => {
  it('CRLF im Betreff (Vorgangsnummer) wird beim Rendern abgewiesen', () => {
    expect(() =>
      renderMail(
        'invoice_delivery',
        { processNumber: 'MR-1\r\nBcc: evil@example.org', invoiceNumber: 'R1' },
        {},
        options,
      ),
    ).toThrow(MailRenderError);
    expect(() =>
      renderMailSubject(
        'invoice_delivery',
        { processNumber: 'MR-1\nX', invoiceNumber: 'R1' },
        { appEnv: 'production' },
      ),
    ).toThrow(/HEADER_INJECTION/);
    expect(() => assertNoHeaderInjection('Hallo\r\nX-Injected: 1', 'name')).toThrow(
      MailRenderError,
    );
    expect(() => assertNoHeaderInjection('Hallo Welt', 'name')).not.toThrow();
  });

  const message = (overrides: Partial<OutboundMailMessage>): OutboundMailMessage => ({
    messageId: '<id@miet-royal.test>',
    to: { email: 'kunde@example.org', name: 'Max' },
    from: { email: 'noreply@miet-royal.test', name: 'Miet-Royal' },
    replyTo: null,
    subject: 'Betreff',
    text: 'Text',
    html: '<p>Text</p>',
    inReplyTo: null,
    references: [],
    attachments: [],
    ...overrides,
  });

  it('Gateways lehnen CRLF in Betreff/Name und Mehrfach-Empfänger als permanent_error HEADER_INJECTION ab – ohne Transportaufruf', async () => {
    let calls = 0;
    const smtp = new SmtpMailGateway(
      { host: 'smtp.test', port: 465, tls: 'implicit', user: 'u', password: 'p' },
      {
        transport: {
          sendMail: async () => {
            calls += 1;
            return { response: '250 OK' };
          },
          verify: async () => true,
        },
      },
    );
    const fake = new FakeMailGateway();
    for (const gateway of [smtp, fake]) {
      for (const bad of [
        message({ subject: 'Hallo\r\nBcc: evil@example.org' }),
        message({ to: { email: 'kunde@example.org', name: 'Max\nBcc: evil@example.org' } }),
        message({ to: { email: 'kunde@example.org, evil@example.org', name: null } }),
        message({ to: { email: 'kunde@example.org\r\nevil@example.org', name: null } }),
        message({
          attachments: [
            {
              filename: 'a.pdf\r\nX: y',
              contentType: 'application/pdf',
              content: new Uint8Array(),
            },
          ],
        }),
      ]) {
        expect(await gateway.send(bad)).toEqual({
          outcome: 'permanent_error',
          code: 'HEADER_INJECTION',
        });
      }
    }
    expect(calls).toBe(0);
    expect(fake.sent).toHaveLength(0);
    expect(await smtp.send(message({}))).toEqual({ outcome: 'sent', providerCode: 'SMTP_250' });
    expect(calls).toBe(1);
  });
});

describe('SMTP-Ergebnisklassifikation (Test 7–9: sent/retry/failed/unknown)', () => {
  it('4xx/Verbindung vor DATA ⇒ transient; 5xx ⇒ permanent; Abbruch nach DATA ⇒ unknown; nie Rohantwort', () => {
    expect(
      classifySmtpError({ responseCode: 421, command: 'CONN', response: '421 secret-host busy' }),
    ).toEqual({ outcome: 'transient_error', code: 'SMTP_421' });
    // Härtung RA-1: Nodemailer meldet jeden Abbruch (auch NACH DATA) als ECONNECTION/CONN ⇒
    // ohne Nachweis „vor der Sitzung“ unklar (siehe communication-hardening-smtp.test.ts).
    expect(classifySmtpError({ code: 'ECONNECTION', command: 'CONN' })).toEqual({
      outcome: 'unknown',
      code: 'SMTP_ECONNECTION',
    });
    expect(
      classifySmtpError({ code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED' }),
    ).toEqual({ outcome: 'transient_error', code: 'SMTP_ESOCKET' });
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'EHLO' })).toEqual({
      outcome: 'transient_error',
      code: 'SMTP_ETIMEDOUT',
    });
    expect(classifySmtpError({ responseCode: 550, command: 'RCPT TO' })).toEqual({
      outcome: 'permanent_error',
      code: 'SMTP_550',
    });
    expect(classifySmtpError({ responseCode: 535, code: 'EAUTH' })).toEqual({
      outcome: 'permanent_error',
      code: 'SMTP_535',
    });
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'DATA' })).toEqual({
      outcome: 'unknown',
      code: 'SMTP_ETIMEDOUT',
    });
    expect(classifySmtpError({ code: 'ESOCKET', command: 'DATA' })).toEqual({
      outcome: 'unknown',
      code: 'SMTP_ESOCKET',
    });
    // Antwortcode nach DATA ist eine bekannte Entscheidung des Servers.
    expect(classifySmtpError({ responseCode: 452, command: 'DATA' })).toEqual({
      outcome: 'transient_error',
      code: 'SMTP_452',
    });
    expect(classifySmtpError({ code: 'EENVELOPE' })).toEqual({
      outcome: 'permanent_error',
      code: 'SMTP_EENVELOPE',
    });
    // Unbekannter Fehler ⇒ Zustellung unklar (kein blindes Retry, Härtung RA-1).
    expect(classifySmtpError(new Error('boom'))).toEqual({
      outcome: 'unknown',
      code: 'SMTP_ERROR',
    });
  });

  it('verify liefert nur ok/code; DisabledMailGateway wirft nie', async () => {
    const failing = new SmtpMailGateway(
      { host: 'smtp.test', port: 587, tls: 'starttls', user: 'u', password: 'geheim' },
      {
        transport: {
          sendMail: async () => {
            throw Object.assign(new Error('535 bad credentials geheim'), {
              responseCode: 535,
              code: 'EAUTH',
            });
          },
          verify: async () => {
            throw Object.assign(new Error('535 bad credentials geheim'), {
              responseCode: 535,
              code: 'EAUTH',
            });
          },
        },
      },
    );
    expect(await failing.verify()).toEqual({ ok: false, code: 'SMTP_535' });
    expect(JSON.stringify(await failing.verify())).not.toContain('geheim');
    const disabled = new DisabledMailGateway();
    expect(await disabled.send()).toEqual({
      outcome: 'permanent_error',
      code: 'MAIL_NOT_CONFIGURED',
    });
    expect(await disabled.verify()).toEqual({ ok: false, code: 'MAIL_NOT_CONFIGURED' });
  });
});

describe('Demo-Whitelist und Outbox-Backoff', () => {
  it('Whitelist: Vollmatch oder @domain, kleingeschrieben, keine Teilstrings', () => {
    const list = ['Test@Example.org', '@mainz-demo.de'];
    expect(isDemoWhitelisted('test@example.org', list)).toBe(true);
    expect(isDemoWhitelisted('TEST@EXAMPLE.ORG', list)).toBe(true);
    expect(isDemoWhitelisted('anna@mainz-demo.de', list)).toBe(true);
    expect(isDemoWhitelisted('anna@sub.mainz-demo.de', list)).toBe(false);
    expect(isDemoWhitelisted('anna@notmainz-demo.de', list)).toBe(false);
    expect(isDemoWhitelisted('other@example.org', list)).toBe(false);
    expect(isDemoWhitelisted('kunde@example.org', [])).toBe(false);
  });

  it('Backoff 1 min × 2^(n−1), gedeckelt auf 6 h, maximal 8 Versuche', () => {
    expect(mailRetryDelayMs(1)).toBe(60_000);
    expect(mailRetryDelayMs(2)).toBe(120_000);
    expect(mailRetryDelayMs(7)).toBe(3_840_000);
    expect(mailRetryDelayMs(20)).toBe(6 * 60 * 60 * 1000);
    expect(MAIL_MAX_ATTEMPTS).toBe(8);
  });
});
