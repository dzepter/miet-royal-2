/**
 * Offline-Workspace: Schlüsselverwaltung, Lease und Entsperrung
 * (Phase-8-Order §§6–8, 38/39, Tests 9–14, 103).
 *
 * Schlüsselmodell je Benutzer × Umgebung × Gerät:
 * - DEK (AES-256-GCM) nur im Arbeitsspeicher; `lock()` entfernt ihn.
 * - Wrap A: KEK = PBKDF2-SHA-256 (600 000 Iterationen) über das
 *   Mitarbeiterpasswort – entsteht nur bei ONLINE bestätigter Anmeldung/
 *   Entsperrung (Passwort liegt im Formular vor; kein zusätzlicher Prompt,
 *   keine PIN). Falsches Passwort scheitert am GCM-Tag (`wrong_password`).
 * - Wrap B: serverseitiges Lease-Secret (stille Online-Entsperrung).
 * - Autorisierungsgrenze der Lease (Phase-8-Finalisierung §1): der vom Server
 *   mit Ed25519 signierte Claim (`claim`/`signature`/`verificationKey`). Bei
 *   JEDER Entsperrung und in `leaseState()` werden Signatur, Struktur
 *   (Laufzeit ≤ 72 h) und Identitätsbindung (userId × deviceId × environment)
 *   erneut vollständig offline geprüft; leaseId/issuedAt/expiresAt des lokalen
 *   Datensatzes müssen exakt dem verifizierten Claim entsprechen. Ungültig
 *   oder abweichend ⇒ `lease_tampered`; abgelaufen (gegen die injizierte,
 *   monotone Uhr) ⇒ `lease_expired`. Fehlt Ed25519 in WebCrypto, ist die
 *   Lease ungültig – nie „durchwinken“.
 * - Der HMAC-SHA-256 (HKDF aus dem DEK) über den Lease-Datensatz bleibt als
 *   Integritätsschutz für Rechte-Snapshot und Namen (und als Bindung des
 *   flüchtigen Schlüssels aus dem Service Worker an genau diesen Arbeits-
 *   bereich). Er ist NICHT mehr die Autorisierungsgrenze: wer den DEK besitzt,
 *   kann ihn neu berechnen – die Server-Signatur dagegen nicht.
 * - Ohne gültige Lease öffnet auch das richtige Passwort nicht (Offline-
 *   Arbeitsbereich gesperrt bis zur Online-Neuautorisierung).
 * - Niemals lokal: Passwort, Passwort-Hash, TOTP-Secrets (Test 14).
 * - Ein bestehender DEK wird bei erneuter Online-Autorisierung nie still
 *   ersetzt, solange lokale Daten vorhanden sind (`WorkspaceRekeyRefusedError`).
 */
import {
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_BYTES,
  deriveHmacKey,
  deriveKekFromPassword,
  fromBase64Url,
  generateDek,
  hmacHex,
  hmacVerify,
  importLeaseSecret,
  randomBytes,
  toBase64Url,
  unwrapDek,
  wrapDek,
} from './crypto.ts';
import {
  LeaseInvalidError,
  leaseClaimExpired,
  verifyLeaseClaim,
  type LeaseClaimFailure,
} from './lease-claim.ts';
import type { OfflineEnvironment } from './mutations.ts';
import type { LeaseGrant, OfflineLeaseClaim } from './package-types.ts';
import type { LeaseRecord, WorkspaceRecord } from './records.ts';
import type { OfflineStore } from './store.ts';

export type { LeaseGrant };
export { LeaseInvalidError };

export interface WorkspaceIdentity {
  userId: string;
  environment: OfflineEnvironment;
  deviceId: string;
}

export type LeaseState =
  | { kind: 'none' }
  | { kind: 'valid'; lease: LeaseRecord; expiresAt: string }
  | { kind: 'expired'; lease: LeaseRecord; expiresAt: string }
  | { kind: 'tampered'; reason: LeaseClaimFailure | 'record_mismatch' | 'mac_mismatch' };

export interface WorkspaceOptions {
  /**
   * Optional gepinnter Ed25519-Verifikationsschlüssel des Servers (Base64url,
   * öffentlich – kein Secret). Gesetzt, wird nur eine Lease mit genau diesem
   * Schlüssel akzeptiert; ungesetzt gilt der im Grant/Datensatz gelieferte.
   */
  trustedVerificationKey?: string | null;
  /**
   * Fail-closed: ohne gepinnten Schlüssel wird KEINE Lease akzeptiert (staging/
   * production – der Staff-Server liefert den Schlüssel aus seiner Umgebung).
   */
  requireTrustedKey?: boolean;
}

export type UnlockFailureReason =
  | 'no_workspace'
  | 'wrong_password'
  | 'lease_expired'
  | 'lease_tampered'
  /** WebCrypto ohne Ed25519 – Lease offline nicht prüfbar. */
  | 'lease_unsupported'
  /** Kein (passender) hinterlegter Serverschlüssel – Lease nicht vertrauenswürdig. */
  | 'lease_untrusted'
  | 'too_many_attempts';

function unlockReasonFor(reason: LeaseClaimFailure | 'record_mismatch'): UnlockFailureReason {
  if (reason === 'unsupported') return 'lease_unsupported';
  if (reason === 'untrusted_key') return 'lease_untrusted';
  return 'lease_tampered';
}

export type UnlockResult = { ok: true } | { ok: false; reason: UnlockFailureReason };

export interface AuthorizeOptions {
  /**
   * Darf ein neuer DEK erzeugt werden, wenn der bestehende nicht
   * wiederherstellbar ist (z. B. geändertes Passwort)? Dann werden die
   * vorhandenen lokalen Fachdaten entfernt (unlesbar). Default: nur, wenn
   * noch kein Arbeitsbereich existiert.
   */
  allowNewDek?: boolean;
}

export class WorkspaceRekeyRefusedError extends Error {
  constructor() {
    super(
      'Der lokale Schlüssel ist nicht wiederherstellbar; vorhandene Offline-Daten werden nicht still neu verschlüsselt.',
    );
    this.name = 'WorkspaceRekeyRefusedError';
  }
}

/** HKDF-Info für den Lease-HMAC-Schlüssel. */
const LEASE_MAC_INFO = 'mietroyal-offline-lease-mac-v1';

/** JSON mit rekursiv sortierten Schlüsseln (stabile HMAC-Eingabe). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * HMAC des Lease-Datensatzes (HKDF aus dem DEK). Exportiert, damit Tests einen
 * „selbst signierten“ Datensatz bauen können – er darf ohne gültige
 * Server-Signatur trotzdem nicht akzeptiert werden.
 */
export async function computeLeaseMac(
  dek: CryptoKey,
  identity: WorkspaceIdentity,
  lease: LeaseRecord,
): Promise<string> {
  const { userId, environment, deviceId } = identity;
  return hmacHex(
    await deriveHmacKey(dek, LEASE_MAC_INFO),
    canonicalJson({ userId, environment, deviceId, lease }),
  );
}

type LeaseCheck =
  | { ok: true; claim: OfflineLeaseClaim }
  | { ok: false; reason: LeaseClaimFailure | 'record_mismatch' };

export class OfflineWorkspace {
  private dek: CryptoKey | null = null;
  private readonly trustedVerificationKey: string | null;
  private readonly requireTrustedKey: boolean;

  constructor(
    private readonly store: OfflineStore,
    private readonly identity: WorkspaceIdentity,
    private readonly now: () => Date = () => new Date(),
    options: WorkspaceOptions = {},
  ) {
    this.trustedVerificationKey = options.trustedVerificationKey ?? null;
    this.requireTrustedKey = options.requireTrustedKey ?? false;
  }

  get unlocked(): boolean {
    return this.dek !== null;
  }

  /** Flüchtiger DEK (nur für die Übergabe an den Service Worker – nie persistieren). */
  currentKey(): CryptoKey | null {
    return this.dek;
  }

  record(): Promise<WorkspaceRecord | undefined> {
    return this.store.getWorkspace();
  }

  private aadPassword(): string {
    const { userId, environment, deviceId } = this.identity;
    return `wrap-password:${userId}:${environment}:${deviceId}`;
  }

  private aadLease(leaseId: string): string {
    const { userId, environment, deviceId } = this.identity;
    return `wrap-lease:${leaseId}:${userId}:${environment}:${deviceId}`;
  }

  private signLease(dek: CryptoKey, lease: LeaseRecord): Promise<string> {
    return computeLeaseMac(dek, this.identity, lease);
  }

  /** HMAC-Integrität (Rechte-Snapshot, Name, Bindung an diesen DEK) – nicht die Autorisierungsgrenze. */
  private async verifyLeaseMac(
    dek: CryptoKey,
    lease: LeaseRecord,
    mac: string | null,
  ): Promise<boolean> {
    if (mac === null) return false;
    const { userId, environment, deviceId } = this.identity;
    return hmacVerify(
      await deriveHmacKey(dek, LEASE_MAC_INFO),
      canonicalJson({ userId, environment, deviceId, lease }),
      mac,
    );
  }

  /**
   * Autorisierungsgrenze: Server-Signatur + Claim-Struktur + Identität
   * verifizieren und den lokalen Datensatz exakt gegen den Claim abgleichen.
   * Läuft vollständig offline (WebCrypto Ed25519), ohne DEK.
   */
  private async checkLeaseClaim(lease: LeaseRecord): Promise<LeaseCheck> {
    const verified = await verifyLeaseClaim(
      lease,
      this.identity,
      this.trustedVerificationKey,
      this.requireTrustedKey,
    );
    if (!verified.ok) return verified;
    const { claim } = verified;
    if (
      lease.leaseId !== claim.leaseId ||
      lease.userId !== claim.userId ||
      lease.deviceId !== claim.deviceId ||
      lease.environment !== claim.environment ||
      lease.issuedAt !== claim.issuedAt ||
      lease.expiresAt !== claim.expiresAt
    ) {
      return { ok: false, reason: 'record_mismatch' };
    }
    return { ok: true, claim };
  }

  private claimExpired(claim: OfflineLeaseClaim): boolean {
    return leaseClaimExpired(claim, this.now().getTime());
  }

  private async unlockCheckedWith(dek: CryptoKey, record: WorkspaceRecord): Promise<UnlockResult> {
    if (record.lease === null) return { ok: false, reason: 'lease_expired' };
    const check = await this.checkLeaseClaim(record.lease);
    if (!check.ok) return { ok: false, reason: unlockReasonFor(check.reason) };
    if (!(await this.verifyLeaseMac(dek, record.lease, record.leaseMac))) {
      return { ok: false, reason: 'lease_tampered' };
    }
    if (this.claimExpired(check.claim)) return { ok: false, reason: 'lease_expired' };
    this.adopt(dek);
    return { ok: true };
  }

  private adopt(dek: CryptoKey): void {
    this.dek = dek;
    this.store.setKey(dek);
  }

  /**
   * Online autorisierte Einrichtung/Erneuerung (Anmeldung, Entsperrung,
   * Lease-Verlängerung): Lease vom Server, Wraps lokal erneuern.
   *
   * Reihenfolge der DEK-Wiederherstellung: bereits entsperrt → Passwort
   * (Wrap A) → neuer DEK nur mit `allowNewDek` (bzw. ohne bestehenden
   * Arbeitsbereich). Mit Passwort wird Wrap A stets neu erzeugt; ohne Passwort
   * bleibt der bestehende Wrap A erhalten.
   */
  async authorizeOnline(
    grant: LeaseGrant,
    password: string | null,
    options: AuthorizeOptions = {},
  ): Promise<void> {
    // Autorisierungsgrenze (§1): Signatur, Struktur und Identität des Claims prüfen –
    // ein ungültiger Grant wird nicht übernommen, der bestehende Zustand bleibt.
    const verified = await verifyLeaseClaim(
      grant,
      this.identity,
      this.trustedVerificationKey,
      this.requireTrustedKey,
    );
    if (!verified.ok) throw new LeaseInvalidError(verified.reason);
    const claim = verified.claim;
    if (this.claimExpired(claim)) throw new LeaseInvalidError('expired');
    const existing = await this.record();
    const allowNewDek = options.allowNewDek ?? existing === undefined;

    let dek = this.dek;
    if (dek === null && existing !== undefined && password !== null) {
      dek = await this.unwrapWithPassword(existing, password);
    }
    let rekeyed = false;
    if (dek === null) {
      if (!allowNewDek) throw new WorkspaceRekeyRefusedError();
      dek = await generateDek();
      rekeyed = existing !== undefined;
    }

    let salt = existing?.salt ?? toBase64Url(randomBytes(PBKDF2_SALT_BYTES));
    let kdfIterations = existing?.kdfIterations ?? PBKDF2_ITERATIONS;
    let wrappedByPassword = existing?.wrappedByPassword ?? null;
    if (password !== null || rekeyed) wrappedByPassword = null;
    if (password !== null) {
      salt = toBase64Url(randomBytes(PBKDF2_SALT_BYTES));
      kdfIterations = PBKDF2_ITERATIONS;
      const kek = await deriveKekFromPassword(password, fromBase64Url(salt), kdfIterations);
      wrappedByPassword = await wrapDek(dek, kek, this.aadPassword());
    }

    // Identität und Laufzeit NUR aus dem verifizierten Claim – nie aus den losen Grant-Feldern.
    const lease: LeaseRecord = {
      leaseId: claim.leaseId,
      userId: claim.userId,
      environment: claim.environment,
      deviceId: claim.deviceId,
      issuedAt: claim.issuedAt,
      expiresAt: claim.expiresAt,
      claim: grant.claim,
      signature: grant.signature,
      verificationKey: grant.verificationKey,
      permissions: [...grant.permissions],
      firstName: grant.firstName,
      lastName: grant.lastName,
    };
    const wrappedByLease = await wrapDek(
      dek,
      await importLeaseSecret(grant.leaseSecret),
      this.aadLease(claim.leaseId),
    );
    const nowIso = this.now().toISOString();
    const record: WorkspaceRecord = {
      key: 'workspace',
      userId: this.identity.userId,
      environment: this.identity.environment,
      deviceId: this.identity.deviceId,
      createdAt: existing?.createdAt ?? nowIso,
      salt,
      kdfIterations,
      wrappedByPassword,
      wrappedByLease,
      lease,
      leaseMac: await this.signLease(dek, lease),
      lastAuthorizedAt: nowIso,
    };
    if (rekeyed) {
      // Alte Fachdaten sind mit dem neuen Schlüssel unlesbar: bewusst entfernen
      // (nur erlaubt, wenn nichts Ausstehendes existiert – Entscheidung des Aufrufers).
      await this.store.wipeData();
    }
    await this.store.putWorkspace(record);
    this.adopt(dek);
  }

  private async unwrapWithPassword(
    record: WorkspaceRecord,
    password: string,
  ): Promise<CryptoKey | null> {
    if (record.wrappedByPassword === null) return null;
    const kek = await deriveKekFromPassword(
      password,
      fromBase64Url(record.salt),
      record.kdfIterations,
    );
    return unwrapDek(record.wrappedByPassword, kek, this.aadPassword());
  }

  /** Lokale Offline-Entsperrung mit dem Mitarbeiterpasswort (Wrap A). */
  async unlockWithPassword(password: string): Promise<UnlockResult> {
    const record = await this.record();
    if (record === undefined) return { ok: false, reason: 'no_workspace' };
    const dek = await this.unwrapWithPassword(record, password);
    if (dek === null) return { ok: false, reason: 'wrong_password' };
    return this.unlockCheckedWith(dek, record);
  }

  /** Stille Online-Entsperrung mit dem Lease-Secret des Servers (Wrap B). */
  async unlockWithLeaseSecret(leaseId: string, leaseSecret: string): Promise<UnlockResult> {
    const record = await this.record();
    if (record === undefined) return { ok: false, reason: 'no_workspace' };
    if (record.lease === null || record.wrappedByLease === null) {
      return { ok: false, reason: 'lease_expired' };
    }
    if (record.lease.leaseId !== leaseId) return { ok: false, reason: 'lease_expired' };
    let key: CryptoKey;
    try {
      key = await importLeaseSecret(leaseSecret);
    } catch {
      return { ok: false, reason: 'wrong_password' };
    }
    const dek = await unwrapDek(record.wrappedByLease, key, this.aadLease(leaseId));
    if (dek === null) return { ok: false, reason: 'wrong_password' };
    return this.unlockCheckedWith(dek, record);
  }

  /**
   * Übernahme eines flüchtigen Schlüssels (z. B. aus dem Service Worker nach
   * Reload): nur, wenn die Lease-HMAC mit genau diesem Schlüssel stimmt.
   */
  async unlockWithKey(key: CryptoKey): Promise<UnlockResult> {
    const record = await this.record();
    if (record === undefined) return { ok: false, reason: 'no_workspace' };
    return this.unlockCheckedWith(key, record);
  }

  /** Wrap A nach Passwortwechsel erneuern (nur im entsperrten Zustand). */
  async rewrapWithPassword(newPassword: string): Promise<void> {
    const dek = this.dek;
    const record = await this.record();
    if (dek === null || record === undefined) {
      throw new Error('Der Offline-Arbeitsbereich ist nicht entsperrt.');
    }
    const salt = toBase64Url(randomBytes(PBKDF2_SALT_BYTES));
    const kek = await deriveKekFromPassword(newPassword, fromBase64Url(salt), PBKDF2_ITERATIONS);
    await this.store.putWorkspace({
      ...record,
      salt,
      kdfIterations: PBKDF2_ITERATIONS,
      wrappedByPassword: await wrapDek(dek, kek, this.aadPassword()),
    });
  }

  async leaseState(): Promise<LeaseState> {
    const record = await this.record();
    if (record === undefined || record.lease === null) return { kind: 'none' };
    const lease = record.lease;
    // Server-Signatur + Claim-Abgleich bei jeder Abfrage – vollständig offline, ohne DEK.
    const check = await this.checkLeaseClaim(lease);
    if (!check.ok) return { kind: 'tampered', reason: check.reason };
    if (this.dek !== null && !(await this.verifyLeaseMac(this.dek, lease, record.leaseMac))) {
      return { kind: 'tampered', reason: 'mac_mismatch' };
    }
    return this.claimExpired(check.claim)
      ? { kind: 'expired', lease, expiresAt: check.claim.expiresAt }
      : { kind: 'valid', lease, expiresAt: check.claim.expiresAt };
  }

  /**
   * Lease lokal entwerten (Widerruf/Deaktivierung beim Onlinekontakt, §39):
   * Wrap B und Lease-Metadaten entfernen, Fachdaten und Wrap A bleiben –
   * nichts wird heimlich vernichtet. Der Aufrufer sperrt separat (`lock`).
   */
  async invalidateLease(): Promise<void> {
    const record = await this.record();
    if (record === undefined) return;
    await this.store.putWorkspace({
      ...record,
      wrappedByLease: null,
      lease: null,
      leaseMac: null,
    });
  }

  /** App-Sperre: DEK aus dem Speicher entfernen (Store wirft danach WorkspaceLockedError). */
  lock(): void {
    this.dek = null;
    this.store.setKey(null);
  }
}
