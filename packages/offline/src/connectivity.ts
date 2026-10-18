/**
 * Konnektivitäts-Epoche (Phase-8-Order §78): Jeder Offline-Übergang (offline-
 * Event) erhöht die Epoche. Ein laufender Health-Check gehört zu der Epoche,
 * in der er gestartet wurde. Trifft seine Antwort erst ein, nachdem das Gerät
 * offline gegangen ist (Epoche überholt oder `navigator.onLine === false`),
 * darf sie den Zustand nicht mehr auf „online“ setzen und keinen Sync starten –
 * sonst überschreibt eine späte Antwort den bereits gemeldeten Offline-Zustand.
 */
export class ConnectivityEpoch {
  private current = 0;

  /** Aktuelle Epoche – beim Start einer Prüfung festhalten. */
  get value(): number {
    return this.current;
  }

  /** Offline-Übergang vermerken: alle davor gestarteten Prüfungen sind veraltet. */
  bump(): number {
    this.current += 1;
    return this.current;
  }

  /**
   * true = eine in Epoche `started` begonnene Prüfung darf kein „online“ mehr
   * melden (zwischenzeitlich offline gegangen oder Browser meldet offline).
   */
  isStale(started: number, navigatorOnLine: boolean | undefined): boolean {
    return started !== this.current || navigatorOnLine === false;
  }
}
