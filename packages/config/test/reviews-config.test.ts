/**
 * Phase 16 (REVIEWS, Order §18/§21/§25, Design §4/§11.2.6/§11.3): Konfiguration der
 * Google-Bewertungen je Umgebung – Default disabled, Fake nur demo/development, Google nie in
 * demo und nur mit Key + Place ID + ausdrücklicher Bestätigung, Key nur im Config-Objekt,
 * Environment-Isolation des Places-Keys, Reviews-Block in .env.example und
 * docs/GOOGLE_REVIEWS_API_NOTES.md. Namen laufen als „RC<n>.“.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
  REVIEWS_DEFAULT_DAILY_REQUEST_LIMIT,
} from '../src/index.ts';

const production = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
  STORAGE_DRIVER: 'fs',
  STORAGE_FS_ROOT: '/var/lib/mietroyal/prod',
  AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
};
const staging = {
  ...production,
  APP_ENV: 'staging',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_staging',
  STORAGE_FS_ROOT: '/var/lib/mietroyal/staging',
  AUTH_SECRET_KEY: 'staging-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'staging-communication-payload-key-0123456789',
};
const demo = {
  ...production,
  APP_ENV: 'demo',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_demo',
  STORAGE_FS_ROOT: '/var/lib/mietroyal/demo',
  AUTH_SECRET_KEY: 'demo-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'demo-communication-payload-key-0123456789',
};
const development = { APP_ENV: 'development' };

const SYNTH_KEY = 'SYNTH-places-key-0123456789-never-real';
const SYNTH_PLACE_ID = 'ChIJSynthPlaceId_0123-abc';
const GOOGLE = {
  REVIEWS_PROVIDER: 'google',
  GOOGLE_PLACES_API_KEY: SYNTH_KEY,
  GOOGLE_PLACE_ID: SYNTH_PLACE_ID,
  GOOGLE_REVIEWS_TERMS_CONFIRMED: 'true',
};

function configError(env: Record<string, string>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error('ConfigError erwartet');
}

function doc(name: string): string {
  return readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
}

describe('Phase 16: Konfiguration Google-Bewertungen', () => {
  it('RC1. Default in JEDER Umgebung: disabled, kein Key, keine Place ID, Tagesgrenze 32', () => {
    for (const env of [development, staging, demo, production]) {
      const config = loadConfig(env);
      expect(config.reviews).toEqual({
        provider: 'disabled',
        termsConfirmed: false,
        dailyRequestLimit: REVIEWS_DEFAULT_DAILY_REQUEST_LIMIT,
        google: { apiKey: null, placeId: null },
      });
    }
    expect(REVIEWS_DEFAULT_DAILY_REQUEST_LIMIT).toBe(32);
  });

  it('RC2. fake: in production UND staging Startfehler; in demo und development erlaubt', () => {
    for (const env of [production, staging]) {
      const error = configError({ ...env, REVIEWS_PROVIDER: 'fake' });
      expect(error.problems.join('\n')).toMatch(
        /REVIEWS_PROVIDER: fake ist in (production|staging)/,
      );
    }
    expect(loadConfig({ ...demo, REVIEWS_PROVIDER: 'fake' }).reviews.provider).toBe('fake');
    expect(loadConfig({ ...development, REVIEWS_PROVIDER: 'fake' }).reviews.provider).toBe('fake');
  });

  it('RC3. demo: google verboten – auch ein gesetzter GOOGLE_PLACES_API_KEY allein ist ein Fehler', () => {
    const google = configError({ ...demo, ...GOOGLE });
    const text = google.problems.join('\n');
    expect(text).toMatch(/REVIEWS_PROVIDER: google ist in demo nicht zulässig/);
    expect(text).toMatch(/GOOGLE_PLACES_API_KEY: in demo nicht zulässig/);
    expect(text).not.toContain(SYNTH_KEY);
    for (const provider of ['fake', 'disabled']) {
      const keyOnly = configError({
        ...demo,
        REVIEWS_PROVIDER: provider,
        GOOGLE_PLACES_API_KEY: SYNTH_KEY,
      });
      expect(keyOnly.problems).toEqual([
        'GOOGLE_PLACES_API_KEY: in demo nicht zulässig (Demo ruft nie Google)',
      ]);
    }
  });

  it('RC4. google ohne Key, Place ID oder Bestätigung ⇒ Startfehler (jede fehlende Angabe benannt, in allen Nicht-Demo-Umgebungen)', () => {
    for (const env of [production, staging, development]) {
      const nothing = configError({ ...env, REVIEWS_PROVIDER: 'google' });
      expect(nothing.problems).toEqual([
        'GOOGLE_PLACES_API_KEY: muss gesetzt sein, wenn REVIEWS_PROVIDER=google',
        'GOOGLE_PLACE_ID: muss gesetzt sein, wenn REVIEWS_PROVIDER=google',
        expect.stringMatching(/^GOOGLE_REVIEWS_TERMS_CONFIRMED: REVIEWS_PROVIDER=google erfordert/),
      ]);
      const { GOOGLE_PLACES_API_KEY: _k, ...withoutKey } = GOOGLE;
      expect(configError({ ...env, ...withoutKey }).problems.join('\n')).toContain(
        'GOOGLE_PLACES_API_KEY',
      );
      const { GOOGLE_PLACE_ID: _p, ...withoutPlace } = GOOGLE;
      expect(configError({ ...env, ...withoutPlace }).problems.join('\n')).toContain(
        'GOOGLE_PLACE_ID',
      );
      for (const confirmed of ['false', '']) {
        const unconfirmed = configError({
          ...env,
          ...GOOGLE,
          GOOGLE_REVIEWS_TERMS_CONFIRMED: confirmed,
        });
        expect(unconfirmed.problems.join('\n')).toContain('GOOGLE_REVIEWS_TERMS_CONFIRMED');
        expect(unconfirmed.message).not.toContain(SYNTH_KEY);
      }
    }
  });

  it('RC5. google vollständig ⇒ provider google mit Key/Place ID; Tagesgrenze konfigurierbar', () => {
    const config = loadConfig({ ...production, ...GOOGLE });
    expect(config.reviews).toEqual({
      provider: 'google',
      termsConfirmed: true,
      dailyRequestLimit: 32,
      google: { apiKey: SYNTH_KEY, placeId: SYNTH_PLACE_ID },
    });
    expect(
      loadConfig({ ...staging, ...GOOGLE, REVIEWS_DAILY_REQUEST_LIMIT: '8' }).reviews
        .dailyRequestLimit,
    ).toBe(8);
    for (const bad of ['0', '-1', 'abc', '1.5', '100001']) {
      const error = configError({ ...production, ...GOOGLE, REVIEWS_DAILY_REQUEST_LIMIT: bad });
      expect(error.problems.join('\n')).toContain('REVIEWS_DAILY_REQUEST_LIMIT');
    }
  });

  it('RC6. Key nur bei provider google im Objekt, sonst null; nirgends sonst im Config-Objekt; Fehler nennen nie Werte', () => {
    for (const provider of ['disabled', 'fake']) {
      const config = loadConfig({
        ...development,
        REVIEWS_PROVIDER: provider,
        GOOGLE_PLACES_API_KEY: SYNTH_KEY,
        GOOGLE_PLACE_ID: SYNTH_PLACE_ID,
      });
      expect(config.reviews.google).toEqual({ apiKey: null, placeId: null });
      expect(JSON.stringify(config)).not.toContain(SYNTH_KEY);
    }
    const config = loadConfig({ ...production, ...GOOGLE });
    const { reviews, ...rest } = config;
    expect(JSON.stringify(rest)).not.toContain(SYNTH_KEY);
    const { apiKey, ...googleRest } = reviews.google;
    expect(apiKey).toBe(SYNTH_KEY);
    expect(JSON.stringify({ ...reviews, google: googleRest })).not.toContain(SYNTH_KEY);
    // Ungültige Werte: Meldung nennt nur die Variable, nie den Wert.
    const withSpace = configError({
      ...production,
      ...GOOGLE,
      GOOGLE_PLACES_API_KEY: `${SYNTH_KEY} injected`,
    });
    expect(withSpace.message).toContain('GOOGLE_PLACES_API_KEY');
    expect(withSpace.message).not.toContain(SYNTH_KEY);
    const header = configError({
      ...production,
      ...GOOGLE,
      GOOGLE_PLACES_API_KEY: `${SYNTH_KEY}\r\nX-Evil: 1`,
    });
    expect(header.message).toContain('GOOGLE_PLACES_API_KEY');
    for (const placeId of ['ChIJ/../x', 'ChIJ?x=1', 'ChIJ abc', 'ä'.repeat(4), 'a'.repeat(1025)]) {
      const error = configError({ ...production, ...GOOGLE, GOOGLE_PLACE_ID: placeId });
      expect(error.message).toContain('GOOGLE_PLACE_ID');
    }
    expect(() => loadConfig({ ...production, REVIEWS_PROVIDER: 'meta' })).toThrow(
      /REVIEWS_PROVIDER/,
    );
  });

  it('RC7. leere Werte (wie in .env.example) gelten als nicht gesetzt', () => {
    const blank = {
      REVIEWS_PROVIDER: '',
      GOOGLE_PLACES_API_KEY: '',
      GOOGLE_PLACE_ID: ' ',
      GOOGLE_REVIEWS_TERMS_CONFIRMED: '',
      REVIEWS_DAILY_REQUEST_LIMIT: '',
    };
    for (const env of [production, demo, development]) {
      expect(loadConfig({ ...env, ...blank }).reviews).toEqual({
        provider: 'disabled',
        termsConfirmed: false,
        dailyRequestLimit: 32,
        google: { apiKey: null, placeId: null },
      });
    }
  });

  it('RC8. Environment-Isolation: derselbe Places-Key in zwei Umgebungen kollidiert (ohne Wert im Text); getrennte Keys nicht; Demo hat nie einen Key', () => {
    const prod = loadConfig({ ...production, ...GOOGLE });
    const stagingSame = loadConfig({ ...staging, ...GOOGLE });
    try {
      assertConfigsIsolated(prod, stagingSame);
      expect.unreachable('geteilter Places-Key muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      const isolation = error as EnvironmentIsolationError;
      expect(isolation.collisions).toEqual([
        'GOOGLE_PLACES_API_KEY: beide Umgebungen nutzen denselben Google-Places-API-Key',
      ]);
      expect(isolation.message).not.toContain(SYNTH_KEY);
    }
    // Gleiche Place ID ist kein Geheimnis ⇒ keine Kollision.
    const stagingOther = loadConfig({
      ...staging,
      ...GOOGLE,
      GOOGLE_PLACES_API_KEY: 'SYNTH-other-staging-places-key',
    });
    expect(() => assertConfigsIsolated(prod, stagingOther)).not.toThrow();
    // Demo (Fake) neben Live (Google): isoliert; ein Demo-Key wäre bereits ein Startfehler.
    const demoFake = loadConfig({ ...demo, REVIEWS_PROVIDER: 'fake' });
    expect(() => assertConfigsIsolated(prod, demoFake)).not.toThrow();
    expect(() => loadConfig({ ...demo, GOOGLE_PLACES_API_KEY: SYNTH_KEY })).toThrow(ConfigError);
  });

  it('RC9. .env.example trägt den Reviews-Block; GOOGLE_REVIEWS_API_NOTES.md nennt Caching-Verbot, EWR-Schalter und Go-live-Punkte', () => {
    const example = doc('.env.example');
    for (const name of [
      'REVIEWS_PROVIDER=',
      'GOOGLE_PLACES_API_KEY=',
      'GOOGLE_PLACE_ID=',
      'GOOGLE_REVIEWS_TERMS_CONFIRMED=',
      'REVIEWS_DAILY_REQUEST_LIMIT=',
    ]) {
      expect(example).toMatch(new RegExp(`^${name}$`, 'm'));
    }
    // Kein echter Wert im Beispiel.
    expect(example).not.toMatch(/^GOOGLE_PLACES_API_KEY=.+$/m);

    // Zeilenumbrüche/Zitatmarker der Markdown-Zitate zusammenfassen.
    const notes = doc('docs/GOOGLE_REVIEWS_API_NOTES.md')
      .replace(/\n>\s*/g, ' ')
      .replace(/\s+/g, ' ');
    expect(notes).toContain('https://places.googleapis.com/v1/places/');
    expect(notes).toContain('X-Goog-FieldMask');
    expect(notes).toContain('copy and save business names, addresses, or user reviews');
    expect(notes).toContain(
      'Customer will not cache Google Maps Content except as expressly permitted under the Maps Service Specific Terms',
    );
    expect(notes).toContain('GOOGLE_REVIEWS_TERMS_CONFIRMED');
    expect(notes).toContain('Places API EEA Permitted Uses');
    expect(notes).toMatch(/fail-closed/);
    expect(notes).toContain('## Go-live ');
    expect(notes).toContain('https://cloud.google.com/terms/maps-platform/eea');
  });
});
