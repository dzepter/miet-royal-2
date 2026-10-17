/**
 * Testumgebung für @mietroyal/offline: IndexedDB über fake-indexeddb,
 * WebCrypto über Node (globalThis.crypto ist ab Node 20 vorhanden; ältere
 * Laufzeiten erhalten das Node-WebCrypto-Objekt explizit).
 */
import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

const globalWithCrypto = globalThis as { crypto?: Crypto };
if (globalWithCrypto.crypto === undefined) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}
