# ARCHITECTURE — Technische Zielarchitektur

## Baseline
Bei Projektstart aktuelle stabile Produktionsversionen auswählen und pinnen.

Empfohlen:
- pnpm Workspace / Monorepo
- Next.js + React + TypeScript für Web
- Next.js/React PWA für Staff
- TypeScript API-Service
- PostgreSQL
- etabliertes TS-ORM, in Phase 0 auswählen und danach nicht spontan wechseln
- Zod oder gleichwertig
- Vitest + Playwright oder gleichwertig
- privater S3-kompatibler Object Storage
- PostgreSQL-basierte Jobqueue als schlanker Start
- Docker/Compose, wenn Deploymentziel passt

## Struktur
```text
miet-royal/
├── apps/
│   ├── web/
│   ├── staff/
│   ├── api/
│   └── worker/
├── packages/
│   ├── database/
│   ├── domain/
│   ├── permissions/
│   ├── documents/
│   ├── integrations/
│   ├── ui/
│   ├── validation/
│   └── config/
├── docs/
├── migrations/
├── tests/
└── CLAUDE.md
```

## Fachmodule
customers, processes, inquiries, offers, bookings, scheduling, machines,
inventory, handover, returns, damages, settlements, cancellations, vouchers,
communications, documents, employees, permissions, training, cms, integrations.

## Umgebungen
Production, Demo, Staging jeweils technisch getrennt.
Demo nicht nur `is_demo=true`, sondern eigene DB/Secrets/Storage-Konfiguration.

## Hosting
Provider-neutral bauen.
Geplante Option: professioneller Linux VPS/Cloud-Server.
STRATO ist möglich, wenn passender VPS/Server die Anforderungen erfüllt.
Bestehendes simples Webhosting nicht als App-Backend voraussetzen.

## Domains
Vorschlag:
- www.miet-royal.de → Website
- app.miet-royal.de → Staff
- demo.miet-royal.de → Demo
- kunden.miet-royal.de oder /konto → Kundenbereich

## Auth
Staff: E-Mail+Passwort, optional 2FA, Geräte/Sessions, 15min App-Lock,
Session-Ablauf nach 30 Tagen Inaktivität (keine zusätzliche absolute
Maximaldauer für regelmäßig aktive Sessions), Biometrie als Gerätekomfort.
Customer: Magic Link 15min, 30 Tage Gerätesession.

## Storage
Private Object Storage für Fotos/PDFs.
DB speichert Metadaten/Keys.
Autorisierte oder kurzlebig signierte Zugriffe.

## Offline
PWA Service Worker + verschlüsselter lokaler Speicher,
nur definierter 3-Tage-Horizont.
Sync mit Operation-ID, Server-Version und Konflikterkennung.

## Backups
Startwert:
- täglich DB
- Dateien/Storage
- 7 tägliche
- 4 wöchentliche
- mehrere monatliche
- mindestens eine Kopie außerhalb Produktivserver
- Restore-Test

## Deployment
Git-basiert, Migrationen, Staging, Healthchecks, Smoke Tests,
Backup vor kritischem Release, rollbackfähig.

## Security
HTTPS, Firewall, Rate Limits, sichere Sessions, CSRF/XSS/Injection-Schutz,
Object-Level Authorization, sichere Uploads, keine Secrets im Frontend,
Security Headers.

## Datenschutz
Keine GPS-Historie.
Ephemere Vertreter-/Rückgabe-/Liefertelefonnummern nach Abschluss löschen.
Chatfotos bei Abschluss, Chattext nach 12 Monaten.
Rechtliche Dokumente separat nach definierter Aufbewahrung.

## Feature Flags
Einfache interne Flags für neue Module, z. B.
whatsapp_enabled, customer_portal_enabled, offline_returns_enabled.
