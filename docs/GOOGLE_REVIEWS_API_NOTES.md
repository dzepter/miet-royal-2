# GOOGLE_REVIEWS_API_NOTES — Google-Bewertungen über die Places API (New)

**Geprüft am:** 06.11.2026, ausschließlich gegen offizielle Google-Quellen
(developers.google.com, cloud.google.com, google.aip.dev über Weiterleitung von
cloud.google.com). Abgerufen als HTML/Text; **kein Aufruf gegen places.googleapis.com** – weder
bei der Recherche noch in Tests (Tests laufen gegen einen lokalen Fake-HTTP-Server).

Viele Doku-Seiten tragen oben einen Kasten „Page Summary“, der laut HTML
`data-tooltip="Generated with AI"` ist. Er ist **nicht normativ** und wird hier nicht als Beleg
verwendet. Zitiert wird nur aus dem Seitentext bzw. den Vertragsbedingungen.

Policies und Terms ändern sich häufig (die Service Specific Terms zuletzt am 28.10.2026).
**Vor Go-live diese Notizen erneut gegen die Quellen prüfen.**

| Kurzname | Quelle | Stand laut Seite |
| --- | --- | --- |
| PD | https://developers.google.com/maps/documentation/places/web-service/place-details | 2026-11-03 |
| POL | https://developers.google.com/maps/documentation/places/web-service/policies | 2026-11-03 |
| REST-Place | https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places | 2026-10-27 |
| REST-get | https://developers.google.com/maps/documentation/places/web-service/reference/rest/v1/places/get | 2026-05-15 |
| FIELDS | https://developers.google.com/maps/documentation/places/web-service/data-fields | 2026-11-03 |
| CHOOSE | https://developers.google.com/maps/documentation/places/web-service/choose-fields | 2026-11-03 |
| BILL | https://developers.google.com/maps/documentation/places/web-service/usage-and-billing | 2026-11-03 |
| PRICE | https://developers.google.com/maps/billing-and-pricing/pricing | 2026-11-03 |
| SKU | https://developers.google.com/maps/billing-and-pricing/sku-details/places | 2026-11-04 |
| COSTS | https://developers.google.com/maps/billing-and-pricing/manage-costs | 2026-11-03 |
| KEY | https://developers.google.com/maps/documentation/places/web-service/get-api-key | 2026-11-03 |
| SEC | https://developers.google.com/maps/api-security-best-practices | 2026-11-03 |
| PID | https://developers.google.com/maps/documentation/places/web-service/place-id | 2026-11-03 |
| FLAG | https://developers.google.com/maps/documentation/places/web-service/content-reporting | 2026-11-03 |
| LINKS | https://developers.google.com/maps/documentation/places/web-service/maps-links | 2026-11-03 |
| MURL | https://developers.google.com/maps/documentation/urls/get-started | 2026-11-03 |
| TOS | https://cloud.google.com/maps-platform/terms | 26.08.2026 |
| SST | https://cloud.google.com/maps-platform/terms/maps-service-terms | 28.10.2026 |
| EEA-TOS | https://cloud.google.com/terms/maps-platform/eea | 26.08.2026 |
| EEA-SST | https://cloud.google.com/terms/maps-platform/eea/maps-service-terms | 28.10.2026 |
| EEA-PU | https://cloud.google.com/terms/maps-platform/eea-places-api-permitted-uses | 04.06.2025 |
| EEA-PL | https://developers.google.com/maps/comms/eea/places | 2026-11-03 |
| EEA-FAQ | https://developers.google.com/maps/comms/eea/faq | 2026-11-03 |
| AIP-193 | https://google.aip.dev/193 (Weiterleitung von https://cloud.google.com/apis/design/errors) | o. A. |

## Kurzfassung

1. **API:** Places API (New), Place Details:
   `GET https://places.googleapis.com/v1/places/{PLACE_ID}?languageCode=de&regionCode=DE`.
   `reviews` liefert **höchstens 5** Bewertungen, **nach Relevanz** sortiert; ein Sortier- oder
   Filterparameter existiert nicht. Die Feldmaske ist Pflicht.
2. **Speichern/Cachen verboten:** Bewertungen dürfen weder gespeichert noch gecacht werden (ToS
   global und EEA, wörtlich unten). Miet-Royal speichert **nichts** (keine DB-Zeile, kein
   In-Memory-, Next-, CDN- oder Proxy-Cache, `Cache-Control: no-store`). Nur die Place ID darf
   dauerhaft gespeichert werden (Config).
3. **Kosten:** Jede Anzeige ist ein bezahlter Abruf der SKU „Place Details Enterprise +
   Atmosphere“ (1.000 frei/Monat, danach 25,00 USD je 1.000). Deshalb **Klick-zum-Laden** und
   eine eigene **globale Tagesgrenze** (`REVIEWS_DAILY_REQUEST_LIMIT`, Default 32).
4. **EWR-Nutzungszweck unklar ⇒ fail-closed:** `REVIEWS_PROVIDER=google` startet nur mit
   `GOOGLE_REVIEWS_TERMS_CONFIRMED=true`. Bis zur Klärung bleibt production auf `disabled`.
5. **Attribution Pflicht:** „Google Maps“, je Bewertung Avatar + Name + Profil-Link, Link zur
   einzelnen Bewertung, Meldelink, Sortier-/Filterhinweis, Übersetzungshinweis. Demo-/Fake-Inhalte
   tragen **nie** „Google“.
6. **Datenschutz:** Der Server sendet Google keine Besucherdaten. Der Browser lädt Avatare von
   Google-Hosts – erst **nach Klick**. Die Datenschutzerklärung muss das vor Go-live nennen.

## 1. Verwendete API

### Endpunkt und Parameter
- PD: *„A Place Details (New) request is an HTTP GET request in the form:
  `https://places.googleapis.com/v1/places/PLACE_ID`“* — REST-get: *„The request body must be
  empty.“*
- Query-Parameter laut REST-get nur `languageCode`, `regionCode`, `sessionToken`. Wir senden immer
  `languageCode=de` (PD: *„If languageCode is not supplied, the API defaults to en.“*) und
  `regionCode=DE` (PD: *„The parameter can affect results based on applicable law.“*). Kein
  `sessionToken` (nur für Autocomplete-Sitzungen).
- Legacy-API und „Find Place“ werden nicht verwendet.

### Feldmaske (Pflicht)
- PD: *„There is no default list of returned fields in the response. If you omit the field mask,
  the method returns an error.“* und *„Spaces are not allowed anywhere in the field list.“*;
  Wildcard `*` nur zur Entwicklung (*„Google discourages the use of the wildcard response field
  mask in production“*).
- **Miet-Royal (Header `X-Goog-FieldMask`):** `id,rating,userRatingCount,googleMapsUri,reviews`
  (Konstante `GOOGLE_REVIEWS_FIELD_MASK`). Bewusst **nicht**: `displayName`, Adress-/Kontaktfelder
  (Datenminimierung; die exakte Abholadresse darf nie auf die Website), `reviewSummary`
  (KI-Zusammenfassung mit Zusatzpflichten), `photos` (eigene SKU + Fotoattribution).
- BILL: *„You are then billed at the highest SKU applicable to your request.“* – `googleMapsUri`
  (Pro) kostet neben `reviews` nichts extra.
- Teilpfade innerhalb von `reviews[]` (z. B. `reviews.text`) sind nicht dokumentiert ⇒ `reviews`
  wird ganz angefordert und serverseitig auf eine Whitelist abgebildet.

### Felder (REST-Place)
| Feld | SKU (FIELDS) | Doku |
| --- | --- | --- |
| `reviews[]` | Place Details Enterprise + Atmosphere | *„List of reviews about this place, sorted by relevance. A maximum of 5 reviews can be returned.“* |
| `rating` | Place Details Enterprise | *„A rating between 1.0 and 5.0, based on user reviews of this place.“* |
| `userRatingCount` | Place Details Enterprise | *„The total number of reviews (with or without text) for this place.“* |
| `googleMapsUri` | Place Details Pro | *„A URL providing more information about this place.“* |

Review-Objekt: `name, relativePublishTimeDescription, text{text,languageCode},
originalText{text,languageCode}, rating, authorAttribution{displayName,uri,photoUri},
publishTime, flagContentUri, googleMapsUri, visitDate`. Ob einzelne Felder fehlen können, ist
**nicht dokumentiert** ⇒ alles optional parsen, unvollständige Bewertungen verwerfen.

## 2. Authentifizierung
- Header **`X-Goog-Api-Key`** (PD/KEY); die Alternative `key=` in der URL wird **nicht** genutzt –
  so steht der Key in keiner URL und keinem Log.
- KEY: *„You must include your API key's alphanumeric string with every request and use HTTPS for
  requests that include the API key.“*
- SEC: *„Server-side applications relying on API keys are best secured through IP address
  restrictions.“* und *„Web service API keys are not expected to be publicly exposed … The keys are
  meant to remain a shared secret between the developer's servers and Google.“*
- KEY: *„You are financially responsible for charges caused by abuse of unrestricted API keys.“* ⇒
  API-Restriction „Places API (New)“ + Application-Restriction auf die Egress-IP(s) der API.
- OAuth wäre möglich (KEY), bringt hier aber nur Aufwand (Service-Account-Schlüssel) ohne Nutzen.

## 3. Attribution und Anzeigepflichten
Rechtsgrundlage: EEA-TOS 3.2.4 (*„Customer will display all attribution and notices … Customer will
not modify, obscure, or delete such attribution.“*), EEA-SST §2 (*„Customer is responsible for
making it clear to the End User what is Google Maps Content and what content is not from
Google.“*), EEA-TOS 3.2.5 (*„Customer will comply with the Documentation“*).

| Pflicht (POL/FLAG) | Beleg | Umsetzung Miet-Royal |
| --- | --- | --- |
| „Google Maps“ (Logo bevorzugt, Text bei wenig Platz) ohne Karte | POL: *„Attribution should take the form of the Google Maps logo whenever possible. In cases where space is limited, the text Google Maps is acceptable.“* | DTO `attribution: 'Google Maps'`; Web zeigt Text „Google Maps“ in `<span translate="no">` ohne Umbruch (`white-space: nowrap`), Systemschrift Sans-Serif, keine Google Fonts – auch in den Links „Alle Bewertungen auf Google Maps“ und „Auf Google Maps ansehen“. Logo-Entscheidung = Go-live-Punkt. |
| Autor: Avatar, Name, Profil-Link | POL: *„You must always credit the author when displaying photos or reviews.“*; *„For reviews, If space is limited, the minimum requirement is to display the author's avatar.“* | Bewertung ohne `displayName`/`uri`/`photoUri` wird verworfen; im DTO für `mode: 'google'` sind `authorUri`, `authorPhotoUri` immer gesetzt. |
| Link zur einzelnen Bewertung | POL: *„end-users must always have access to view the individual source photo or review on Google Maps using the provided googleMapsUri.“* | ohne `googleMapsUri` keine Anzeige; DTO `reviewUri` immer gesetzt. |
| Meldelink | FLAG: *„You must display the content reporting link when you display these objects“* (POL: „recommended“) | fail-safe anzeigen: DTO `flagUri`; ein gelieferter, aber unzulässiger Link verwirft die Bewertung. |
| Sortier-/Filterhinweis | POL: *„Include a clear notice that describes how reviews are being ordered and filtered including any search criteria applied. By default, reviews are ordered by relevance.“* | DTO `sortNote`: Relevanz durch Google, keine Sternefilterung, unvollständige Bewertungen werden nicht angezeigt. |
| Übersetzung kennzeichnen (recommended) | POL: *„Make end users aware when a review has been translated from its original language.“* | `translated` (Sprachcode `text` ≠ `originalText`), `translationNote`, `originalText`. |
| Google-Richtlinie nennen (recommended) | POL: *„Reviews aren't verified by Google, but Google checks for and removes fake content when it's identified. Inform end users of Google's review policy when displaying reviews and average rating.“* | `policyNote` + `policyUri` (https://support.google.com/contributionpolicy/answer/7422880); Web zeigt im Google-Modus den Hinweis mit Link „Zur Richtlinie von Google für Bewertungen“ direkt unter Durchschnittsbewertung und Quelle (fehlen die Felder, lokaler Fallback mit demselben Wortlaut/derselben URL). |
| Keine Fremdinhalte als Google ausgeben | POL: *„Don't misrepresent Google Maps by attributing it with non-Google Maps Platform content.“* | Demo/Fake: `attribution: 'DEMO – synthetische Beispielbewertungen'`, keine Links/Fotos, nie „Google“. |
| Keine Karte daneben | EEA-SST 15.1: *„Other than latitude, longitude, and place_id, Customer must not use Google Maps Content from the Places API With any Map.“* | Kein Maps-Embed (Auftrag), Links auf `googleMapsUri` sind laut EEA-PL erlaubt. |

POL: *„practices labeled as (recommended) in these policies may still be mandated by law.“* ⇒ auch
die recommended-Punkte sind umgesetzt. Texte werden **nicht verändert** (keine Kürzung, keine
eigene Übersetzung, keine KI-Zusammenfassung, keine Auswahl nach Sternen; Grundlage EEA-TOS
3.3.2(c) *„No Creating Content From Google Maps Content“* und EEA-SST §2). `visitDate` ist laut POL
nur für Orte in Frankreich anzuzeigen und wird nicht angefordert.

## 4. Limits und Kosten
- PD: *„reviews and reviewSummary: Return up to five user-submitted Review objects … Requesting
  these fields triggers the Place Details Enterprise + Atmosphere SKU.“*
- SKU „Places API Place Details Enterprise + Atmosphere“ (EB23-5ECC-F753): **1.000 frei/Monat**,
  dann **25,00 USD je 1.000** (bis 100.000), 20,00 / 15,00 / 7,50 / 2,28 in den höheren Stufen
  (PRICE). Abrechnungswährung (USD/EUR) laut Seiten **unklar**.
- Abrechenbar ist laut SKU nur ein *„Successful request for Enterprise + Atmosphere fields“*.
- Eigene Rechnung (keine Google-Angabe): 5.000 Anzeigen/Monat ≈ (5.000 − 1.000) × 0,025 USD =
  100 USD; Klick-zum-Laden senkt das deutlich.
- Quotas (BILL): *„The rate limit per minute is per API method per project.“* – ein konkreter
  QPM-Default ist **nicht beziffert** (Console prüfen).
- COSTS: *„if a SKU has a free usage cap of 1,000 billable events per month, divide 1,000 by 31 to
  get about 32.3. A daily limit of 32 keeps usage at or below 992 in any month.“* und *„daily quotas
  reset at midnight Pacific time“*; *„Because of the technical separation between the quota and
  billing systems, discrepancies may exist“* ⇒ zusätzlich Budget-Alerts.

**Eigene globale Grenze (Code `apps/api/src/reviews/budget.ts`):** Zeile `google_places_reviews`
in `integration_rate_limits` (bestehender `PostgresIntegrationRateLimiter`, geteilt von allen
API-Replikaten einer Umgebung, keine neue Tabelle). Token-Bucket (GCRA): Burst
`max(1, ⌊Limit/4⌋)`, Abstand `⌈24 h / (Limit + 1 − Burst)⌉` ⇒ in **jedem gleitenden
24-Stunden-Fenster höchstens `REVIEWS_DAILY_REQUEST_LIMIT` Abrufe** (Default 32: 8 sofort, danach
etwa einer je 58 Minuten). Erschöpft ⇒ globale Pause bis zum nächsten freien Slot (503 neutral,
kein Google-Abruf). Google-429 ⇒ globale Pause 10 Minuten. Keine Wiederholung im Request-Pfad.

## 5. Speicherung und Caching (wörtlich)
**TOS 3.2.3** (https://cloud.google.com/maps-platform/terms):
> (a) No Scraping. Customer will not export, extract, or otherwise scrape Google Maps Content for
> use outside the Services. For example, Customer will not: (i) pre-fetch, index, store, reshare,
> or rehost Google Maps Content outside the services; … (iii) copy and save business names,
> addresses, or user reviews; …
> (b) No Caching. Customer will not cache Google Maps Content except as expressly permitted under
> the Maps Service Specific Terms.

**EEA-TOS 3.3.2** (https://cloud.google.com/terms/maps-platform/eea):
> (a) No Scraping. … Customer will not: (i) pre-fetch, index, store, reshare, or rehost Google Maps
> Content outside of the Services; (ii) bulk download Google Maps Content; or (iii) copy and save
> business names, addresses, or user reviews.
> (b) No Caching. Customer will not cache Google Maps Content except as expressly permitted under
> the Maps Service Specific Terms.

Ausnahmen (SST/EEA-SST): §3 *„Customer may cache the Google ID values from the Services that
return such field and allow caching, in accordance with its Documentation“* (z. B. `place_id`);
lat/lng bis 30 Tage (EEA-SST 15.4). POL: *„the place ID, used to uniquely identify a place, is
exempt from the caching restrictions. You can therefore store place ID values indefinitely.“*

| Frage | Entscheidung | Grundlage |
| --- | --- | --- |
| Review-Texte/Autor/Rating in der DB? | **Nein** | TOS 3.2.3(a)(iii), EEA-TOS 3.3.2(a)(iii), (b) |
| Kurzlebiger In-Memory-Cache? | **Nein** (nicht ausdrücklich erlaubt ⇒ fail-closed) | (b) *„except as expressly permitted“* |
| Next.js Data-Cache/ISR/CDN/Proxy-Cache? | **Nein**, `Cache-Control: no-store` | wie oben |
| In-flight-Bündelung gleichzeitiger Abrufe? | **Nein** (nicht geregelt ⇒ aus) | – |
| Avatare serverseitig proxyen? | **Nein** (*„reshare, or rehost“*) | EEA-TOS 3.3.2(a)(i) |
| Place ID dauerhaft in der Config? | **Ja**, alle 12 Monate auffrischen (PID, kostenlos mit Feldmaske `id`) | SST §3, POL, PID |
| Demo-/Fake-Bewertungen im Code? | Ja – keine Google-Inhalte, immer „DEMO“, nie „Google“ | POL „Don't misrepresent …“ |

Die Tabelle `integration_rate_limits` enthält nur Provider, Umgebung und Zeitpunkte – keine
Inhalte, keinen Key, keine URL.

## 6. EWR-Nutzungszweck (fail-closed)
- Bei einer Billing-Adresse im EWR gelten EEA-TOS, EEA-SST und die **Places API EEA Permitted
  Uses** (EEA-PU). Laut EEA-FAQ ist ein nach dem 08.07.2025 angelegtes Projekt nie im „unmodified
  state“.
- Am ehesten passend ist EEA-PU Nr. (2): *„display information about Customer’s physical stores,
  offices, or official service points“*. Ob die eigenen Bewertungen eines Vermietbetriebs **ohne
  öffentliche Ladenadresse** darunter fallen, ist **unklar**.
- **Festlegung:** Ohne Klärung kein Google-Provider. `REVIEWS_PROVIDER=google` startet nur mit
  `GOOGLE_REVIEWS_TERMS_CONFIRMED=true` (kein Default, keine juristische Automatik; Bedeutung:
  „EWR-Nutzungszweck, Attribution, Datenschutzerklärung und Kostenschutz sind geprüft“). Bis dahin
  `REVIEWS_PROVIDER=disabled` in production ⇒ die Website zeigt keine Bewertungs-Sektion.

## 7. Datenschutz
- **Server → Google:** Key (Header), Place ID (Pfad), Feldmaske, `languageCode=de`,
  `regionCode=DE` – **keine** Besucher-IP, kein User-Agent, kein Cookie, kein `X-Forwarded-For`.
  EEA-TOS 4.2: *„Customer will not provide to Google (a) any End User’s personally identifiable
  information; or (b) any End User’s Personal Data.“* EEA-TOS 4.5 verweist auf die
  Controller-Controller Data Protection Terms (https://business.safety.google/controllerterms/).
- **Browser → Google:** Avatare (`authorAttribution.photoUri`, in den Beispielen
  `lh3.googleusercontent.com`) werden beim Anzeigen direkt von Google geladen (Besucher-IP). Den
  Avatar wegzulassen verletzt die Attribution, ein Proxy wäre „rehost“. Daher **Klick-zum-Laden**:
  Die Seite zeigt zuerst nur den Knopf „Bewertungen anzeigen“ mit dem Hinweis „Beim Laden werden
  Bewertungen und Profilbilder von Google abgerufen.“; erst der Klick ruft `/api/public/reviews`
  und lädt die Avatare (`referrerPolicy="no-referrer"`). Links (`authorUri`, `reviewUri`,
  `flagUri`, `placeUri`) erzeugen erst beim Anklicken einen Request (`rel="noopener noreferrer"`).
  Kein Google-JavaScript, kein Widget, kein Cookie-Banner nötig.
- **Host-Allowlist (serverseitig):** jede URI muss `https:` sein und auf
  `*.googleusercontent.com`, `www.google.com`, `maps.google.com` oder `google.com` liegen, sonst
  wird die Bewertung verworfen. Die Liste ist aus den Doku-Beispielen abgeleitet (FLAG: *„The
  example URLs shown in the responses below are placeholders.“*) – **nicht verbindlich
  dokumentiert** ⇒ im Staging-Smoke-Test prüfen.
- Datenschutzerklärung vor Go-live ergänzen (Abruf über den Server, Avatare/Links von Google nach
  Klick, Google-Datenschutzerklärung).

## 8. Umsetzung in Miet-Royal (Phase 16)
- **Config** (`packages/config`, `.env.example`): `REVIEWS_PROVIDER` = `disabled` (Default) |
  `fake` | `google`; `GOOGLE_PLACES_API_KEY` (Secret, nur API-Prozess); `GOOGLE_PLACE_ID`;
  `GOOGLE_REVIEWS_TERMS_CONFIRMED`; `REVIEWS_DAILY_REQUEST_LIMIT` (Default 32, 1–100.000). Regeln:
  `fake` nur demo/development (staging/production ⇒ Startfehler); demo ⇒ `google` und ein gesetzter
  Key sind Startfehler; `google` ohne Key/Place ID/Bestätigung ⇒ Startfehler. Leere Werte gelten
  als nicht gesetzt. `pnpm check:env-isolation` meldet denselben Places-Key in zwei Umgebungen.
- **Grenze** (`apps/api/src/reviews/`): `ReviewGateway` mit `DisabledReviewGateway`,
  `FakeReviewGateway` (Modus `demo`, synthetische deutsche Texte „DEMO-Beispieltext …“, keine
  Fotos/Links/Kennzahlen) und `GoogleReviewGateway` (Host fest `https://places.googleapis.com`,
  Timeout 3 s inkl. Body, Antwort ≤ 1 MiB, `redirect: 'error'`, keine Wiederholung, kein Cache,
  nichts in der DB). Fabrik `createReviewGateway`; Laufzeitsperre `assertReviewGatewayAllowed`
  (production/staging nie Fake, demo nie Google – auch für injizierte Gateways).
- **Route** `GET /public/reviews` (Web ruft sie same-origin über `/api/public/reviews`):
  disabled ⇒ 404 `REVIEWS_DISABLED`; Fehler/Timeout/Grenze/429 ⇒ 503 `REVIEWS_UNAVAILABLE`
  („Bewertungen sind gerade nicht verfügbar.“); `Sec-Fetch-Site: cross-site|same-site` ⇒ 403
  `CSRF_REJECTED`; 10/min je IP; nur GET – keine automatische HEAD-Route (`exposeHeadRoute:
  false`, HEAD ⇒ 404 ohne Provider-Abruf); `Cache-Control: no-store`; keine CORS-Header. DTO:
  `{ mode, rating, total, placeUri, attribution, sortNote, translationNote, policyNote, policyUri,
  reviews: [{ authorName, authorUri, authorPhotoUri, rating, text, translated, originalText,
  relativeTime, publishTime, reviewUri, flagUri }] }`.
- **Logs:** nur `{ reviews: { provider, outcome, reason, httpStatus, durationMs, reviewCount } }`;
  nie Key, URL, Antwortkörper (ein 403 von Google kann die Server-IP nennen), Review-Text oder
  Autorenname. Pino-Redaction `REVIEWS_LOG_REDACT_PATHS` (u. a. `config.reviews.google.apiKey`,
  `GOOGLE_PLACES_API_KEY`, `headers["x-goog-api-key"]`).
- **Ausfall:** Die Bewertungs-Sektion fällt aus, der Rest der Website bleibt verfügbar (Abruf nur
  im Browser nach Klick, nie beim Server-Rendering).
- **Tests:** `packages/config/test/reviews-config.test.ts`, `apps/api/test/reviews-*.test.ts`
  (Unit, lokaler Fake-HTTP-Server `apps/api/src/reviews/testing/fake-places-server.ts`) und
  `apps/api/test/reviews-*.integration.test.ts` (Route, globale Grenze, kein DB-Inhalt, Key nie im
  Log). Kein Test ruft Google auf.

## 9. Fehlerbilder (AIP-193, PD, PID)
- Form: `{"error":{"code":<HTTP>,"message":…,"status":"<google.rpc.Code>","details":[…]}}`.
- 400 `INVALID_ARGUMENT` (Feldmaske fehlt, ungültiger `languageCode`), 403 `PERMISSION_DENIED`
  (Key/Restriction/API nicht aktiv/Billing – Einzelursachen nicht dokumentiert), 404 `NOT_FOUND`
  (PID: *„indicates that the specified place ID is obsolete“*), 429 `RESOURCE_EXHAUSTED`, 5xx
  transient. Timeouts dokumentiert Google nicht – eigene Festlegung 3.000 ms, 0 Retries.
- Im Code: `reason` ∈ `invalid_argument | auth_invalid | permission_denied | not_found |
  rate_limited | server_error | unexpected_status | timeout | network | invalid_response |
  budget_exhausted` – nur im Log, nach außen immer neutral 503.

## 10. Betrieb
- Monitoring/Alerts auf Log-`reason` `permission_denied`, `not_found` (Konfigurationsfehler) und
  `budget_exhausted` (Grenze erreicht).
- Key-Rotation über die Cloud Console („Rotate key“, SEC); neuer Key ⇒ Env-Variable tauschen,
  API neu starten.
- Place ID jährlich auffrischen (PID: *„Google recommends refreshing place IDs if they are more than
  12 months old.“*; kostenlos mit Feldmaske `id`, SKU „Essentials IDs Only“).
- Nie Reverse-Proxy-/CDN-Caching für `/api/public/reviews` einrichten.

## Go-live
1. Vertragsregime klären (Billing-Adresse EWR ⇒ EEA-TOS/EEA-SST/EEA-PU; EEA-ToS in der Console
   akzeptieren).
2. Permitted Use bestätigen (EEA-PU Nr. (2) für ein Profil ohne öffentliche Adresse?) – über den
   Google-Maps-Platform-Support oder rechtlich. **Bis dahin `REVIEWS_PROVIDER=disabled`.**
3. Google-Cloud-Projekt mit Billing; nur „Places API (New)“ (`places.googleapis.com`) aktivieren.
4. API-Key je Umgebung: API-Restriction Places API (New), Application-Restriction IP (öffentliche
   Egress-IP der Production-API). Demo und Test bekommen keinen Key.
5. Place ID per Place ID Finder ermitteln, in Google Maps gegenprüfen, `GOOGLE_PLACE_ID` setzen.
6. Kostenschutz: Tages-Quota in der Console (z. B. 32/Tag), Billing-Budget mit Alerts, eigene
   Grenze `REVIEWS_DAILY_REQUEST_LIMIT`; QPM-Default in der Console prüfen.
7. Datenschutzerklärung ergänzen (Abschnitt 7) und rechtlich prüfen.
8. Rechtstexte der Website (EEA-TOS 3.2.2): Hinweis auf Google-Maps-Inhalte, Google Maps End User
   Additional Terms (https://maps.google.com/help/terms_maps/) und Google Privacy Policy
   (https://policies.google.com/privacy); klären, wo das hingehört.
9. Attribution-Abnahme gegen POL (Logo oder Text „Google Maps“; Avatar/Name/Profil-Link; Link zur
   Bewertung; Meldelink; relatives Datum; Sortier-, Übersetzungs- und Richtlinienhinweis; klare
   visuelle Abgrenzung; keine Karte in der Nähe). Logo (offizielle Assets, lokal ausgeliefert)
   ist bevorzugt – Entscheidung offen.
10. Entscheidung DSB/Inhaber: Klick-zum-Laden (umgesetzt) bestätigen; Alternative wäre nur ein
    Maps-URL-Link ohne API (MURL: *„You don't need a Google API key to use Maps URLs.“*).
11. Prüfen, dass kein Reverse-Proxy/CDN/Next `/api/public/reviews` oder HTML mit Bewertungen
    cacht.
12. Einmaliger Smoke-Test in **staging** mit echtem Key (außerhalb des Phase-16-Gates):
    Feldmaske, `languageCode=de`, Fehler-Mapping (falscher Key/Place ID), tatsächliche Avatar- und
    Link-Hosts (Allowlist, spätere CSP `img-src`).
13. Erst danach `GOOGLE_REVIEWS_TERMS_CONFIRMED=true` + `REVIEWS_PROVIDER=google` in production.
14. Diese Notizen vor Go-live erneut gegen die Quellen prüfen.

## Offene bzw. unklare Punkte (nicht geraten)
- EEA-PU (2) für einen Betrieb ohne öffentliche Ladenadresse: **unklar** (Go-live 2).
- Kurzlebiger Cache/In-flight-Dedupe: **nicht ausdrücklich erlaubt** ⇒ aus.
- Kürzen von Bewertungen: **nicht geregelt** ⇒ voller Text.
- QPM-Default und Name der Tages-Quota: **nicht beziffert**.
- Verbindliche Host-Liste für `photoUri`/Links: **nicht dokumentiert** (nur Beispiele).
- Ob `text` oder `photoUri` fehlen können: **nicht dokumentiert** ⇒ optional parsen,
  unvollständige Bewertungen verwerfen (ohne Text: Anzeige nur mit Sternen).
- Abrechnungswährung: **unklar**.
- Meldelink „must“ (FLAG) vs. „recommended“ (POL): **fail-safe angezeigt**.
