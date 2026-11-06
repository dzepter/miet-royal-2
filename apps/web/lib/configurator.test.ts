import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONFIGURATOR_STEPS,
  CONFIGURATOR_TEXT,
  INQUIRY_URL,
  MUTATION_ID_STORAGE_KEY,
  PREVIEW_URL,
  berlinToday,
  buildInquiryPayload,
  buildPreviewRequest,
  clearStoredMutationId,
  createClientMutationId,
  createInitialState,
  endsNextDay,
  ensureMutationId,
  fetchConfiguratorPreview,
  firstInvalidStep,
  inquiryOutcomeMessage,
  interpretInquiryResponse,
  isLargeEvent,
  isRetryableOutcome,
  isUuid,
  readStoredMutationId,
  stepForIssuePath,
  submitInquiry,
  validateStep,
  type ConfiguratorState,
  type StorageLike,
  type ValidationContext,
} from './configurator.ts';

/**
 * Phase 16 (WEB, Order §11–§17, Design §11.2.7/§11.2.8/§11.3 „WEB“): Konfigurator-Logik –
 * clientMutationId-Speicher (nur ID, bis Erfolg), identischer Payload, Antwort-Auswertung
 * (201/200/409/400/429/503/Netz), Schrittprüfung, Großevent nur Hinweis, Kanister nicht
 * vorausgewählt. Läuft mit `node --test`.
 */

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const THROWING: StorageLike = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceeded');
  },
  removeItem() {
    throw new Error('SecurityError');
  },
};

const UUID_A = '6f1c2a54-3c9e-4f7b-9a0e-2d4b6c8e0f12';
const UUID_B = '0b8e1d2c-5a6f-4e3d-8c2b-1a0f9e8d7c6b';

function filledState(): ConfiguratorState {
  const state = createInitialState('slush-2x8');
  return {
    ...state,
    event: {
      date: '2026-12-12',
      startTime: '18:00',
      endTime: '01:00',
      guests: '120',
      occasion: 'birthday',
    },
    freeSyrups: { 'sirup-kirsche': 1, 'sirup-blaue-himbeere': 1, 'sirup-waldmeister': 0 },
    extraSyrups: { 'sirup-kirsche': 2 },
    cups25: 1,
    straws25: 0,
    canisters: 2,
    contact: {
      type: 'private',
      firstName: '  Erika ',
      lastName: 'Musterfrau',
      organizationName: 'wird ignoriert',
      contactPerson: '',
      email: ' erika@example.org ',
      phone: '',
    },
    privacyAcknowledged: true,
  };
}

const CTX: ValidationContext = {
  today: '2026-11-06',
  machineSlugs: new Set(['slush-1x8', 'slush-2x8', 'slush-1x10', 'slush-2x10']),
  occasions: new Set(['birthday', 'wedding', 'other']),
  quota: { freeSyrupLiters: 2, assignedFreeLiters: 2, unassignedFreeLiters: 0, canisterMax: 4 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Konfigurator: clientMutationId-Speicher (Phase 16)', () => {
  it('W-C1. ID wird beim ersten Versuch erzeugt, in sessionStorage gehalten und bis Erfolg wiederverwendet', () => {
    const storage = new MemoryStorage();
    let created = 0;
    const create = () => {
      created += 1;
      return created === 1 ? UUID_A : UUID_B;
    };
    assert.equal(readStoredMutationId(storage), null);
    assert.equal(ensureMutationId(storage, create), UUID_A);
    assert.equal(ensureMutationId(storage, create), UUID_A, 'Retry/Reload ⇒ dieselbe ID');
    assert.equal(created, 1);
    assert.deepEqual([...storage.data.keys()], [MUTATION_ID_STORAGE_KEY]);
    assert.equal(
      storage.getItem(MUTATION_ID_STORAGE_KEY),
      UUID_A,
      'nur die ID, keine Kontaktdaten',
    );
    clearStoredMutationId(storage);
    assert.equal(readStoredMutationId(storage), null);
    assert.equal(ensureMutationId(storage, create), UUID_B, 'nach Erfolg ⇒ neue Anfrage, neue ID');
  });

  it('W-C2. Ungültiger gespeicherter Wert wird ersetzt; gesperrter Speicher ⇒ ID nur im Speicher des Formulars', () => {
    const storage = new MemoryStorage();
    storage.setItem(MUTATION_ID_STORAGE_KEY, 'manipuliert');
    assert.equal(
      ensureMutationId(storage, () => UUID_B),
      UUID_B,
    );
    assert.equal(storage.getItem(MUTATION_ID_STORAGE_KEY), UUID_B);
    assert.equal(
      ensureMutationId(THROWING, () => UUID_A),
      UUID_A,
    );
    assert.equal(readStoredMutationId(THROWING), null);
    assert.doesNotThrow(() => clearStoredMutationId(THROWING));
    assert.equal(
      ensureMutationId(null, () => UUID_A),
      UUID_A,
    );
  });

  it('W-C3. UUID v4 aus randomUUID oder getRandomValues (auch ohne sicheren Kontext)', () => {
    assert.equal(createClientMutationId({ randomUUID: () => UUID_A.toUpperCase() }), UUID_A);
    const fromBytes = createClientMutationId({
      getRandomValues: (array: Uint8Array) => {
        array.fill(0xab);
        return array;
      },
    });
    assert.ok(isUuid(fromBytes));
    assert.equal(fromBytes[14], '4');
    assert.match(fromBytes[19] ?? '', /[89ab]/);
    assert.ok(isUuid(createClientMutationId({})));
    assert.ok(isUuid(createClientMutationId()));
    assert.notEqual(createClientMutationId(), createClientMutationId());
  });
});

describe('Konfigurator: Payload und Übersicht (Phase 16)', () => {
  it('W-C4. Anfrage-Payload: nur bekannte Felder, getrimmt, Sorten sortiert, 0-Liter entfallen, Kanister aus Auswahl', () => {
    const payload = buildInquiryPayload(filledState(), UUID_A);
    assert.deepEqual(payload, {
      clientMutationId: UUID_A,
      event: {
        date: '2026-12-12',
        startTime: '18:00',
        endTime: '01:00',
        guests: 120,
        occasion: 'birthday',
      },
      machineSlug: 'slush-2x8',
      syrups: {
        free: [
          { slug: 'sirup-blaue-himbeere', liters: 1 },
          { slug: 'sirup-kirsche', liters: 1 },
        ],
        extra: [{ slug: 'sirup-kirsche', liters: 2 }],
      },
      extras: { cups25: 1, straws25: 0 },
      canisters: 2,
      fulfillment: { type: 'pickup' },
      contact: {
        type: 'private',
        firstName: 'Erika',
        lastName: 'Musterfrau',
        email: 'erika@example.org',
      },
      privacyAcknowledged: true,
    });
    // Gleicher Zustand ⇒ identischer Payload (Retry sendet exakt dasselbe).
    assert.equal(
      JSON.stringify(buildInquiryPayload(filledState(), UUID_A)),
      JSON.stringify(payload),
    );
  });

  it('W-C5. Lieferung mit Adresse + optionalem Zeitfenster; Organisation; Telefon nur wenn angegeben', () => {
    const state = filledState();
    const payload = buildInquiryPayload(
      {
        ...state,
        event: { ...state.event, startTime: '', endTime: '' },
        fulfillment: 'delivery',
        delivery: {
          street: ' Musterweg 5 ',
          postalCode: '55116',
          city: 'Mainz',
          windowFrom: '10:00',
          windowTo: '',
        },
        contact: {
          ...state.contact,
          type: 'organization',
          organizationName: ' Sportverein ',
          contactPerson: 'Max Muster',
          phone: ' 06131 123456 ',
        },
      },
      UUID_A,
    );
    assert.deepEqual(payload.event, { date: '2026-12-12', guests: 120, occasion: 'birthday' });
    assert.deepEqual(payload.fulfillment, {
      type: 'delivery',
      street: 'Musterweg 5',
      postalCode: '55116',
      city: 'Mainz',
      windowFrom: '10:00',
    });
    assert.deepEqual(payload.contact, {
      type: 'organization',
      organizationName: 'Sportverein',
      contactPerson: 'Max Muster',
      email: 'erika@example.org',
      phone: '06131 123456',
    });
    assert.ok(!('priceCents' in payload) && !JSON.stringify(payload).includes('Cents'));
  });

  it('W-C6. Übersicht-Request: Browser schickt nur Auswahl (keine Preise); Gäste nur wenn gültig', () => {
    const initial = createInitialState();
    assert.deepEqual(buildPreviewRequest(initial), {
      syrups: { free: [], extra: [] },
      extras: { cups25: 0, straws25: 0 },
      canisters: 0,
      fulfillment: 'pickup',
    });
    assert.equal(initial.canisters, 0, 'Kanister empfohlen, aber nicht vorausgewählt');
    const request = buildPreviewRequest(filledState());
    assert.equal(request.guests, 120);
    assert.equal(request.machineSlug, 'slush-2x8');
    assert.equal(
      buildPreviewRequest({ ...filledState(), event: { ...filledState().event, guests: '0' } })
        .guests,
      undefined,
    );
    assert.equal(
      buildPreviewRequest({ ...filledState(), event: { ...filledState().event, guests: '12a' } })
        .guests,
      undefined,
    );
  });

  it('W-C7. Übersicht: POST /api/public/configurator/preview; 429/Fehler/Abbruch ohne Ausnahme', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const preview = {
      recommendation: { machineSlug: null, message: CONFIGURATOR_TEXT.RECOMMENDATION_FALLBACK },
      largeEvent: false,
      quota: { freeSyrupLiters: 2, assignedFreeLiters: 0, unassignedFreeLiters: 2, canisterMax: 4 },
      fixed: [],
      fixedTotalCents: 0,
      included: [],
      commission: [],
      delivery: { requested: false, text: 'Lieferung wird individuell geprüft und angeboten.' },
      issues: [],
      priceNote: 'x',
    };
    const ok = await fetchConfiguratorPreview(
      { guests: 10 },
      {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          return jsonResponse(preview);
        },
      },
    );
    assert.deepEqual(ok, { kind: 'ok', preview });
    assert.equal(calls[0]?.url, PREVIEW_URL);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.cache, 'no-store');
    assert.equal(calls[0]?.init.body, '{"guests":10}');
    assert.deepEqual(
      await fetchConfiguratorPreview({}, { fetchImpl: async () => jsonResponse({}, 429) }),
      { kind: 'rate_limited' },
    );
    assert.deepEqual(
      await fetchConfiguratorPreview({}, { fetchImpl: async () => jsonResponse({ fixed: 1 }) }),
      { kind: 'unavailable' },
    );
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await fetchConfiguratorPreview(
        {},
        {
          signal: controller.signal,
          fetchImpl: async () => {
            throw new DOMException('aborted', 'AbortError');
          },
        },
      ),
      { kind: 'aborted' },
    );
  });
});

describe('Konfigurator: Antworten der Website-Anfrage (Phase 16)', () => {
  it('W-C8. 201 ⇒ Erfolg mit Vorgangsnummer; 200 (Retry derselben ID) ⇒ derselbe Erfolg', () => {
    assert.deepEqual(
      interpretInquiryResponse(201, {
        processNumber: 'MR-2026-0042',
        receivedAt: '2026-11-06T10:00:00Z',
      }),
      {
        kind: 'success',
        processNumber: 'MR-2026-0042',
        receivedAt: '2026-11-06T10:00:00Z',
        repeated: false,
      },
    );
    assert.deepEqual(interpretInquiryResponse(200, { processNumber: 'MR-2026-0042' }), {
      kind: 'success',
      processNumber: 'MR-2026-0042',
      receivedAt: null,
      repeated: true,
    });
    assert.deepEqual(interpretInquiryResponse(201, {}), { kind: 'uncertain' });
  });

  it('W-C9. 409 PUBLIC_INQUIRY_CONFLICT mit processNumber ⇒ „bereits eingegangen“; 409 PRIVACY_NOT_PUBLISHED ⇒ neutraler Text', () => {
    assert.deepEqual(
      interpretInquiryResponse(409, {
        error: { code: 'PUBLIC_INQUIRY_CONFLICT', message: 'x', processNumber: 'MR-2026-0042' },
      }),
      { kind: 'already_received', processNumber: 'MR-2026-0042' },
    );
    assert.deepEqual(
      interpretInquiryResponse(409, { error: { code: 'PUBLIC_INQUIRY_CONFLICT' } }),
      { kind: 'already_received', processNumber: null },
    );
    const privacy = interpretInquiryResponse(409, {
      error: { code: 'PRIVACY_NOT_PUBLISHED', message: CONFIGURATOR_TEXT.PRIVACY_UNAVAILABLE },
    });
    assert.deepEqual(privacy, {
      kind: 'privacy_unavailable',
      message: CONFIGURATOR_TEXT.PRIVACY_UNAVAILABLE,
    });
    assert.deepEqual(interpretInquiryResponse(409, { error: { code: 'PRIVACY_NOT_PUBLISHED' } }), {
      kind: 'privacy_unavailable',
      message: CONFIGURATOR_TEXT.PRIVACY_UNAVAILABLE,
    });
  });

  it('W-C10. 400 ⇒ Feldpfade dem Schritt zuordnen (ohne Werte); 429/503 DEMO_RESET/5xx/Netz ⇒ erneut senden', async () => {
    const invalid = interpretInquiryResponse(400, {
      error: {
        code: 'VALIDATION_ERROR',
        issues: [
          { path: 'body.event.date', message: 'Das Datum liegt in der Vergangenheit.' },
          { path: 'body.contact.email', message: 'Bitte eine gültige E-Mail-Adresse angeben.' },
          { path: 42, message: 'kaputt' },
        ],
      },
    });
    assert.equal(invalid.kind, 'invalid');
    assert.deepEqual(invalid.kind === 'invalid' ? invalid.issues.map((issue) => issue.step) : [], [
      'event',
      'contact',
    ]);
    assert.equal(stepForIssuePath('body.machineSlug'), 'machine');
    assert.equal(stepForIssuePath('body.syrups.free.0.slug'), 'syrup');
    assert.equal(stepForIssuePath('body.canisters'), 'syrup');
    assert.equal(stepForIssuePath('body.extras.cups25'), 'syrup');
    assert.equal(stepForIssuePath('body.fulfillment.postalCode'), 'fulfillment');
    assert.equal(stepForIssuePath('body.privacyAcknowledged'), 'summary');
    assert.equal(stepForIssuePath('body'), 'summary');

    const rate = interpretInquiryResponse(429, { error: { code: 'RATE_LIMITED' } });
    const demo = interpretInquiryResponse(503, { error: { code: 'DEMO_RESET' } });
    const server = interpretInquiryResponse(500, null);
    const gateway = interpretInquiryResponse(502, null);
    const csrf = interpretInquiryResponse(403, { error: { code: 'CSRF_REJECTED' } });
    assert.deepEqual(
      [rate.kind, demo.kind, server.kind, gateway.kind, csrf.kind],
      ['rate_limited', 'demo_reset', 'uncertain', 'uncertain', 'rejected'],
    );
    assert.equal(isRetryableOutcome(rate), true);
    assert.equal(isRetryableOutcome(demo), true);
    assert.equal(isRetryableOutcome(server), true);
    assert.equal(isRetryableOutcome(csrf), false);
    assert.equal(isRetryableOutcome(invalid), false);
    assert.equal(inquiryOutcomeMessage(demo), CONFIGURATOR_TEXT.DEMO_RESET);
    assert.equal(inquiryOutcomeMessage(server), CONFIGURATOR_TEXT.UNCERTAIN);
    assert.match(CONFIGURATOR_TEXT.DEMO_RESET, /Demo-Umgebung wird gerade zurückgesetzt/);

    assert.deepEqual(
      await submitInquiry(buildInquiryPayload(filledState(), UUID_A), async () => {
        throw new TypeError('Failed to fetch');
      }),
      { kind: 'uncertain' },
    );
  });

  it('W-C11. Absenden: POST /api/public/inquiries same-origin, no-store, Payload unverändert', async () => {
    const payload = buildInquiryPayload(filledState(), UUID_A);
    const bodies: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      assert.equal(url, INQUIRY_URL);
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      bodies.push(String(init.body));
      return bodies.length === 1
        ? jsonResponse({ error: { code: 'INTERNAL' } }, 502)
        : jsonResponse({ processNumber: 'MR-2026-0042', receivedAt: 'x' }, 200);
    };
    assert.equal((await submitInquiry(payload, fetchImpl)).kind, 'uncertain');
    assert.equal((await submitInquiry(payload, fetchImpl)).kind, 'success');
    assert.equal(bodies[0], bodies[1], '„Erneut senden“ schickt den identischen Payload');
  });

  it('W-C12. Texte: unverbindlich, kein „verbindlich buchen“, Lieferung individuell, Abholadresse nie konkret', () => {
    assert.equal(CONFIGURATOR_TEXT.SUBMIT, 'Unverbindliches Angebot anfordern');
    assert.equal(CONFIGURATOR_TEXT.DELIVERY_NOTE, 'Lieferung wird individuell geprüft.');
    assert.equal(
      CONFIGURATOR_TEXT.RECOMMENDATION_FALLBACK,
      'Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.',
    );
    assert.equal(
      CONFIGURATOR_TEXT.PRIVACY_LABEL,
      'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
    );
    for (const text of Object.values(CONFIGURATOR_TEXT)) {
      assert.doesNotMatch(text, /verbindlich buchen|jetzt buchen|€|\d+ ?km/i);
    }
  });
});

describe('Konfigurator: Schritte und Prüfung (Phase 16)', () => {
  it('W-C13. Sechs Schritte in Auftrags-Reihenfolge', () => {
    assert.deepEqual(
      CONFIGURATOR_STEPS.map((step) => step.id),
      ['event', 'machine', 'syrup', 'fulfillment', 'contact', 'summary'],
    );
  });

  it('W-C14. Event: Datum Pflicht und nicht in der Vergangenheit (Berlin); Gäste ≥ 1; ≥ 250 nur Hinweis', () => {
    const state = filledState();
    assert.deepEqual(validateStep('event', state, CTX), {});
    const past = validateStep(
      'event',
      { ...state, event: { ...state.event, date: '2026-11-05' } },
      CTX,
    );
    assert.ok(past.date !== undefined);
    assert.ok(
      validateStep('event', { ...state, event: { ...state.event, date: '2026-02-30' } }, CTX).date,
    );
    assert.ok(
      validateStep('event', { ...state, event: { ...state.event, guests: '' } }, CTX).guests,
    );
    assert.ok(
      validateStep('event', { ...state, event: { ...state.event, occasion: 'x' } }, CTX).occasion,
    );
    const large = { ...state, event: { ...state.event, guests: '250' } };
    assert.deepEqual(validateStep('event', large, CTX), {}, '≥ 250 Gäste ist nie ein Fehler');
    assert.equal(isLargeEvent('250', 250), true);
    assert.equal(isLargeEvent('249', 250), false);
    assert.equal(isLargeEvent('', 250), false);
    assert.equal(endsNextDay({ startTime: '18:00', endTime: '01:00' }), true);
    assert.equal(endsNextDay({ startTime: '10:00', endTime: '18:00' }), false);
    assert.equal(endsNextDay({ startTime: '', endTime: '01:00' }), false);
    assert.equal(berlinToday(new Date('2026-11-06T23:30:00Z')), '2026-11-07');
    assert.equal(berlinToday(new Date('2026-07-01T21:59:00Z')), '2026-07-01');
    assert.equal(berlinToday(new Date('2026-07-01T22:00:00Z')), '2026-07-02');
  });

  it('W-C15. Maschine frei wählbar (nur Katalog); Gratis-Sirup: weniger erlaubt, mehr als Kontingent nicht; Kanisterlimit aus Übersicht', () => {
    const state = filledState();
    assert.deepEqual(validateStep('machine', state, CTX), {});
    assert.ok(validateStep('machine', { ...state, machineSlug: '' }, CTX).machineSlug);
    assert.ok(validateStep('machine', { ...state, machineSlug: 'popcorn' }, CTX).machineSlug);
    assert.deepEqual(validateStep('syrup', { ...state, freeSyrups: {} }, CTX), {});
    assert.ok(
      validateStep('syrup', { ...state, freeSyrups: { 'sirup-kirsche': 3 } }, CTX).freeSyrups,
    );
    assert.ok(validateStep('syrup', { ...state, canisters: 5 }, CTX).canisters);
    assert.deepEqual(
      validateStep('syrup', { ...state, canisters: 5 }, { ...CTX, quota: null }),
      {},
    );
  });

  it('W-C16. Lieferung: Straße/PLZ/Ort Pflicht, Zeitfenster optional; Kontakt ohne unnötige Pflichtfelder; Datenschutz Pflicht', () => {
    const state = filledState();
    const delivery: ConfiguratorState = { ...state, fulfillment: 'delivery' };
    assert.deepEqual(Object.keys(validateStep('fulfillment', delivery, CTX)).sort(), [
      'city',
      'postalCode',
      'street',
    ]);
    assert.deepEqual(
      validateStep(
        'fulfillment',
        {
          ...delivery,
          delivery: {
            street: 'Weg 1',
            postalCode: '55116',
            city: 'Mainz',
            windowFrom: '',
            windowTo: '',
          },
        },
        CTX,
      ),
      {},
    );
    assert.deepEqual(validateStep('fulfillment', state, CTX), {}, 'Abholung braucht keine Adresse');
    assert.deepEqual(validateStep('contact', state, CTX), {}, 'Telefon optional');
    assert.ok(
      validateStep('contact', { ...state, contact: { ...state.contact, phone: 'abc' } }, CTX).phone,
    );
    assert.ok(
      validateStep('contact', { ...state, contact: { ...state.contact, email: 'x@' } }, CTX).email,
    );
    const org = {
      ...state,
      contact: { ...state.contact, type: 'organization' as const, organizationName: ' ' },
    };
    assert.deepEqual(Object.keys(validateStep('contact', org, CTX)).sort(), [
      'contactPerson',
      'organizationName',
    ]);
    assert.ok(validateStep('summary', { ...state, privacyAcknowledged: false }, CTX).privacy);
    assert.equal(firstInvalidStep(state, CTX), null);
    assert.equal(firstInvalidStep({ ...state, privacyAcknowledged: false }, CTX), 'summary');
    assert.equal(firstInvalidStep({ ...state, machineSlug: '' }, CTX), 'machine');
  });
});
