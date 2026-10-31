# Phase 13 – Traceability der Pflichttests T1–T124 (Order §72–§81)

Stand: 2026-10-30 (Branch `claude/phase-13`). Jede Nummer verweist auf mindestens einen tatsächlich existierenden Test, dessen Name mit „T<n>.“ beginnt (maschinell aus den Testdateien erzeugt).

| Nr. | Datei | Testname |
| --- | --- | --- |
| 1 | `packages/config/test/routing-config.test.ts` | T1. production ohne GRAPHHOPPER_API_KEY ⇒ provider disabled (fail closed, kein Fake) |
| 2 | `packages/config/test/routing-config.test.ts` | T2. production kann keinen Fake/Mock erzeugen: ROUTING_PROVIDER=mock ⇒ ConfigError |
| 3 | `packages/config/test/routing-config.test.ts` | T3. demo ist immer Mock (auch mit ROUTING_ENABLED=true/ROUTING_PROVIDER=mock) |
| 4 | `packages/config/test/routing-config.test.ts` | T4. demo mit echtem Key oder ROUTING_PROVIDER=graphhopper ⇒ ConfigError („Demo ruft nie einen echten Routing-Provider“) |
| 5 | `packages/config/test/routing-config.test.ts` | T5. staging Default disabled; development Default mock; echter Provider nur per vollständigem Opt-in |
| 6 | `packages/config/test/routing-config.test.ts` | T6./T7./T8. der Key existiert nur unter routing.graphhopper.apiKey – keine Kopie an anderer Stelle (Browser/DB/Log erhalten das Objekt nie) |
| 7 | `apps/api/test/tours-geocoding.integration.test.ts` | T7./T8. Key steht nie in der Datenbank und nie im Serverlog (Pino-Redaction unter allen Pfaden); App-Gateway läuft über die Fabrik |
| 7 | `packages/config/test/routing-config.test.ts` | T6./T7./T8. der Key existiert nur unter routing.graphhopper.apiKey – keine Kopie an anderer Stelle (Browser/DB/Log erhalten das Objekt nie) |
| 8 | `apps/api/test/tours-geocoding.integration.test.ts` | T7./T8. Key steht nie in der Datenbank und nie im Serverlog (Pino-Redaction unter allen Pfaden); App-Gateway läuft über die Fabrik |
| 8 | `packages/config/test/routing-config.test.ts` | T6./T7./T8. der Key existiert nur unter routing.graphhopper.apiKey – keine Kopie an anderer Stelle (Browser/DB/Log erhalten das Objekt nie) |
| 9 | `packages/config/test/routing-config.test.ts` | T9. production: Host fest https://graphhopper.com/api/1 (auch mit gleichlautender Angabe) |
| 10 | `packages/config/test/routing-config.test.ts` | T10. production: fremder GRAPHHOPPER_BASE_URL-Override wird blockiert (ConfigError ohne Key im Text) |
| 11 | `apps/api/test/routing-graphhopper.test.ts` | T11. Auth korrekt: Key nur als Query |
| 12 | `apps/api/test/routing-graphhopper.test.ts` | T12. 429 ⇒ rate_limited (transient) mit retryAfter aus X-RateLimit-Reset; Tageskontingent 0 + Reset > 60 s ⇒ credit_limited (permanent); Pause ⇒ Folge-Requests scheitern sofort (fail-fast, Fix F1) |
| 13 | `apps/api/test/routing-graphhopper.test.ts` | T13. Timeout ⇒ RoutingError timeout (transient), genau ein Request, kein eigener Retry |
| 14 | `apps/api/test/routing-graphhopper.test.ts` | T14. Malformed/unerwartete Antwort ⇒ invalid_response (fail-closed, permanent); kein Ergebnis wird erraten |
| 15 | `apps/api/test/routing-graphhopper.test.ts` | T15. Provider down (5xx) ⇒ server_error transient mit genau EINEM Request (kein Retry-Sturm); 400 ⇒ validation, 404 ⇒ not_found (permanent) |
| 15 | `apps/api/test/tours-geocoding.integration.test.ts` | T15-Teil. Provider-Fehler (5xx/429/Timeout/401) ⇒ unavailable ohne Cache-Eintrag; vorhandener abgelaufener Eintrag bleibt unverändert |
| 16 | `apps/api/test/routing-graphhopper.test.ts` | T16. Datenminimierung: Request-Bodies enthalten nur Koordinaten, Zeitfenster, Dauern und anonyme IDs; Geocoding nur die Adresse; VRP nur dokumentierte Felder |
| 16 | `packages/config/test/routing-config.test.ts` | T16. Environment-Isolation: derselbe GraphHopper-Key in zwei Umgebungen kollidiert; getrennte Keys nicht |
| 17 | `apps/api/test/tours-geocoding.integration.test.ts` | T17. eindeutige Adresse ⇒ resolved mit Koordinate, Cache-Eintrag (TTL 90 Tage), zweiter Aufruf ohne Provider |
| 18 | `apps/api/test/tours-geocoding.integration.test.ts` | T18. mehrere Kandidaten / keine Hausnummer im Treffer ⇒ review_required mit ≤ 5 Kandidaten (keine stille Straßenmitte), TTL 30 Tage |
| 19 | `apps/api/test/tours-geocoding.integration.test.ts` | T19. kein Treffer ⇒ no_result (nicht routefähig), Cache-Eintrag no_result ohne Koordinate; leere Eingabe ⇒ no_result ohne Provider |
| 20 | `apps/api/test/tours-geocoding.integration.test.ts` | T20. Kundendaten außer der Adresse stehen nie im Geocoding-Request (Name, Telefon, E-Mail, Vorgangsnummer, Preis) |
| 21 | `apps/api/test/tours-geocoding.integration.test.ts` | T21. Delivery-Adresse kommt ausschließlich aus dem eingefrorenen Snapshot – nie aus dem (geänderten) Kundenstamm; unvollständiger Snapshot ⇒ missing |
| 22 | `apps/api/test/tours-geocoding.integration.test.ts` | T22. fehlende Depotadresse (pickup_exact_address) ⇒ status missing als Blocker; gesetzt ⇒ Depot und Abhol-/Rückgabetermine am Standort nutzen dieselbe Adresse |
| 23 | `apps/api/test/tours-geocoding.integration.test.ts` | T23. Bestätigung nur aus gespeicherten Kandidaten: fremde Ref/freie Koordinate abgelehnt, gültige Ref ⇒ resolved + confirmed; Bestätigung überlebt den Cache-Ablauf |
| 24 | `apps/api/test/tours-geocoding.integration.test.ts` | T24. Geocoding-IDOR: unbekannte cacheId ⇒ NOT_FOUND; Kandidaten-Ref eines anderen Eintrags ⇒ VALIDATION – nichts verändert |
| 25 | `apps/api/test/tours-planning.integration.test.ts` | T25. Tour anlegen ⇒ Entwurf mit Version 1, Fahrer und leerer Stoppliste |
| 26 | `apps/api/test/tours-planning.integration.test.ts` | T26. Tourdatum ist der Berliner Kalendertag des Termins (00:30 Berlin zählt zum Tourtag) |
| 27 | `apps/api/test/tours-planning.integration.test.ts` | T27. Fahrer muss aktiv sein |
| 28 | `apps/api/test/tours-planning.integration.test.ts` | T28. Termin hinzufügen ⇒ Stopp mit abgeleitetem Zustand, Adresse und Navigation |
| 29 | `apps/api/test/tours-planning.integration.test.ts` | T29. Derselbe Termin steckt nie in zwei offenen Touren (409 + DB-Backstop); nach Abbruch wieder frei |
| 30 | `apps/api/test/tours-planning.integration.test.ts` | T30. Vollständige Reihenfolge setzen; unvollständige wird abgelehnt |
| 31 | `apps/api/test/tours-planning.integration.test.ts` | T31. Drag&Drop mit expectedVersion: veraltete Version ⇒ 409 TOUR_VERSION_CONFLICT |
| 32 | `apps/api/test/tours-planning.integration.test.ts` | T32. Parallele Änderungen mit derselben Version: genau eine gewinnt, die andere 409 |
| 33 | `apps/api/test/tours-planning.integration.test.ts` | T33. Gepinnter Stopp behält seine Position – Vorschlag über Matrix + lokalen Planer |
| 34 | `apps/api/test/tours-planning.integration.test.ts` | T34. Standardpuffer 15 Minuten; Planer darf 0–240 setzen, außerhalb ⇒ 400 |
| 35 | `apps/api/test/tours-planning.integration.test.ts` | T35./T36./T45. Exakter Termin und Zeitfenster bleiben unverändert – kein Auto-Reschedule |
| 36 | `apps/api/test/tours-planning.integration.test.ts` | T35./T36./T45. Exakter Termin und Zeitfenster bleiben unverändert – kein Auto-Reschedule |
| 37 | `apps/api/test/tours-planning.integration.test.ts` | T37./T39. Vorschlag berechnen überschreibt nichts – Verwerfen ist ein reiner Client-Schritt |
| 38 | `apps/api/test/tours-planning.integration.test.ts` | T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten |
| 39 | `apps/api/test/tours-planning.integration.test.ts` | T37./T39. Vorschlag berechnen überschreibt nichts – Verwerfen ist ein reiner Client-Schritt |
| 40 | `apps/api/test/tours-planning.integration.test.ts` | T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten |
| 41 | `apps/api/test/tours-planning.integration.test.ts` | T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten |
| 42 | `apps/api/test/tours-planning.integration.test.ts` | T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten |
| 43 | `apps/api/test/tours-planning.integration.test.ts` | T38./T40.–T43. Übernehmen bewertet die Reihenfolge serverseitig neu und speichert Distanz, Fahrzeit, Abschnitte und interne Ankunftszeiten |
| 44 | `apps/api/test/tours-planning.integration.test.ts` | T44./T45. Unmögliche Zeitvorgaben ⇒ infeasible mit verständlichem Konflikt, Termine unverändert |
| 45 | `apps/api/test/tours-planning.integration.test.ts` | T35./T36./T45. Exakter Termin und Zeitfenster bleiben unverändert – kein Auto-Reschedule |
| 45 | `apps/api/test/tours-planning.integration.test.ts` | T44./T45. Unmögliche Zeitvorgaben ⇒ infeasible mit verständlichem Konflikt, Termine unverändert |
| 46 | `apps/api/test/tours-planning.integration.test.ts` | T46. Kein automatischer Lieferpreis: Buchungs-Snapshot unverändert, Grenze liefert null |
| 47 | `apps/api/test/tours-planning.integration.test.ts` | T47. Providerfehler ⇒ 503 „Route konnte gerade nicht berechnet werden.“, Tour manuell weiter nutzbar |
| 48 | `apps/api/test/tours-assignment.integration.test.ts` | T48. Offener (unzugewiesener) Termin wird über die bestehende Zuweisung dem Tourfahrer zugewiesen – nur mit appointment.assign |
| 49 | `apps/api/test/tours-assignment.integration.test.ts` | T49. Gleiche (effektive) Zuständigkeit ⇒ Termin bleibt unverändert |
| 50 | `apps/api/test/tours-assignment.integration.test.ts` | T50. Fremde Zuständigkeit wird nie still überschrieben: 409 mit Hinweis, nur mit reassign: true |
| 51 | `apps/api/test/tours-assignment.integration.test.ts` | T51./T52. Same-Day-Wechsel braucht appointment.reassign_same_day; Übernahmebestätigung (Phase 4) bleibt korrekt |
| 52 | `apps/api/test/tours-assignment.integration.test.ts` | T51./T52. Same-Day-Wechsel braucht appointment.reassign_same_day; Übernahmebestätigung (Phase 4) bleibt korrekt |
| 53 | `apps/api/test/tours-assignment.integration.test.ts` | T53./T54./T55. Übernahme wechselt Tourfahrer und ALLE offenen Stopp-Termine atomar; erledigte bleiben historisch |
| 54 | `apps/api/test/tours-assignment.integration.test.ts` | T53./T54./T55. Übernahme wechselt Tourfahrer und ALLE offenen Stopp-Termine atomar; erledigte bleiben historisch |
| 55 | `apps/api/test/tours-assignment.integration.test.ts` | T53./T54./T55. Übernahme wechselt Tourfahrer und ALLE offenen Stopp-Termine atomar; erledigte bleiben historisch |
| 56 | `apps/api/test/tours-assignment.integration.test.ts` | T56. Ein Fehler bei EINEM Stopp rollt die gesamte Übernahme zurück (keine halbe Übernahme) |
| 57 | `apps/api/test/tours-assignment.integration.test.ts` | T57. Aktive Vertretung ist effektiver Tourfahrer: sieht die Tour, darf starten; gespeicherter Fahrer bleibt |
| 58 | `apps/api/test/tours-assignment.integration.test.ts` | T58. Nach Vertretungsende ist der gespeicherte Fahrer wieder effektiv zuständig |
| 59 | `apps/api/test/tours-active-gps.integration.test.ts` | T59. Start nur bewusst: Anlegen/Stopps starten nichts; erst POST …/start setzt active/started_at/started_by |
| 60 | `apps/api/test/tours-active-gps.integration.test.ts` | T60. Doppelklick: zwei parallele Starts ⇒ genau ein Start, ein started_at |
| 61 | `apps/api/test/tours-active-gps.integration.test.ts` | T61. Keine zweite aktive Tour derselben effektiven Person (gespeichert oder per Vertretung) |
| 62 | `apps/api/test/tours-active-gps.integration.test.ts` | T62. GPS erst in aktiver Tour: Entwurf ⇒ neutral 404 ohne Zeile; nach Start ⇒ 204 |
| 63 | `apps/api/test/tours-active-gps.integration.test.ts` | T63. Standort verweigert: Tour läuft ohne GPS – View, „Angekommen“, Prognose „nicht verfügbar“ |
| 64 | `apps/api/test/tours-active-gps.integration.test.ts` | T64. Gültiges Update ⇒ 204, eine Zeile mit Werten; View ohne Koordinaten; nie im Log/Kundenstatus |
| 65 | `apps/api/test/tours-active-gps.integration.test.ts` | T65. Jedes Update überschreibt die alte Position (eine Zeile, neue Werte) |
| 66 | `apps/api/test/tours-active-gps.integration.test.ts` | T66. Keine Historie: drei Updates ⇒ eine Zeile; keine Track-Tabelle im Schema |
| 67 | `apps/api/test/tours-active-gps.integration.test.ts` | T67. Fremder Nutzer blockiert (neutral 404): anderer Fahrer, Planung, view_all; Vertretung darf |
| 68 | `apps/api/test/tours-active-gps.integration.test.ts` | T68./T69. Tourende blockiert GPS und löscht die Position; Übernahme: alter Fahrer blockiert, neuer darf |
| 69 | `apps/api/test/tours-active-gps.integration.test.ts` | T68./T69. Tourende blockiert GPS und löscht die Position; Übernahme: alter Fahrer blockiert, neuer darf |
| 70 | `apps/api/test/tours-active-gps.integration.test.ts` | T70. Nachträglich gesendete (offline gesammelte) Standorte werden abgelehnt – kein Track aus der Vergangenheit, keine Zukunft |
| 71 | `apps/api/test/tours-active-gps.integration.test.ts` | T71. Standort älter als 10 Minuten ⇒ „nicht aktuell“ (stale) und keine Live-Prognose |
| 72 | `apps/api/test/tours-active-gps.integration.test.ts` | T72. Keine Background-Garantie: die API behauptet kein Hintergrund-Tracking – nur observedAt/receivedAt/stale |
| 73 | `apps/api/test/tours-route-changes.integration.test.ts` | T73. Storno während der Tour ⇒ Stopp operativ übersprungen (Listener) und lazy beim Lesen |
| 74 | `apps/api/test/tours-route-changes.integration.test.ts` | T74. Terminverschiebung ⇒ Plan stale (Warnung), Version erhöht, Termine unangetastet |
| 75 | `apps/api/test/tours-route-changes.integration.test.ts` | T75./T76. Restroute neu berechnen: nur verbleibende Stopps, erledigte bleiben unverändert |
| 76 | `apps/api/test/tours-route-changes.integration.test.ts` | T75./T76. Restroute neu berechnen: nur verbleibende Stopps, erledigte bleiben unverändert |
| 77 | `apps/api/test/tours-route-changes.integration.test.ts` | T77. Änderung der Depotadresse ⇒ Plan stale |
| 78 | `apps/api/test/tours-route-changes.integration.test.ts` | T78. Version ändert sich während der externen Berechnung ⇒ Ergebnis verworfen (409), nichts gespeichert |
| 79 | `apps/api/test/tours-route-changes.integration.test.ts` | T79. Während des Provider-Aufrufs hält die Berechnung KEINE Zeilensperre auf der Tour |
| 80 | `apps/api/test/tours-delay-risk.integration.test.ts` | T80. ETA im Fenster ⇒ kein Risk, kein Incident, kein Push; Prognose ok |
| 81 | `apps/api/test/tours-delay-risk.integration.test.ts` | T81. ETA nach der Deadline ⇒ Risk: Incident mit Prognose/Deadline, View risk + Warnung, Prognose-Endpunkt |
| 82 | `apps/api/test/tours-delay-risk.integration.test.ts` | T82. Exakter Termin: Deadline = Termin selbst; Ankunft danach ⇒ Risk |
| 83 | `apps/api/test/tours-delay-risk.integration.test.ts` | T83. Zeitfenster: Deadline = Fensterende – Ankunft nach Fensterbeginn, aber vor Ende ⇒ kein Risk; nach Ende ⇒ Risk |
| 84 | `apps/api/test/tours-delay-risk.integration.test.ts` | T84. 15-min-Puffer der vorherigen Stopps zählt: mit Standardpuffer Risk, ohne Puffer pünktlich |
| 85 | `apps/api/test/tours-delay-risk.integration.test.ts` | T85. Provider nicht verfügbar/deaktiviert ⇒ „unavailable“: kein falscher Risk, keine falsche Entwarnung, kein zweiter Push |
| 86 | `apps/api/test/tours-delay-risk.integration.test.ts` | T86. Stale GPS (> 10 min) ⇒ keine Live-Prognose, kein Provider-Aufruf, kein Incident |
| 87 | `apps/api/test/tours-delay-risk.integration.test.ts` | T87./T88. Erstes echtes Risk ⇒ genau ein Push an den effektiven Fahrer (Vertretung) und an Planung/Admin, nicht an sonstige |
| 88 | `apps/api/test/tours-delay-risk.integration.test.ts` | T87./T88. Erstes echtes Risk ⇒ genau ein Push an den effektiven Fahrer (Vertretung) und an Planung/Admin, nicht an sonstige |
| 89 | `apps/api/test/tours-delay-risk.integration.test.ts` | T89. Gleicher Incident ⇒ kein Spam: erneute Bewertung (manuell, Standort, Scanner) erzeugt keinen zweiten Push |
| 90 | `apps/api/test/tours-delay-risk.integration.test.ts` | T90. Wieder pünktlich ⇒ resolved (kein Push); neues echtes Risk nach Auflösung ⇒ neuer Incident, neuer Push |
| 91 | `apps/api/test/tours-delay-risk.integration.test.ts` | T91./T92./T93. Risk und Auflösung lösen NIE Kundenkommunikation aus (Mail, WhatsApp, Aktions-/Portal-Links) |
| 92 | `apps/api/test/tours-delay-risk.integration.test.ts` | T91./T92./T93. Risk und Auflösung lösen NIE Kundenkommunikation aus (Mail, WhatsApp, Aktions-/Portal-Links) |
| 93 | `apps/api/test/tours-delay-risk.integration.test.ts` | T91./T92./T93. Risk und Auflösung lösen NIE Kundenkommunikation aus (Mail, WhatsApp, Aktions-/Portal-Links) |
| 94 | `apps/api/test/tours-delay-risk.integration.test.ts` | T94. Push ohne PII: nur Terminart + Vorgangsnummer – kein Name, keine Adresse, kein Telefon, keine Koordinate, kein Preis |
| 95 | `apps/api/test/tours-travel-status.integration.test.ts` | T95./T96. Nur der NÄCHSTE offene Kundenstopp der aktiven Tour ist unterwegs – und erst nach dem Start |
| 96 | `apps/api/test/tours-travel-status.integration.test.ts` | T95./T96. Nur der NÄCHSTE offene Kundenstopp der aktiven Tour ist unterwegs – und erst nach dem Start |
| 97 | `apps/api/test/tours-travel-status.integration.test.ts` | T97. Nach Abschluss des ersten Stopps ist der zweite unterwegs |
| 98 | `apps/api/test/tours-travel-status.integration.test.ts` | T98. Stornierte Buchung ist nie unterwegs; der nächste offene Stopp rückt nach |
| 99 | `apps/api/test/tours-travel-status.integration.test.ts` | T99. Beendete Tour ⇒ keine Buchung unterwegs |
| 100 | `apps/api/test/tours-travel-status.integration.test.ts` | T100. Depot-/Selbstabholungsstopp ohne Kundenfahrt ist nie unterwegs (Locationsemantik, nicht Name) |
| 101 | `apps/api/test/tours-travel-status.integration.test.ts` | T101./T102./T103. Ergebnis enthält nur den Status – kein GPS, keine ETA, kein Fahrername |
| 102 | `apps/api/test/tours-travel-status.integration.test.ts` | T101./T102./T103. Ergebnis enthält nur den Status – kein GPS, keine ETA, kein Fahrername |
| 103 | `apps/api/test/tours-travel-status.integration.test.ts` | T101./T102./T103. Ergebnis enthält nur den Status – kein GPS, keine ETA, kein Fahrername |
| 104 | `apps/api/test/tours-security.integration.test.ts` | T104./T106. Navigations-Links enthalten nur das Ziel (Adresse bzw. Koordinate) – keinen Kundennamen, keine Vorgangsnummer |
| 105 | `apps/api/test/tours-security.integration.test.ts` | T105. Kein API-Key in Antworten: Tour-View, Prognose, Navigation |
| 106 | `apps/api/test/tours-security.integration.test.ts` | T104./T106. Navigations-Links enthalten nur das Ziel (Adresse bzw. Koordinate) – keinen Kundennamen, keine Vorgangsnummer |
| 107 | `apps/api/test/tours-security.integration.test.ts` | T107./T108./T109. Apple-, Android- und Desktop-Link je Stopp (Adresse und Koordinate) |
| 108 | `apps/api/test/tours-security.integration.test.ts` | T107./T108./T109. Apple-, Android- und Desktop-Link je Stopp (Adresse und Koordinate) |
| 109 | `apps/api/test/tours-security.integration.test.ts` | T107./T108./T109. Apple-, Android- und Desktop-Link je Stopp (Adresse und Koordinate) |
| 110 | `apps/api/test/tours-security.integration.test.ts` | T110. Fremde Tour-ID ⇒ neutral 404 für Lesen und alle Fahreraktionen; unbekannte ID identisch |
| 111 | `apps/api/test/tours-security.integration.test.ts` | T111. Fremder Stopp ⇒ neutral 404 (auch für Planer über eine andere Tour) |
| 112 | `apps/api/test/tours-security.integration.test.ts` | T112. calendar.view sieht nur eigene bzw. effektiv vertretene Touren |
| 113 | `apps/api/test/tours-security.integration.test.ts` | T113. calendar.view_all sieht alle Touren, darf aber nicht planen |
| 114 | `apps/api/test/tours-security.integration.test.ts` | T114. calendar.manage plant/bearbeitet alle Touren; Fahrer ohne manage nicht |
| 115 | `apps/api/test/tours-security.integration.test.ts` | T115. Offline-Paket enthält die EIGENE aktive Tour lesbar (Reihenfolge, Zeiten, Adressen, Navigation, Zustand) – ohne GPS, ohne Kundendaten; fremde nie |
| 116 | `apps/api/test/tours-security.integration.test.ts` | T116. Offline-Mutationen der Tour sind serverseitig unmöglich: Sync kennt keine Tour-/GPS-Mutation; GPS nie nachsynchronisiert |
| 117 | `apps/api/test/tours-end.integration.test.ts` | T117./T123./T124. Alle Stopps erledigt ⇒ normales Ende; Live-Standort gelöscht; erneutes Ende idempotent |
| 118 | `apps/api/test/tours-end.integration.test.ts` | T118. Offene Stopps ⇒ 409 „Die Tour enthält noch offene Stopps.“ – Tour bleibt aktiv |
| 119 | `apps/api/test/tours-end.integration.test.ts` | T119./T120. Planer beendet trotzdem – nur calendar.manage, nur mit Grund; offene Termine bleiben scheduled |
| 120 | `apps/api/test/tours-end.integration.test.ts` | T119./T120. Planer beendet trotzdem – nur calendar.manage, nur mit Grund; offene Termine bleiben scheduled |
| 121 | `apps/api/test/tours-end.integration.test.ts` | T121./T122. Beendete Tour gibt Stopps frei (neu aufnehmbar) und bleibt als Historie erhalten |
| 122 | `apps/api/test/tours-end.integration.test.ts` | T121./T122. Beendete Tour gibt Stopps frei (neu aufnehmbar) und bleibt als Historie erhalten |
| 123 | `apps/api/test/tours-end.integration.test.ts` | T117./T123./T124. Alle Stopps erledigt ⇒ normales Ende; Live-Standort gelöscht; erneutes Ende idempotent |
| 124 | `apps/api/test/tours-end.integration.test.ts` | T117./T123./T124. Alle Stopps erledigt ⇒ normales Ende; Live-Standort gelöscht; erneutes Ende idempotent |

Fehlende Nummern: keine
