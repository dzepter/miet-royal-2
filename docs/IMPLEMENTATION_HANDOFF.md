# IMPLEMENTATION_HANDOFF — So starten wir später mit Claude Code

Dieses Dokument ist für den Eigentümer/Administrator, nicht für Claude selbst.

## Jetzt noch nicht nötig
Noch keine Domain umstellen.
Noch keine bestehende Website löschen.
Noch keine Produktivdaten importieren.
Noch keine echten Lexware-/WhatsApp-Zugangsdaten in Claude Code geben.

## Wenn wir mit dem Bau beginnen

1. Einen neuen lokalen Projektordner `miet-royal-2` anlegen.
2. Git-Repository initialisieren.
3. Dieses Spezifikationspaket in den Projektroot legen.
4. Claude Code im Projektroot starten.
5. Den Inhalt von `prompts/PHASE_00_FOUNDATION.md` als erste Bauanweisung verwenden.
6. Claude Code nur Phase 0 ausführen lassen.
7. Den Abschlussbericht und den erzeugten Code prüfen lassen, bevor Phase 1 startet.

## Wichtig
Die späteren Phasenprompts sollten **nicht blind heute alle vorab ausgeführt werden**.
Sie werden jeweils aus `ROADMAP.md` + dem realen Stand des Codes erzeugt.
So können wir Fehler und technische Entscheidungen aus Phase 0/1 berücksichtigen.

## Was der Nutzer mir nach Phase 0 geben sollte
Am besten:
- Claude-Codes Abschlussbericht
- relevante Fehlerausgaben, falls vorhanden
- Projektdateien oder Repository, falls in der Chatumgebung verfügbar

Dann kann die nächste genaue Anweisung für Phase 1 erstellt werden.

## Produktionsprinzip
Entwicklung → lokale Tests → Staging → Abnahme → Backup → kontrollierter Livegang.

Die bestehende Miet-Royal-Website bleibt bis zur fertigen neuen Website online.
