# ROUTING_API_NOTES — GraphHopper Directions API (Stand der Verifikation)

**Verifiziert am:** 30.10.2026 (zwei Durchgänge) ausschließlich gegen offizielle
Quellen: die GraphHopper-Dokumentation (Redocly-Markdown der Endpunkte,
u. a. `docs.graphhopper.com/openapi/matrices`, `postmatrix.md`,
`getmatrixsolution.md`) und das offizielle OpenAPI-Bundle
`https://docs.graphhopper.com/_bundle/openapi.yaml`, den offiziellen Client
`@graphhopper/directions-api-js-client` (GitHub `graphhopper/directions-api-js-client`,
npm-Paket seit 15.09.2025), die Pricing-, Terms-of-Service-, Privacy- und
Attribution-Seiten von graphhopper.com, die Support-Artikel 44000718211
(Credits) und 44001976065 (429) sowie `status.graphhopper.com`. Keine Blogs,
keine Drittbibliotheken. Was in keiner dieser Quellen steht, ist unten als
„nicht dokumentiert“ markiert und wird NICHT verwendet. Vor jedem Release
erneut gegen die Doku prüfen (ein Changelog wurde nicht gefunden).

## Grundlagen
- Basis-URL: `https://graphhopper.com/api/1` (Client-Default; kein eigener
  Versionspfad). In production ist dieser Host fest (`ROUTING_PRODUCTION_BASE_URL`);
  jeder andere `GRAPHHOPPER_BASE_URL` wird beim Start abgelehnt.
- Auth: API-Key AUSSCHLIESSLICH als Query-Parameter `key=` („passing your key
  as a query parameter in every request“; OpenAPI Security `apiKey` in `query`,
  Name `key`; ToS §5.1). Header-Auth ist NICHT dokumentiert. Folge: Der Key steht
  in jeder URL ⇒ URLs/Queries erscheinen nie in Logs oder Fehlermeldungen
  (`maskRoutingUrl`, Pino-Redaction `routing.graphhopper.apiKey`,
  `GRAPHHOPPER_API_KEY`); der Client loggt nur `{method, endpoint, status,
  outcome, durationMs, credits}`.
- Status (30.10.2026): `status.graphhopper.com` „All Systems Operational“. SLA 99,5 %.

## Rate-Limit-Header (jede Antwort, ROOT-Dokumentation)
- `X-RateLimit-Limit` – Tageskontingent in Credits.
- `X-RateLimit-Remaining` – verbleibende Credits (vor Abzug dieses Requests).
- `X-RateLimit-Reset` – Sekunden bis zum Reset.
- `X-RateLimit-Credits` – Kosten dieses Requests (kann dezimal oder negativ sein).
- 429 = „daily or per-minute limit is exhausted“ (Fehlerkörper GHError
  `{message, hints[{message}]}`); Support-Artikel 44001976065: „Minutely API
  limit heavily violated“ ⇒ bis zur nächsten Minute warten. Ob ein 429 vom
  Minuten- oder Tageslimit stammt, ist aus Body/Headern nicht sicher
  unterscheidbar ⇒ Client: `rate_limited` (transient) mit `retryAfterMs` aus
  `X-RateLimit-Reset`; nur wenn `X-RateLimit-Remaining ≤ 0` UND Reset > 60 s ⇒
  `credit_limited` (permanent, keine Retries). Ohne auswertbaren Header: Pause
  60 s. Der Client macht NIE eigene Retries; eine in-process-Drossel erlaubt
  höchstens 1 Request/s (konservativ unter dem Basic-Plan) und pausiert nach
  429 – kein Retry-Sturm. Review-Fix F1: Die Pause lässt NIEMANDEN warten –
  während der Pause scheitert jeder Aufruf sofort (`rate_limited` bzw.
  `credit_limited`, Status 429, Rest der Pause als `retryAfterMs`, kein
  Provider-Request); ein Minuten-429 (Remaining > 0 oder unbekannt) pausiert
  höchstens 60 s, auch wenn `X-RateLimit-Reset` den Tagesreset nennt;
  `credit_limited` (Remaining ≤ 0, Reset > 60 s) pausiert bis zum Reset.

## HTTP-Codes und Fehlerklassifikation
Dokumentiert: `/route` 200/400/401/429/500; `/matrix` nur 200 (Fehlerkörper
`{"message": "Cannot find from_points: 1"}` aus der Matrix-Doku); `/geocode`
nur 200; `/vrp` 200/400/500; `/vrp/solution` 200/400/404/500. Fehlerkörper
GHError `{message, hints[]}` (400 mit `hints`). Da die Codes nicht je Endpunkt
vollständig dokumentiert sind, klassifiziert der Client generisch:
400 `validation`, 401/403 `auth_invalid`, 404 `not_found`, 429
`rate_limited`/`credit_limited`, 5xx `server_error`, Abbruch durch Timeout
`timeout`, fetch-Fehler (inkl. Redirect, `redirect: 'error'`) `network`,
zod-Validierungsfehler der Antwort `invalid_response` (fail-closed). Transient
(erneute Berechnung erlaubt): rate_limited, timeout, network, server_error.
Provider-Fehlertexte werden nie weitergegeben (nur neutrale Codes
`ROUTING_<KIND>`).

## Endpunkte und genutzte Felder
### Routing `POST /route?key=`
- Body (nur dokumentierte Felder): `points: [[lon, lat], …]`, `profile: "car"`,
  `points_encoded: false`, `instructions: false`, `calc_points: false`,
  `elevation: false`, `locale: "de"`. Koordinatenreihenfolge [lon, lat]!
- Antwort (genutzt): `paths[0].distance` (Meter), `paths[0].time`
  (Millisekunden); zusätzlich dokumentiert `bbox`, `info.copyrights`.
- Credits: 2–10 Locations = 1 Credit (Support 44000718211); `alternative_route`
  +1, `round_trip` 2, `optimize=true` 10× – nichts davon genutzt.
- Elevation ist per Default an und würde die Attribution „Elevation data by
  Mapterhorn“ erfordern ⇒ wir setzen `elevation: false`.
- Die dokumentierte Antwort enthält nur Gesamtwerte je Pfad, keine Werte je
  Abschnitt ⇒ `route()` ruft `/route` je aufeinanderfolgendem Punktepaar auf
  (N−1 Credits); für ≥ 3 Punkte ist `matrix()` meist die bessere Wahl.

### Matrix `POST /matrix?key=`
- Body: `points: [[lon, lat], …]` (symmetrische N×N-Matrix; bei zwei Punkten
  `from_points`/`to_points`), `profile: "car"`, `out_arrays: ["times",
  "distances"]`, `fail_fast: false` ⇒ `null` für unerreichbare Paare statt Fehler.
- Antwort: `times` (Sekunden) `[[from→to]]`, `distances` (Meter), `null` bei
  Unerreichbarkeit; `info.copyrights` `["GraphHopper", "OpenStreetMap contributors"]`,
  `info.took`, `hints[] {message, details, invalid_from_points,
  invalid_to_points, point_pairs}`. Default `out_arrays` = `["times"]`.
- Asynchrone Variante `POST /matrix/calculate` + `GET /matrix/solution/{jobId}`
  existiert („prefer the regular endpoints“) – nicht genutzt.
- Credits: `min(origins×destinations/2, max(origins, destinations)×10)`, mindestens 1.

### Route Optimization `POST /vrp?key=` (synchron, ≤ 10 s Lösungszeit)
- Identischer Body wie `/vrp/optimize` (asynchron: `job_id`, dann
  `GET /vrp/solution/{job_id}` mit Status `waiting_in_queue|processing|finished`,
  Polling 500 ms empfohlen, 0,3 Credits je GET) – wir nutzen NUR den synchronen
  Endpunkt.
- Genutzte Felder: `vehicles[{vehicle_id, type_id, start_address{location_id,
  lon, lat}, return_to_depot: true, earliest_start (Unix-Sekunden)}]`
  (`end_address`, `latest_end` dokumentiert, nicht genutzt),
  `vehicle_types[{type_id, profile: "car"}]`, `services[{id,
  address{location_id, lon, lat}, duration (Sekunden), time_windows[{earliest,
  latest}] (Unix-Sekunden, HARTE Constraints)}]`, `relations[{type:
  "in_sequence", ids: [...]}]` (Anker `"start"`/`"end"` dokumentiert;
  `in_direct_sequence` dokumentiert, nicht genutzt), `objectives[{type: "min",
  value: "completion_time"}]`, `configuration.routing.calc_points: false`.
- Antwort: `solution{distance, transport_time, completion_time,
  routes[{activities[{type start|service|end, id, location_id, arr_time,
  end_time, waiting_time, distance (kumuliert), driving_time (kumuliert)}]}],
  unassigned{services[], details[{id, code, reason}]}}`. Unassigned-Codes:
  2 = Zeitfenster nicht einhaltbar, 21 = Relation, 50/51 = Standort nicht
  erreichbar/isoliert.
- Credits: #vehicles × #locations, mindestens 10, höchstens 10 × #locations.
- FESTE POSITION eines Stopps (gepinnt an Platz n) ist NICHT dokumentiert –
  nur Reihenfolge-Relationen. Für gepinnte Stopps nutzt die Planung deshalb
  Matrix + lokalen deterministischen Planer (Order §20).

### Geocoding `GET /geocode?q=…&locale=de&limit=5&provider=nominatim&key=`
- Antwort: `hits[{point{lat, lng}, osm_id, osm_type, osm_key, name, country,
  city, state, street, housenumber, postcode}]` (`osm_value`, `extent` nur im
  Beispiel). Nur diese Felder werden gelesen; `osm_type`+`osm_id` bilden die
  Wiedererkennungs-Referenz `osm:<type><id>`.
- Provider: `default`, `gisgraphy`, `nominatim`, `nettoolkit`, `opencagedata`.
  Der Provider `default` ist eine Prefix-/Autocomplete-Suche und „may lead to
  sub-optimal results if used without user interaction. See e.g.
  provider=nominatim as an appropriate alternative for less interactive use
  cases“ (offiziell). ⇒ Entscheidung: `provider=nominatim` (serverseitig ohne
  Interaktion), `locale=de`, `limit=5`.
- Credits: default 0,3; gisgraphy 0,3; nominatim/nettoolkit/opencagedata 0,9.
- Reverse-Geocoding (`point=lat,lon&reverse=true`, Koordinate hier lat,lon!) –
  nicht genutzt. Ein README des `geocoder-converter` nennt `/search` –
  Widerspruch zum Client, wir nutzen `/geocode` (Client + OpenAPI).

## Credit-Modell, Pläne und Limits (Pricing, 30.10.2026)
- Free: 500 Credits/Tag, max. 5 Locations, 1 Vehicle; laut Pricing-Fußnote
  non-commercial; ToS §5.1: Free kommerziell in der Entwicklung erlaubt,
  Produktion auf Anfrage.
- Basic 69 €/Monat: 5.000 Credits/Tag, 30 Locations, 2 Vehicles, 1 req/s, 100 Credits/min.
- Standard 199 €/Monat: 15.000/Tag, 80 Locations, 10 Vehicles, 2 req/s, 400 Credits/min.
- Premium 479 €/Monat: 50.000/Tag, 200 Locations, 20 Vehicles, 10 req/s, 1000 Credits/min.
- Unsere Drossel (1 req/s) bleibt unter dem Basic-Plan; Credits je Request
  werden aus `X-RateLimit-Credits` als Zahl geloggt (ohne Request-Inhalte).

## Kommerzielle Nutzung
Produktiver Einsatz nur mit einem bezahlten Plan (Basic oder höher) bzw.
nach Rücksprache mit GraphHopper (ToS §5.1). Es wurde KEIN Account angelegt und
KEIN Live-Aufruf ausgeführt; `pnpm routing:smoke` ist ein manueller Smoke
(ROUTING_SMOKE=1, nie production, nie im Gate).

## Datenschutz, Request-Retention, Unterauftragnehmer
- Privacy §2: Jeder Request (Body, Header, IP, Zeitpunkt) wird beim Provider
  bis zu 5 Wochen gespeichert; ein Proxy wird empfohlen. Hosting bei Hetzner
  (Deutschland) mit Auftragsverarbeitungsvertrag (AVV).
- Unterauftragnehmer Geocoding (Privacy): OpenCageData (provider
  `opencagedata`/`nominatim`), Gisgraphy, NetToolKit; für provider `default`
  ist kein Unterauftragnehmer genannt.
- Datenminimierung (Order §4): An GraphHopper gehen NUR Adresse (+ „,
  Deutschland“ als Suchkontext) bzw. Koordinaten, Zeitfenster, Servicezeiten
  und anonyme Stop-IDs (UUIDs). NIE Kundenname, Telefon, E-Mail, Vorgangsnummer,
  Preis, Schaden, Notizen, Gutschein, Rechnungsdaten. Der Contract-Fake lehnt
  undokumentierte Felder mit 400 ab; Tests prüfen alle Request-Bodies.

## Persistenz- und Caching-Grenzen (ToS §5.2) und unsere Ableitung
- ToS §5.2: Ergebnisse dürfen temporär clientseitig gecacht werden;
  Redistribution/Massendownload nur mit Custom-Vertrag. Eine dauerhafte
  serverseitige Speicherung von Geometrien, Geocoding-Hits oder Matrixwerten
  ist nicht ausdrücklich geregelt.
- Ableitung (konservativ): Provider-Rohantworten werden NIE persistiert
  (keine Geometrien, keine Hit-Listen, keine Matrizen als Archiv). Gespeichert
  werden nur eigene Geschäftsdaten (Reihenfolge, Planungsstatus, Zeiten,
  Zuordnung, Incidents) und minimale skalare Werte (Distanz in Metern, Dauer
  in Sekunden, geplante Zeiten). Geocoding-Koordinaten liegen ausschließlich
  im Cache `geocoding_cache` mit TTL (resolved 90 Tage; review_required/
  no_result 30 Tage), Kandidatenlisten nur für das Staff-Review (≤ 5, mit
  OSM-Referenz). Eine bewusste Staff-Bestätigung (`confirmed_*`) ist eine
  eigene Geschäftsentscheidung und wird nach Ablauf nur dann erneut
  angewendet, wenn der Provider dieselbe OSM-Referenz liefert.

## Attribution
- OpenStreetMap-Daten (ODbL): Link auf `https://www.openstreetmap.org/copyright`
  ist Pflicht und wird in der Staff-UI angezeigt.
- GraphHopper-Attribution ist bei bezahlten Plänen (White-Label) nicht nötig,
  „appreciated“.
- Elevation (Mapterhorn) wäre bei `elevation=true` attributionspflichtig – wir
  nutzen keine Höhendaten.

## Bewusst NICHT genutzte Funktionen
- Asynchrone Route Optimization (`/vrp/optimize` + `/vrp/solution/{job_id}`) –
  wir nutzen nur den synchronen `POST /vrp`.
- Feste Positionen/gepinnte Stopps in der Optimierung – nicht dokumentiert ⇒
  Matrix + lokaler Planer.
- Asynchrone Matrix (`/matrix/calculate`, `/matrix/solution/{jobId}`).
- Isochrone, Map Matching, Elevation (`elevation=false`), Turn-by-Turn-
  Instruktionen (`instructions=false`), Geometrien (`calc_points=false`),
  Alternativrouten, Round-Trips, `optimize=true` im Routing.
- Geocoding provider `default` (Autocomplete), Reverse-Geocoding.
- Header-Auth (nicht dokumentiert), eigene Retries (Queue/Aufrufer entscheiden
  anhand `transient`).

## Konfiguration (packages/config, `RoutingConfig`)
`ROUTING_ENABLED`, `ROUTING_PROVIDER` (graphhopper|mock|disabled),
`GRAPHHOPPER_API_KEY`, `GRAPHHOPPER_BASE_URL`, `ROUTING_REQUEST_TIMEOUT_MS`
(Default 15000). production: nur graphhopper|disabled, Host fest, ohne Key
disabled (Start-Log „Routing nicht konfiguriert“), `mock` ⇒ Konfigurationsfehler.
demo: immer mock; Key, `ROUTING_PROVIDER=graphhopper` oder `GRAPHHOPPER_BASE_URL`
⇒ Konfigurationsfehler. development: Default mock; staging: Default disabled;
echter Provider nur per Opt-in (ENABLED=true + PROVIDER=graphhopper + Key),
Base-URL dort überschreibbar (Contract-Fake). Env-Isolation: derselbe
GraphHopper-Key in zwei Umgebungen ist eine Kollision
(`assertConfigsIsolated`). Der Key existiert nur in `config.routing.graphhopper.apiKey`.
