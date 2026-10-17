/**
 * Gibt den öffentlichen Ed25519-Verifikationsschlüssel der Offline-Lease dieser
 * Umgebung aus (pnpm offline:lease-key). Er ist KEIN Secret: Er wird als
 * STAFF_OFFLINE_LEASE_VERIFICATION_KEY in der Umgebung des Staff-Servers
 * hinterlegt, damit der Client Leases nur gegen genau diesen Schlüssel
 * akzeptiert (in staging/production Pflicht – siehe docs/ENVIRONMENTS.md).
 * Der private Schlüssel wird aus AUTH_SECRET_KEY abgeleitet und verlässt den
 * API-Prozess nie.
 */
import { loadConfig } from '@mietroyal/config';
import { OfflineLeaseSigner } from '../src/offline/lease-signing.ts';

const config = loadConfig(process.env);
const signer = new OfflineLeaseSigner(config.auth.secretKey);
process.stdout.write(`${signer.verificationKey}\n`);
