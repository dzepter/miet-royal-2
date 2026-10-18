# LEXWARE_API_NOTES — Lexware Office Public API (Stand der Verifikation)

**Verifiziert am:** 17.10.2026 gegen die offiziellen Quellen
https://developers.lexware.io/docs/ (API Documentation),
https://developers.lexware.io/cookbooks/public-api/ und
https://developers.lexware.io/cookbooks/invoices/ (Kochbücher) sowie
https://developers.lexware.io/webhookSignature/public/public_key.pub.
Keine Blogs, keine Wrapper-Bibliotheken. Lexware ist eine veränderliche
API – vor jedem Release erneut gegen die Doku prüfen (Changelog `#change-log`).

## Grundlagen
- Production-Gateway: `https://api.lexware.io` („new API Gateway URL for our
  production system“). Die alte Gateway-URL war nur „until December 2025“
  erreichbar und wird nirgends im Code verwendet.
- Header: `Authorization: Bearer <API-Key>`, `Accept: application/json`,
  bei POST/PUT `Content-Type: application/json` (fehlend ⇒ 415).
- API-Key: Erzeugung unter app.lexware.de → Add-ons → Public API;
  „Die Lebensdauer des API Keys beträgt 24 Monate“ (Kochbuch); Erneuerung in
  der Key-Verwaltung; kein API-Endpunkt liefert das Ablaufdatum ⇒ Miet-Royal
  kennt es nur über ein administrativ gesetztes Erinnerungsdatum
  (`LEXWARE_API_KEY_REMINDER_DATE`, optional). Rotation siehe
  DEPLOYMENT_NOTES.
- Berechtigungen: „Optional können die Berechtigungen des Keys für den
  Zugriff auf Lexware eingeschränkt werden“ (Kochbuch). Die exakten
  Bezeichnungen der granularen Rechte stehen NICHT in der öffentlichen Doku
  (nur in der Key-Verwaltung der App). Benötigte Zugriffsbereiche nach den
  tatsächlich verwendeten Endpunkten: Profil lesen; Kontakte lesen und
  schreiben; Rechnungen lesen und schreiben; Zahlungen (Payments) lesen;
  Belegliste (Voucherlist) lesen; Rechnungsdatei lesen; Event-Subscriptions
  lesen, anlegen und löschen. Least Privilege: alles andere nicht freigeben.
  403 bedeutet laut Doku „insufficient scope or insufficient access rights“
  ⇒ Konfigurationsfehler, kein Retry.
- Vertrag: Die Doku nennt Business Features `INVOICING`, `INVOICING_PRO`,
  `BOOKKEEPING` „based on the chosen Lexware contract“; eine XL-Pflicht steht
  nicht wörtlich in der Doku (Kochbuch: Testaccounts „bieten alle Funktionen
  der Version Lexware XL“). Miet-Royal verlangt im Profil `INVOICING`.
- Rate Limit: „A client can make up to 2 requests per second“ (Token Bucket,
  gilt für alle Endpunkte zusammen); Überschreitung ⇒ 429 (ein
  `Retry-After`-Header ist nicht dokumentiert – wird genutzt, falls vorhanden,
  sonst exponentielles Backoff). Hinweis der Doku: 500 kann „Internal server
  error or rate limit exceeded“ bedeuten. Gateway-Timeout 504 nach 30 s –
  „die Anfrage kann trotzdem verarbeitet worden sein“ (⇒ Unknown-Outcome).
- Fehlerformate: Legacy `{"IssueList":[…]}` (contacts, files, vouchers) und
  regulär `{timestamp,status,error,path,traceId,message,details[{violation,field,message}]}`.
  `message` ist „not suitable for presenting it to your applications
  end-users“ ⇒ Miet-Royal zeigt nur neutrale, eigene Texte.
- Optimistic Locking: PUT verlangt `version`; POST mit `version: 0`;
  Konflikt ⇒ 409. Paging: 0-basiert, Default 25, max 250 (contacts,
  voucherlist), technisches Limit 10 000 Einträge.
- Testaccounts: „kostenfrei und 30 Tage gültig“, keine separate
  Sandbox-Domain. „Polling von Ressourcen ist unbedingt zu vermeiden“;
  Last-/Performance-Tests sind „nicht erlaubt“.

## Tatsächlich verwendete Endpunkte
| Zweck | Endpunkt |
| --- | --- |
| Verbindung/Profil | `GET /v1/profile` → organizationId, companyName, connectionId, taxType (net/gross/vatfree), smallBusiness, businessFeatures, distanceSalesPrinciple; `subscriptionStatus`/`features` nur im Beispiel, undokumentiert |
| Kontakt suchen | `GET /v1/contacts?email=…&name=…&customer=true&page=&size=` (Teilstring, case-insensitive, min. 3 Zeichen) |
| Kontakt lesen/anlegen/ändern | `GET /v1/contacts/{id}`, `POST /v1/contacts` (version 0, `roles.customer: {}`, genau eines von `person`/`company`, `addresses.billing[0].countryCode` Pflicht, max. eine Adresse/E-Mail/Telefon je Typ), `PUT /v1/contacts/{id}` (mit aktueller `version`) |
| Rechnung final anlegen | `POST /v1/invoices?finalize=true` (ohne Parameter entsteht ein Draft) |
| Rechnung lesen | `GET /v1/invoices/{id}` → voucherStatus draft/open/paid/voided, voucherNumber, dueDate (read-only), totalPrice, taxAmounts |
| Rechnungsdatei | `GET /v1/invoices/{id}/file` mit `Accept: */*` (PDF; draft ⇒ 409) – nur Streaming, keine Persistenz |
| Zahlungsstatus | `GET /v1/payments/{voucherId}` → openAmount, paymentStatus (balanced/openRevenue/openExpense), voucherStatus (open/paid/paidoff/voided/transferred/sepadebit), paidDate, paymentItems |
| Belegliste (Recovery/Reconciliation) | `GET /v1/voucherlist?voucherType=invoice&voucherStatus=open,paid,voided,overdue&contactId=&voucherDateFrom=&voucherDateTo=&createdDateFrom=&createdDateTo=&size=250` (voucherStatus `overdue` ist transient: open/sepadebit mit dueDate in der Vergangenheit; nicht mit anderen Status kombinierbar) |
| Event-Subscriptions | `GET /v1/event-subscriptions`, `POST /v1/event-subscriptions {eventType, callbackUrl}` (Duplikat ⇒ 409; nicht erreichbare/unsichere Callback-URL ⇒ 406, Lexware sendet vorher HEAD), `DELETE /v1/event-subscriptions/{id}` (nur eigene, nie fremde) |

## Rechnungs-Payload (genutzte Felder)
`voucherDate` (`yyyy-MM-ddTHH:mm:ss.SSSXXX`), `address` (`contactId` + Name/
Straße/PLZ/Ort/`countryCode` aus dem eingefrorenen Snapshot – „the referenced
address can also be modified for this specific invoice“, der Kontaktstamm
bleibt unverändert), `lineItems[]` vom Typ `custom` (name, description,
quantity, unitName, `unitPrice{currency:'EUR', netAmount, taxRatePercentage}`;
max. 300), `totalPrice{currency:'EUR'}`, `taxConditions{taxType}` (net/gross/
vatfree …), `paymentConditions` (optional; sonst Org-/Kontakt-Default),
`shippingConditions{shippingType:'service'|'serviceperiod', shippingDate[, shippingEndDate]}`,
`title`, `introduction`, `remark`. Read-only (nie senden): id, version,
voucherStatus, voucherNumber, dueDate, taxAmounts, closingInvoice,
claimedGrossAmount, downPaymentDeductions, files.
- Negative Positionen: „Negative Werte in Belegpositionen sind möglich“
  (Kochbuch); Gesamtbetrag nicht negativ. Miet-Royal nutzt das NUR für den
  akzeptierten Maschinenmiet-Rabatt (eigene Position mit derselben
  Steuerklassifikation wie die Miete) – nicht für Anzahlung/Kaution.
- Steuersätze: Articles-Sektion „As of March 2024, possible values are 0, 7,
  and 19“; Kochbuch nennt historisch 0/5/7/16/19; die FAQ „Valid Tax Rates“
  koppelt Gültigkeit an Stichtag/shippingType. Miet-Royal hardcodiert KEINEN
  Satz: Steuersätze kommen ausschließlich aus der expliziten
  Steuerkonfiguration (production ohne vollständige Konfiguration ⇒ Hard
  Block).
- Kleinunternehmer/steuerfrei: `taxType: 'vatfree'` mit `taxRatePercentage 0`
  nur, wenn der Lexware-Account entsprechend eingerichtet ist (Profil
  `smallBusiness`/`taxType`) – Plausibilitätsprüfung vor dem Transfer.
- Sprache: Kochbuch „Per REST API können nur Rechnungen mit deutschem
  Sprachkennzeichen angelegt werden“ ⇒ `language` wird nicht gesendet.

## Webhooks / Event-Subscriptions
- Body: `{organizationId, eventType, resourceId, eventDate}`; keine Event-ID
  ⇒ Deduplizierung über SHA-256(organizationId|eventType|resourceId|eventDate).
- Genutzte Eventtypen: `invoice.status.changed`, `invoice.changed`,
  `invoice.deleted`, `payment.changed`. NICHT genutzt: `token.revoked` – die
  Doku beschreibt es als Ereignis für einen widerrufenen (OAuth-)Refresh-Token;
  Miet-Royal authentifiziert sich mit einem Public-API-Key und nutzt keinen
  Refresh-Token. Die Gesundheit des API-Keys ergibt sich aus Profilprüfung,
  401/403 und der expliziten Verbindungsprüfung. Eine früher selbst angelegte
  `token.revoked`-Subscription wird von `pnpm lexware:setup` entfernt (nur die
  eigene gespeicherte ID). Nach Key-Erneuerung: „subscriptions should be
  recreated“ (`pnpm lexware:setup`).
- Signatur: Header `X-Lxo-Signature` = Base64 einer RSA-SHA512-Signatur „of
  the JSON request body (without whitespaces and linebreaks)“. Öffentlicher
  Schlüssel (PEM, RSA-4096, kein Secret) aus
  https://developers.lexware.io/webhookSignature/public/public_key.pub,
  abgerufen am 17.10.2026 und in `apps/api/src/lexware/webhook-public-key.ts`
  hinterlegt (überschreibbar über `LEXWARE_WEBHOOK_PUBLIC_KEY_PEM`, z. B. für
  den Contract-Fake). Verifikation gegen die Rohbytes des Requests; da die
  Doku „ohne Whitespaces“ nennt, wird zusätzlich die kompakt serialisierte
  Form geprüft – niemals eine eigene Neuserialisierung als einzige Grundlage.
- Zustellung: Antwort muss 2xx sein, Read-Timeout 5 s ⇒ Endpunkt nur
  verifizieren, deduplizieren, Job einreihen. Retry von Lexware bei
  401/403/429/5xx; 404 ⇒ Subscription wird gelöscht; 410 ⇒ sofort entfernt.
- Callback-URL: HTTPS mit einwandfreiem Zertifikat („Grade A und besser“),
  öffentlich erreichbar, Deployment-Konfiguration (`LEXWARE_WEBHOOK_CALLBACK_URL`).

## Deeplinks
Nur die dokumentierte Struktur `{appbaseurl}/permalink/invoices/view/{id}`
(und `…/contacts/view/{id}`); `{appbaseurl}` ist in der Doku nicht als Wert
benannt – Miet-Royal verwendet `https://app.lexware.de` (die App-URL, auf die
die Doku an anderer Stelle verlinkt). Kein API-Key in URLs.

## Unterstützte Funktionen (Phase 10)
Profilprüfung, Kontakt-Zuordnung/-Anlage/-Aktualisierung, finale Rechnung
(Abrechnung und Stornokosten), Rechnungs-ID/-Nummer/Status, Zahlungsstatus
(open/paid/overdue), Webhooks mit Signaturprüfung, Event-Subscriptions,
Unknown-Outcome-Recovery über die Belegliste, Reconciliation, Deeplink,
optionales serverseitiges Streaming der Rechnungsdatei.

## Bewusst NICHT unterstützt
- Rechnungsversand per E-Mail: die Public API hat KEINEN Endpunkt dafür (nur
  wiederkehrende Rechnungen werden von Lexware automatisch gemailt). Status
  bleibt „Versand ausstehend“ (Phase 12).
- Anzahlungen/Abschlagsrechnungen und Schlussrechnungen: Down Payment
  Invoices sind „read-only … cannot be created or modified by means of the
  API“; Closing Invoices „read only“. Kautionen kennt Lexware nicht als
  Rechnungsart ⇒ Settlements mit `advance_payment_credit`/
  `deposit_applied_credit` werden fail-closed blockiert.
- Mahnwesen (Dunnings), Gutschriften, Artikelstamm, Bookkeeping-Belege,
  Dateiupload, Kunden-Storno.

## Bekannte Einschränkungen / Widersprüche der Doku
- Kein `Retry-After` dokumentiert; 500 kann ein Rate-Limit sein.
- Kochbuch vs. Doku: Retry-Strategie der Webhooks (48 h vs. zweiphasig
  5 + 20 Versuche), Steuersatzliste, Sprache, Down-Payment-Lesezugriff.
- `paidDate`/`openAmount` liegen nur im Payments-Endpunkt; `overdue` nur in
  der Voucherlist (transient) ⇒ Miet-Royal leitet „überfällig“ aus
  voucherStatus `open` + `dueDate < heute (Europe/Berlin)` ab.
- Keine Sandbox-Domain; Live-Smoke nur mit bewusst eingerichtetem Testaccount.
- Die Rundung der Steuerbeträge (je Position oder je Steuersatz-Gruppe) ist
  nicht dokumentiert. Miet-Royal erwartet Steuer je Steuersatz-Gruppe auf die
  Nettosumme (kaufmännisch gerundet) und prüft die Lexware-Summe nach dem
  Create; eine Abweichung führt zu „Buchhaltungsprüfung erforderlich“
  (TOTAL_MISMATCH) – nie zu einer stillen Cent-Anpassung. Am Live-Testaccount
  zu verifizieren (Phase-10-Risiko).
