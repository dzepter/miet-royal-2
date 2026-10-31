/**
 * Phase 13 (Fix F6): reine Adress-Zerlegung ohne DB-/Provider-Abhängigkeit –
 * von GeocodingService (Entscheidungsregel), MockRoutingGateway (fake.ts) und
 * dem Contract-Fake-Server (testing/fake-server.ts) gemeinsam genutzt, damit
 * Mock-/Fake-Kandidaten dieselben Bestandteile (Straße, Hausnummer, PLZ, Ort)
 * zurückgeben, die die konservative Regel `decideGeocoding` prüft.
 */

export interface ParsedAddressInput {
  streetName: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
}

/** Normalisierung (nur Suchkontext, kein Fachdatum): trim, Mehrfach-Whitespace zu einem Leerzeichen. */
export function normalizeAddressText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Straßenname vergleichbar machen („Robert-Koch-Straße“ ≙ „robert koch str.“). */
export function normalizeStreetName(value: string): string {
  return value
    .toLowerCase()
    .replace(/straße|strasse|str\./g, 'str')
    .replace(/[^a-z0-9äöüß]+/g, '')
    .trim();
}

export function normalizeHousenumber(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

/** Eingabeadresse („Lieferweg 12, 55129 Mainz“) in Vergleichsbestandteile zerlegen. */
export function parseAddressInput(text: string): ParsedAddressInput {
  const normalized = normalizeAddressText(text);
  const parts = normalized
    .split(/\s*,\s*/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const streetPart = parts[0] ?? '';
  const streetMatch = /^(.*?)\s+(\d+\s?[a-zA-Z]?(?:\s?[-/]\s?\d+\s?[a-zA-Z]?)?)$/.exec(streetPart);
  const streetName = streetMatch ? streetMatch[1]! : streetPart;
  const housenumber = streetMatch ? normalizeHousenumber(streetMatch[2]!) : null;
  const rest = parts.slice(1).join(' ');
  const postcodeMatch = /\b(\d{5})\b/.exec(rest);
  const postcode = postcodeMatch ? postcodeMatch[1]! : null;
  const cityRaw = postcodeMatch ? rest.slice(postcodeMatch.index + postcodeMatch[0].length) : rest;
  const city = normalizeAddressText(cityRaw).replace(/^deutschland$/i, '');
  return {
    streetName: streetName.trim() === '' ? null : streetName.trim(),
    housenumber,
    postcode,
    city: city === '' ? null : city,
  };
}

/**
 * Mock-/Fake-Hilfe: Provider-Anfrage („…, Deutschland“) in die Bestandteile
 * eines Kandidaten übersetzen – Landessuffix und Klammerzusätze („(SYNTHETISCH)“)
 * werden entfernt, der Ort bleibt sonst wie eingegeben.
 */
export function parseGeocodeQuery(query: string): ParsedAddressInput {
  const withoutCountry = normalizeAddressText(query).replace(/,\s*deutschland\s*$/i, '');
  const parsed = parseAddressInput(withoutCountry);
  const city =
    parsed.city === null ? null : normalizeAddressText(parsed.city.replace(/\([^)]*\)/g, ''));
  return { ...parsed, city: city === '' ? null : city };
}
