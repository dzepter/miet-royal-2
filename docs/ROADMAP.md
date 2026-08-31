# ROADMAP — Bauphasen

## 0 Fundament
Monorepo, Apps, API, PostgreSQL, Migrationen, Umgebungen, Jobs, Storage,
Tests, Staging/Deployment-Basis.

## 1 Staff Auth & Permissions
Login, Sessions, Passwortreset, optional 2FA, Geräte, Sperren,
Rechtematrix, temporäre Rechte.

## 2 Customer + Process Core
Kunden, MR-Nummerierung, Vorgänge, Zuständigkeit, Notizen, Suche, Heute.

## 3 Products / Pricing / Inquiry / Offer
Produkte, Preise, geplante Preise, Slushregeln, Anfrage, Angebot,
Versionierung, PDF, Annahme, AB.

## 4 Calendar & Availability
Termine, Kalender, Konflikte, Vertretung, Überfällig, Push-Grundlagen.

## 5 Machines & Inventory
MR-Maschinen, QR, Status, Sperren, Standort, Lager, Inventur.

## 6 Handover
Maschinenzuordnung, Foto, bestehende Schäden, Abholperson,
Signaturen, Lieferschein, Übergabeprotokoll.

## 7 Return / Damage / Cleaning
Vorbereitung, Zubehör, Kommission, Schaden, Fehlteil, Signaturen,
Rückgabeprotokoll, Reinigung.

## 8 Offline
Erst nachdem Ausgabe/Rückgabe online stabil ist.

## 9 Settlement / Cancellation / Deposit
Endabrechnung, offene Punkte, Vorinfo/24h, Storno, Anzahlung, Kaution.

## 10 Lexware
Echter Connector, Retry, Idempotenz, Status-Backflow, Lock.

## 11 Voucher Automation
Paid-Event → Eligibility → Gutschein → Mail.

## 12 Communications
Mail, Inbound Reply, WhatsApp, Push, Kalender.

## 13 Tours
Routing, Stopps, Zeitfenster, aktive Tour, Standort, Übernahme.

## 14 Demo & Training
Separate Infrastruktur, Seed-Daten, Trainingslayer, Reset, Mail-Whitelist,
WhatsApp-Simulation, kein Lexware.

## 15 Customer Portal
Magic Link, aktive Buchung, Dokumente, Nachrichten, Storno, Rechnung.

## 16 New Website
Startseite, Slush, Konfigurator, FAQ, Popcorn/Waffel, Kontakt, CMS, Reviews.

## 17 SEO / Website QA
Redirects, Meta, Sitemap, strukt. Daten, Performance, Responsive.

## 18 Full Acceptance
Standard, Schaden, Kundenrückfrage, Storno, Offline, Konflikt/Override,
Rechte, Demo-Isolation.

## 19 Pilot
Wenige echte Vorgänge unter enger Beobachtung.

## 20 Go Live
Backup, Release, DNS/Website-Switch, Smoke Tests, Monitoring, Rollbackfenster.

Regel: Phase erst verlassen, wenn ihre Exit-Tests bestanden sind.
