/**
 * Prozessinterne Serialisierung je Schlüssel (z. B. Buchung). Ergänzt die
 * Datenbank-Sperren: Doppeltipps auf demselben Gerät warten aufeinander,
 * statt Transaktionen (und Pool-Verbindungen) zu stapeln. Über mehrere
 * API-Instanzen hinweg bleiben die Advisory-/Zeilensperren maßgeblich.
 */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => current);
    this.chains.set(key, chain);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === chain) this.chains.delete(key);
    }
  }
}
