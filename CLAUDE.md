# CLAUDE.md — Verbindliche Regeln für Claude Code

## Projektcharakter
Miet-Royal 2.0 ist ein produktives Vermietungssystem mit Kunden-, Vertrags-,
Maschinen-, Lager-, Kommunikations-, Signatur- und Abrechnungsdaten.
Geschäftslogik darf niemals stillschweigend verändert oder neu interpretiert werden.

## Vor jeder Änderung
1. `CLAUDE.md` lesen.
2. `docs/MASTER_SPEC.md` lesen.
3. relevante Abschnitte aus `DOMAIN_RULES.md`, `DATA_MODEL.md`,
   `PERMISSIONS.md`, `UX_RULES.md`, `INTEGRATIONS.md` lesen.
4. vorhandenen Code und Tests des Fachbereichs prüfen.
5. erst dann implementieren.

## Keine Fachregeln erfinden
Technische Details darfst du innerhalb der Architektur entscheiden.
Bei einer nicht definierten Geschäftsentscheidung: stoppen und konkrete Lücke nennen.
Keine willkürliche Defaultregel in Produktivcode.

## Eine autoritative Implementierung je Regel
Keine Preis-, Storno-, Gutschein-, Verfügbarkeits-, Rückgabe- oder
Abrechnungsregel parallel in Website, Staff-App, PDF und API duplizieren.
Frontend zeigt Ergebnisse der zentralen Domain-/Serverlogik.

## Änderungssicherheit
- keine ungefragten Komplett-Rewrites
- kleine Anforderung = kleine kontrollierbare Änderung
- größere Refactorings separat planen
- keine Dateien wie `final2`, `newFixed`, `helpers2`

## TypeScript / Validierung
- strict TypeScript
- kein routinemäßiges `any`
- alle externen Eingaben serverseitig validieren
- Frontendvalidierung ist UX, nicht Sicherheit

## Berechtigungen
Jede kritische Aktion serverseitig prüfen.
Ein ausgeblendeter/deaktivierter Button ist kein Berechtigungsschutz.

## Geld
Geld als Integer-Cent oder exakte Decimal-Werte, niemals fachlich mit
binären Floating-Point-Zahlen rechnen.

## Datum/Zeit
Zeitpunkte eindeutig speichern, Anzeige `Europe/Berlin`.
Fristen und Tagesgrenzen zentral implementieren und testen.

## Datenbank
- PostgreSQL
- jede Schemaänderung als versionierte Migration
- kritische Mehrfachaktionen transaktional
- keine manuellen nicht reproduzierbaren Produktivänderungen

## Historische Unveränderbarkeit
Nicht rückwirkend überschreiben:
- versendete Angebotsversionen
- bestätigte Preis-/Kundensnapshots
- unterschriebene Protokoll-PDFs
- an Lexware übertragene Abrechnungen

## Live / Demo / Staging
Strikte technische Trennung:
- getrennte Datenbanken
- getrennte Secrets
- getrennte Storage-Konfiguration
- Demo niemals mit Live referenzieren
- Demo niemals echte Lexware-Aktion
- Demo-WhatsApp nur Simulation
- Demo-Mail nur Whitelist + `[DEMO]`

## Integrationen / Jobs
E-Mail, Lexware, Kalender, Push, Fristen und Gutscheinversand als robuste,
idempotente, retry-fähige Hintergrundjobs, wo sinnvoll.
Provider hinter Interfaces kapseln.

## Secrets
Keine API-Keys, DB-Passwörter, Tokens oder SMTP-Secrets im Repository
oder Browsercode.

## UX
- eine klare Hauptaktion pro Bildschirm bevorzugen
- seltene Aktionen unter „Mehr“
- keine unnötigen Pflichtfelder
- keine technischen Statuscodes anzeigen
- keine zusätzlichen Dashboard-Karten ohne echten Nutzen
- mobile, Tablet und Desktop direkt berücksichtigen
- Warnungen nur bei echtem Handlungsbedarf
- Status nie ausschließlich über Farbe

## Dependencies
Neue Library nur bei echtem Nutzen.
Keine spontanen Framework-/ORM-Wechsel.
Keine Major-Upgrades „nebenbei“.

## Tests
Fachänderung ist nicht fertig ohne sinnvolle Tests:
- Unit: Geschäftslogik
- Integration: API + DB + Rechte
- E2E: kritische Gesamtprozesse

Nur tatsächlich ausgeführte Tests als bestanden melden.

## Schutz vor Doppelaktionen
Kritische Aktionen UI-seitig sperren und serverseitig idempotent ausführen:
Angebot annehmen, Rückgabe abschließen, Storno, Lexware, Dokument finalisieren.

## Gleichzeitiges Arbeiten / Offline
Kritische konkurrierende Änderungen niemals still überschreiben.
Offline-Konflikte explizit auflösen lassen.

## Deployment
Claude Code deployt nicht eigenmächtig auf Produktion.
Ablauf: implementieren → testen → Staging → Abnahme → Backup →
kontrolliertes Deployment → Smoke Test → ggf. Rollback.

## Nach jeder Aufgabe berichten
### Geändert
### Migrationen
### Tests tatsächlich ausgeführt
### Nicht getestet
### Offen / bewusst nicht Teil der Aufgabe
### Risiken / Beobachtungen

## Quellenreihenfolge bei Widerspruch
1. MASTER_SPEC
2. DOMAIN_RULES
3. DATA_MODEL
4. PERMISSIONS
5. UX_RULES
6. INTEGRATIONS
7. ARCHITECTURE
8. Code

Widersprüche melden, nicht still „lösen“.
