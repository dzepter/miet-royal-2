/**
 * Phase 13 Final §5 (C7): Die Dokumentation trägt den Go-live-Blocker Routing
 * (Vertrag/Paket vs. implementierte serverseitige Zwischenspeicherung) und den
 * Schalter ROUTING_PROVIDER_TERMS_CONFIRMED – und behauptet nirgends, die
 * Nutzung sei „laut ToS erlaubt“.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function doc(name: string): string {
  return readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
}

describe('Phase 13 Final §5.1: Go-live-Blocker Routing in der Dokumentation (C7)', () => {
  it('C7. OPEN_ITEMS.md und PRE_START_CHECKLIST.md enthalten den klaren Go-live-Punkt samt Schalter', () => {
    const openItems = doc('docs/OPEN_ITEMS.md');
    expect(openItems).toContain('## GO-LIVE-BLOCKER Routing');
    expect(openItems).toContain('ROUTING_PROVIDER_TERMS_CONFIRMED');
    expect(openItems).toContain('geocoding_cache');
    expect(openItems).toMatch(/Custom-Vertrag/);
    expect(openItems).toMatch(/Distanz-\/Fahrzeitwerte/);
    expect(openItems).toMatch(/`push_deliveries`-Retention/);
    // Entschiedene Punkte (§6) stehen nicht mehr als offen in der Touren-Liste.
    const toursOpen = openItems.slice(openItems.indexOf('## Touren/Routing (nach Phase 13 offen)'));
    expect(toursOpen).not.toMatch(/Schwellen für Verspätungsrisiko/);
    expect(toursOpen).not.toMatch(/Mindestgenauigkeit des Standorts/);
    expect(toursOpen).not.toMatch(/erhält keinen Tour-Snapshot/);

    const checklist = doc('docs/PRE_START_CHECKLIST.md');
    expect(checklist).toContain('GO-LIVE-BLOCKER Routing');
    expect(checklist).toContain('ROUTING_PROVIDER_TERMS_CONFIRMED=true');
    expect(checklist).toContain('geocoding_cache');

    const notes = doc('docs/ROUTING_API_NOTES.md');
    expect(notes).toContain('ROUTING_PROVIDER_TERMS_CONFIRMED');
    expect(notes).toMatch(/nicht ausdrücklich geregelt/);
    expect(notes).toMatch(/vertraglich zu klären/);
    expect(notes).not.toMatch(/laut ToS (sicher )?erlaubt\b(?! ist“)/);

    for (const name of ['docs/DEPLOYMENT_NOTES.md', 'docs/ENVIRONMENTS.md', '.env.example']) {
      expect(doc(name), name).toContain('ROUTING_PROVIDER_TERMS_CONFIRMED');
    }
    const decisions = doc('docs/TECH_DECISIONS.md');
    expect(decisions).toContain('## Phase 13 Final: bestätigte Produktentscheidungen');
    expect(decisions).toContain('DELAY_LOCATION_MAX_ACCURACY_METERS');
  });
});
