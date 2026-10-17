/**
 * Fehlerklassifikation der Lexware-HTTP-Antworten (Order §12). Es werden nur
 * neutrale Codes weitergegeben – nie Rohfehler mit Kundendaten, nie der Key.
 */
export type LexwareErrorKind =
  | 'validation' // 400/406 – permanent, Daten/Konfiguration prüfen
  | 'unauthorized' // 401 – Key ungültig/abgelaufen
  | 'forbidden' // 403 – Berechtigung fehlt
  | 'not_found' // 404 – Mapping/Objekt fehlt ⇒ Reconciliation
  | 'conflict' // 409 – Version/Zustand ⇒ Stand lesen
  | 'payment_required' // 402 – Vertragsproblem
  | 'rate_limited' // 429 – transient mit Retry-After/Backoff
  | 'server' // 5xx – transient
  | 'timeout' // Timeout/Netzwerk – transient; für CREATE: outcome unknown
  | 'network'
  | 'invalid_response'; // nicht parsebare/unerwartete Antwort

export interface LexwareErrorOptions {
  status?: number;
  retryAfterMs?: number;
  /** Anonymisierte Validierungsdetails (nur field/violation, keine Werte). */
  violations?: readonly { field: string; violation: string }[];
  traceId?: string;
}

export class LexwareApiError extends Error {
  readonly kind: LexwareErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly violations: readonly { field: string; violation: string }[];
  readonly traceId: string | undefined;

  constructor(kind: LexwareErrorKind, message: string, options: LexwareErrorOptions = {}) {
    super(message);
    this.name = 'LexwareApiError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.violations = options.violations ?? [];
    this.traceId = options.traceId;
  }

  /** Transient ⇒ Queue-Retry mit Backoff; sonst permanent (Konfiguration/Daten/Prüfung). */
  get transient(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'server' ||
      this.kind === 'timeout' ||
      this.kind === 'network'
    );
  }

  /** Neutraler Code für Persistenz/Logs (z. B. LEXWARE_UNAUTHORIZED). */
  get code(): string {
    return `LEXWARE_${this.kind.toUpperCase()}`;
  }
}

export function classifyStatus(status: number): LexwareErrorKind {
  if (status === 400 || status === 406 || status === 415) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
}

/** Lexware-Fehlerkörper (regulär oder Legacy IssueList) auf anonyme Details reduzieren. */
export function extractViolations(body: unknown): { field: string; violation: string }[] {
  if (body === null || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;
  const out: { field: string; violation: string }[] = [];
  const details = record.details;
  if (Array.isArray(details)) {
    for (const entry of details) {
      if (entry !== null && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        out.push({
          field: typeof e.field === 'string' ? e.field : '',
          violation: typeof e.violation === 'string' ? e.violation : '',
        });
      }
    }
  }
  const issues = record.IssueList;
  if (Array.isArray(issues)) {
    for (const entry of issues) {
      if (entry !== null && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        out.push({
          field: typeof e.source === 'string' ? e.source : '',
          violation:
            typeof e.i18nKey === 'string' ? e.i18nKey : typeof e.type === 'string' ? e.type : '',
        });
      }
    }
  }
  return out.slice(0, 20);
}
