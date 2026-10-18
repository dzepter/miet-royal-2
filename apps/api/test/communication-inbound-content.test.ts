/**
 * Phase 12 – Unit-Tests der Inhaltsaufbereitung eingehender Nachrichten
 * (Order §23; Pflichttests 76–78 inhaltlich, SECURITY HTML/XSS, kein SVG,
 * keine Remote-Images, Magic Bytes).
 */
import { describe, expect, it } from 'vitest';
import {
  acceptImageAttachment,
  chooseInboundBody,
  decodeHtmlEntities,
  detectImageMime,
  extractProcessNumbers,
  htmlToSafeText,
  inboundMailFingerprint,
  INBOUND_BODY_TRUNCATED_NOTICE,
  normalizeMessageId,
  parseMessageIdList,
  previewOf,
  truncateBody,
} from '../src/communication/inbound/content.ts';
import { classifyGraphError } from '../src/communication/whatsapp/gateways.ts';
import {
  phoneCandidatesForWaId,
  verifyWhatsAppSignature,
  signWhatsAppBody,
} from '../src/communication/whatsapp/webhook-service.ts';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48,
]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 40, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const PDF = new TextEncoder().encode('%PDF-1.4 fake');
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
);

describe('HTML → Text (76. HTML/XSS sicher, keine Remote-Images, keine Raw-HTML-Speicherung)', () => {
  it('entfernt Script/Style samt Inhalt, Tags, externe Bilder und dekodiert Entities', () => {
    const html =
      '<html><head><style>body{color:red}</style></head><body><p>Hallo <b>Team</b>,</p>' +
      '<script>alert("xss")</script><img src="http://evil.example/pixel.png?track=1">' +
      '<p>Bitte &amp; danke &lt;3 f&uuml;r die R&uuml;ckmeldung &#8364; &#x41;</p>' +
      '<a href="javascript:alert(1)">Link</a><br>Ende<ul><li>eins</li><li>zwei</li></ul></body></html>';
    const text = htmlToSafeText(html);
    expect(text).toContain('Hallo Team,');
    expect(text).toContain('Bitte & danke <3 für die Rückmeldung € A');
    expect(text).toContain('Link\nEnde');
    expect(text).toContain('• eins');
    expect(text).not.toContain('<script');
    expect(text).not.toContain('alert(');
    expect(text).not.toContain('evil.example');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('color:red');
    expect(text).not.toMatch(/<[a-z]+[\s>]/i);
  });

  it('bevorzugt text/plain und fällt nur bei HTML-only auf die Konvertierung zurück', () => {
    expect(chooseInboundBody({ text: 'Klartext\r\nZeile 2', html: '<p>HTML</p>' })).toBe(
      'Klartext\nZeile 2',
    );
    expect(chooseInboundBody({ text: '   ', html: '<p>Nur <i>HTML</i></p>' })).toBe('Nur HTML');
    expect(chooseInboundBody({ text: null, html: null })).toBe('');
  });

  it('dekodiert numerische Entities sicher und lässt Unbekanntes stehen', () => {
    expect(decodeHtmlEntities('&#60;b&#62; &unknownentity; &#xZZ;')).toBe(
      '<b> &unknownentity; &#xZZ;',
    );
    expect(decodeHtmlEntities('&#0;x&#1114112;')).toBe('x');
  });

  it('kürzt überlange Texte mit Hinweis (Body-Limit)', () => {
    const long = 'a'.repeat(25_000);
    const cut = truncateBody(long);
    expect(cut.length).toBe(20_000 + INBOUND_BODY_TRUNCATED_NOTICE.length);
    expect(cut.endsWith(INBOUND_BODY_TRUNCATED_NOTICE)).toBe(true);
    expect(truncateBody('kurz')).toBe('kurz');
  });

  it('Vorschau ist einzeilig und begrenzt', () => {
    expect(previewOf('Zeile 1\n\nZeile   2')).toBe('Zeile 1 Zeile 2');
    expect(previewOf('x'.repeat(300)).length).toBe(200);
  });
});

describe('Magic Bytes (77. JPEG/PNG/WebP; 78. keine PDF/ZIP/SVG; SECURITY kein SVG)', () => {
  it('erkennt nur JPEG/PNG/WebP über die Bytes', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(WEBP)).toBe('image/webp');
    expect(detectImageMime(PDF)).toBeNull();
    expect(detectImageMime(SVG)).toBeNull();
    expect(detectImageMime(new Uint8Array([]))).toBeNull();
  });

  it('akzeptiert Anhänge nur bei passendem MIME UND Magic Bytes und innerhalb des Limits', () => {
    expect(acceptImageAttachment('image/jpeg', JPEG, 1_000)).toBe('image/jpeg');
    expect(acceptImageAttachment('image/jpg', JPEG, 1_000)).toBe('image/jpeg');
    expect(acceptImageAttachment('IMAGE/PNG; name="x"', PNG, 1_000)).toBe('image/png');
    expect(acceptImageAttachment('image/webp', WEBP, 1_000)).toBe('image/webp');
    // Getarnt: PDF-Bytes als image/png deklariert.
    expect(acceptImageAttachment('image/png', PDF, 1_000)).toBeNull();
    // Deklarationsmismatch: PNG-Bytes als JPEG deklariert.
    expect(acceptImageAttachment('image/jpeg', PNG, 1_000)).toBeNull();
    expect(acceptImageAttachment('image/svg+xml', SVG, 1_000)).toBeNull();
    expect(acceptImageAttachment('application/pdf', PDF, 1_000)).toBeNull();
    expect(acceptImageAttachment('application/octet-stream', JPEG, 1_000)).toBeNull();
    expect(acceptImageAttachment('image/jpeg', JPEG, 10)).toBeNull();
  });
});

describe('Dedupe-/Zuordnungshilfen (Order §21)', () => {
  it('normalisiert Message-IDs und Referenzlisten', () => {
    expect(normalizeMessageId(' <abc@x.test> ')).toBe('abc@x.test');
    expect(normalizeMessageId('')).toBeNull();
    expect(parseMessageIdList('<a@x> <b@y>\n <a@x>')).toEqual(['a@x', 'b@y']);
    expect(parseMessageIdList(['<a@x>', '<c@z>'])).toEqual(['a@x', 'c@z']);
  });

  it('Fingerprint ist stabil gegenüber Whitespace im Textanfang und unterscheidet Inhalte', () => {
    const base = { from: 'A@X.test', date: new Date('2026-10-18T10:00:00Z'), subject: 'Hi' };
    const a = inboundMailFingerprint({ ...base, body: 'Hallo   Welt\n\n' });
    const b = inboundMailFingerprint({ ...base, from: 'a@x.test', body: 'Hallo Welt' });
    const c = inboundMailFingerprint({ ...base, body: 'Hallo Mond' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('findet Vorgangsnummern im Format MR-JJJJ-NNNN (nur eindeutig verwertbar)', () => {
    expect(extractProcessNumbers('Re: MR-2026-0012', 'Text MR-2026-0012 nochmal')).toEqual([
      'MR-2026-0012',
    ]);
    expect(extractProcessNumbers('MR-2026-0012 und MR-2026-10000')).toEqual([
      'MR-2026-0012',
      'MR-2026-10000',
    ]);
    expect(extractProcessNumbers('MR-26-12', 'XMR-2026-0012')).toEqual([]);
  });
});

describe('WhatsApp-Hilfen (Signatur, Fehlercodes, Telefonvarianten)', () => {
  it('Signatur über Rohbytes, konstante Zeit, nur sha256=-Form', () => {
    const body = Buffer.from('{"object":"whatsapp_business_account","x":"ü  "}  \n', 'utf8');
    const sig = signWhatsAppBody('secret-1', body);
    expect(verifyWhatsAppSignature('secret-1', body, sig)).toBe(true);
    expect(
      verifyWhatsAppSignature('secret-1', body, sig.toUpperCase().replace('SHA256=', 'sha256=')),
    ).toBe(true);
    expect(verifyWhatsAppSignature('secret-2', body, sig)).toBe(false);
    expect(
      verifyWhatsAppSignature('secret-1', Buffer.from(body.toString('utf8').trim()), sig),
    ).toBe(false);
    expect(verifyWhatsAppSignature('secret-1', body, undefined)).toBe(false);
    expect(verifyWhatsAppSignature('secret-1', body, 'sha1=abc')).toBe(false);
    expect(verifyWhatsAppSignature('secret-1', body, 'sha256=zz')).toBe(false);
  });

  it('klassifiziert Graph-Fehlercodes nach offizieller Liste', () => {
    expect(classifyGraphError(131047, 400)).toEqual({
      outcome: 'permanent_error',
      code: 'WINDOW_CLOSED',
    });
    expect(classifyGraphError(130429, 400).outcome).toBe('transient_error');
    expect(classifyGraphError(4, 400).outcome).toBe('transient_error');
    expect(classifyGraphError(80007, 400).outcome).toBe('transient_error');
    expect(classifyGraphError(131056, 400).outcome).toBe('transient_error');
    expect(classifyGraphError(131026, 400)).toEqual({
      outcome: 'permanent_error',
      code: 'GRAPH_131026',
    });
    expect(classifyGraphError(190, 401).outcome).toBe('permanent_error');
    expect(classifyGraphError(100, 400).outcome).toBe('permanent_error');
    expect(classifyGraphError(133010, 400).outcome).toBe('permanent_error');
    expect(classifyGraphError(null, 503)).toEqual({ outcome: 'transient_error', code: 'HTTP_503' });
    expect(classifyGraphError(null, 429).outcome).toBe('transient_error');
    expect(classifyGraphError(null, 400).outcome).toBe('permanent_error');
  });

  it('Telefonkandidaten: wa_id-Ziffern plus Variante 49→0', () => {
    expect(phoneCandidatesForWaId('4917612345678')).toEqual(['4917612345678', '017612345678']);
    expect(phoneCandidatesForWaId('41791234567')).toEqual(['41791234567']);
    expect(phoneCandidatesForWaId('')).toEqual([]);
  });
});
