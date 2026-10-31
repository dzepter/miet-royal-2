/**
 * Phase-13-Pflichttests 1–10 und 16 (Order §72): Routing-Konfiguration je
 * Umgebung – production nur graphhopper|disabled mit festem Host, demo immer
 * Mock, development/staging Opt-in, Key nie außerhalb des Config-Objekts,
 * Environment-Isolation des GraphHopper-Keys.
 */
import { describe, expect, it } from 'vitest';
import {
  assertConfigsIsolated,
  ConfigError,
  EnvironmentIsolationError,
  loadConfig,
  ROUTING_PRODUCTION_BASE_URL,
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
const SYNTH_KEY = 'SYNTH-graphhopper-key-never-real';

describe('Routing-Konfiguration (Phase 13)', () => {
  it('T1. production ohne GRAPHHOPPER_API_KEY ⇒ provider disabled (fail closed, kein Fake)', () => {
    const config = loadConfig(production);
    expect(config.routing.provider).toBe('disabled');
    expect(config.routing.enabled).toBe(false);
    expect(config.routing.graphhopper.apiKey).toBeNull();
    expect(config.routing.graphhopper.baseUrl).toBe(ROUTING_PRODUCTION_BASE_URL);
    // Auch ROUTING_ENABLED=true ohne Key bleibt disabled – nie still ein Mock.
    const forced = loadConfig({ ...production, ROUTING_ENABLED: 'true' });
    expect(forced.routing.provider).toBe('disabled');
  });

  it('T2. production kann keinen Fake/Mock erzeugen: ROUTING_PROVIDER=mock ⇒ ConfigError', () => {
    expect(() => loadConfig({ ...production, ROUTING_PROVIDER: 'mock' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...production, ROUTING_PROVIDER: 'mock' })).toThrow(
      /ROUTING_PROVIDER/,
    );
    expect(() =>
      loadConfig({ ...production, ROUTING_PROVIDER: 'mock', GRAPHHOPPER_API_KEY: SYNTH_KEY }),
    ).toThrow(/ROUTING_PROVIDER/);
    // Mit Key ⇒ graphhopper; explizit disabled bleibt disabled (Key dann nicht im Objekt).
    const live = loadConfig({ ...production, GRAPHHOPPER_API_KEY: SYNTH_KEY });
    expect(live.routing.provider).toBe('graphhopper');
    expect(live.routing.enabled).toBe(true);
    expect(live.routing.graphhopper.apiKey).toBe(SYNTH_KEY);
    const off = loadConfig({
      ...production,
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      ROUTING_PROVIDER: 'disabled',
    });
    expect(off.routing.provider).toBe('disabled');
    expect(off.routing.graphhopper.apiKey).toBeNull();
    const offFlag = loadConfig({
      ...production,
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      ROUTING_ENABLED: 'false',
    });
    expect(offFlag.routing.provider).toBe('disabled');
    expect(offFlag.routing.graphhopper.apiKey).toBeNull();
  });

  it('T3. demo ist immer Mock (auch mit ROUTING_ENABLED=true/ROUTING_PROVIDER=mock)', () => {
    expect(loadConfig(demo).routing.provider).toBe('mock');
    expect(loadConfig(demo).routing.enabled).toBe(true);
    expect(loadConfig({ ...demo, ROUTING_ENABLED: 'true' }).routing.provider).toBe('mock');
    expect(loadConfig({ ...demo, ROUTING_PROVIDER: 'mock' }).routing.provider).toBe('mock');
    expect(loadConfig(demo).routing.graphhopper.apiKey).toBeNull();
  });

  it('T4. demo mit echtem Key oder ROUTING_PROVIDER=graphhopper ⇒ ConfigError („Demo ruft nie einen echten Routing-Provider“)', () => {
    for (const env of [
      { ...demo, GRAPHHOPPER_API_KEY: SYNTH_KEY },
      { ...demo, ROUTING_PROVIDER: 'graphhopper' },
      {
        ...demo,
        ROUTING_ENABLED: 'true',
        ROUTING_PROVIDER: 'graphhopper',
        GRAPHHOPPER_API_KEY: SYNTH_KEY,
      },
      { ...demo, GRAPHHOPPER_BASE_URL: 'http://127.0.0.1:4567/api/1' },
    ]) {
      try {
        loadConfig(env);
        expect.unreachable('demo darf keinen echten Routing-Provider konfigurieren');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as ConfigError).message;
        expect(message).toMatch(/GRAPHHOPPER_|ROUTING_PROVIDER/);
        expect(message).toMatch(/echten Routing-Provider|Mock/);
        expect(message).not.toContain(SYNTH_KEY);
      }
    }
  });

  it('T5. staging Default disabled; development Default mock; echter Provider nur per vollständigem Opt-in', () => {
    expect(loadConfig(staging).routing.provider).toBe('disabled');
    expect(loadConfig({ APP_ENV: 'development' }).routing.provider).toBe('mock');
    // Key allein (ohne Opt-in) bleibt unbenutzt – nicht im Objekt.
    const keyOnly = loadConfig({ ...staging, GRAPHHOPPER_API_KEY: SYNTH_KEY });
    expect(keyOnly.routing.provider).toBe('disabled');
    expect(keyOnly.routing.graphhopper.apiKey).toBeNull();
    const devKeyOnly = loadConfig({ APP_ENV: 'development', GRAPHHOPPER_API_KEY: SYNTH_KEY });
    expect(devKeyOnly.routing.provider).toBe('mock');
    expect(devKeyOnly.routing.graphhopper.apiKey).toBeNull();
    // Opt-in unvollständig ⇒ Fehler, der nur Variablennamen nennt.
    expect(() => loadConfig({ ...staging, ROUTING_PROVIDER: 'graphhopper' })).toThrow(
      /GRAPHHOPPER_API_KEY/,
    );
    expect(() =>
      loadConfig({ ...staging, ROUTING_PROVIDER: 'graphhopper', GRAPHHOPPER_API_KEY: SYNTH_KEY }),
    ).toThrow(/ROUTING_ENABLED/);
    // Vollständiges Opt-in ⇒ graphhopper, Fake-Host erlaubt (ohne Slash am Ende).
    const optIn = loadConfig({
      ...staging,
      ROUTING_ENABLED: 'true',
      ROUTING_PROVIDER: 'graphhopper',
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      GRAPHHOPPER_BASE_URL: 'http://127.0.0.1:4567/api/1/',
      ROUTING_REQUEST_TIMEOUT_MS: '2000',
    });
    expect(optIn.routing.provider).toBe('graphhopper');
    expect(optIn.routing.graphhopper.apiKey).toBe(SYNTH_KEY);
    expect(optIn.routing.graphhopper.baseUrl).toBe('http://127.0.0.1:4567/api/1');
    expect(optIn.routing.graphhopper.requestTimeoutMs).toBe(2000);
    // Opt-out explizit möglich; staging darf bewusst mock wählen (nicht production).
    expect(loadConfig({ APP_ENV: 'development', ROUTING_ENABLED: 'false' }).routing.provider).toBe(
      'disabled',
    );
    expect(loadConfig({ ...staging, ROUTING_PROVIDER: 'mock' }).routing.provider).toBe('mock');
    expect(
      loadConfig({
        ...staging,
        ROUTING_PROVIDER: 'graphhopper',
        ROUTING_ENABLED: 'true',
        GRAPHHOPPER_API_KEY: SYNTH_KEY,
      }).routing.graphhopper.requestTimeoutMs,
    ).toBe(15_000);
  });

  it('T6./T7./T8. der Key existiert nur unter routing.graphhopper.apiKey – keine Kopie an anderer Stelle (Browser/DB/Log erhalten das Objekt nie)', () => {
    const config = loadConfig({ ...production, GRAPHHOPPER_API_KEY: SYNTH_KEY });
    const { routing, ...rest } = config;
    expect(JSON.stringify(rest)).not.toContain(SYNTH_KEY);
    const { apiKey, ...routingRest } = routing.graphhopper;
    expect(apiKey).toBe(SYNTH_KEY);
    expect(JSON.stringify({ ...routing, graphhopper: routingRest })).not.toContain(SYNTH_KEY);
    // ConfigError-Texte nennen nie Werte.
    try {
      loadConfig({ ...demo, GRAPHHOPPER_API_KEY: SYNTH_KEY });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(SYNTH_KEY);
    }
  });

  it('T9. production: Host fest https://graphhopper.com/api/1 (auch mit gleichlautender Angabe)', () => {
    const config = loadConfig({ ...production, GRAPHHOPPER_API_KEY: SYNTH_KEY });
    expect(config.routing.graphhopper.baseUrl).toBe('https://graphhopper.com/api/1');
    const same = loadConfig({
      ...production,
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      GRAPHHOPPER_BASE_URL: 'https://graphhopper.com/api/1/',
    });
    expect(same.routing.graphhopper.baseUrl).toBe('https://graphhopper.com/api/1');
  });

  it('T10. production: fremder GRAPHHOPPER_BASE_URL-Override wird blockiert (ConfigError ohne Key im Text)', () => {
    for (const url of [
      'https://graphhopper.evil.example/api/1',
      'http://127.0.0.1:4567/api/1',
      'https://graphhopper.com/api/2',
      'https://staff.example.de/api/1',
    ]) {
      try {
        loadConfig({ ...production, GRAPHHOPPER_API_KEY: SYNTH_KEY, GRAPHHOPPER_BASE_URL: url });
        expect.unreachable(`fremder Host ${url} darf in production nicht starten`);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain('GRAPHHOPPER_BASE_URL');
        expect((error as ConfigError).message).not.toContain(SYNTH_KEY);
      }
    }
    // Auch ohne Key (disabled) bleibt ein fremder Host ein Fehler – kein stiller Override.
    expect(() =>
      loadConfig({ ...production, GRAPHHOPPER_BASE_URL: 'https://graphhopper.evil.example' }),
    ).toThrow(/GRAPHHOPPER_BASE_URL/);
  });

  it('T16. Environment-Isolation: derselbe GraphHopper-Key in zwei Umgebungen kollidiert; getrennte Keys nicht', () => {
    const prod = loadConfig({ ...production, GRAPHHOPPER_API_KEY: SYNTH_KEY });
    const stagingSame = loadConfig({
      ...staging,
      ROUTING_ENABLED: 'true',
      ROUTING_PROVIDER: 'graphhopper',
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
    });
    try {
      assertConfigsIsolated(prod, stagingSame);
      expect.unreachable('geteilter GraphHopper-Key muss erkannt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentIsolationError);
      const text = (error as EnvironmentIsolationError).collisions.join('\n');
      expect(text).toContain('GRAPHHOPPER_API_KEY');
      expect(text).not.toContain(SYNTH_KEY);
    }
    const stagingOther = loadConfig({
      ...staging,
      ROUTING_ENABLED: 'true',
      ROUTING_PROVIDER: 'graphhopper',
      GRAPHHOPPER_API_KEY: 'SYNTH-other-staging-key',
    });
    expect(() => assertConfigsIsolated(prod, stagingOther)).not.toThrow();
    // Demo (Mock, kein Key) kollidiert nie über den Routing-Key.
    expect(() => assertConfigsIsolated(prod, loadConfig(demo))).not.toThrow();
  });
});
