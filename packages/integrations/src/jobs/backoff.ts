export const DEFAULT_BASE_BACKOFF_MS = 30_000;
export const DEFAULT_MAX_BACKOFF_MS = 3_600_000;

/**
 * Exponentieller Backoff für Job-Retries: base * 2^(attempt-1), gedeckelt.
 * attempt ist 1-basiert (erster fehlgeschlagener Versuch → base).
 */
export function computeBackoffMs(
  attempt: number,
  baseMs: number = DEFAULT_BASE_BACKOFF_MS,
  maxMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt muss eine positive Ganzzahl sein, war: ${attempt}`);
  }
  const exponential = baseMs * 2 ** (attempt - 1);
  return Math.min(maxMs, exponential);
}
