/**
 * Zentrale Validierungsgrundlage (CLAUDE.md: "alle externen Eingaben
 * serverseitig validieren"). Fachliche Schemas kommen ab Phase 1+ hierher;
 * Phase 0 liefert nur den Mechanismus.
 */
import { z } from 'zod';

export { z };

export interface ValidationIssue {
  /** Pfad zum fehlerhaften Feld, z. B. "body.email". */
  path: string;
  message: string;
}

/**
 * Wird von API-Handlern gefangen und als strukturierte 400-Antwort
 * ausgegeben. Enthält nur Feldpfade und Meldungen, keine Eingabewerte.
 */
export class RequestValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super('Eingabedaten sind ungültig');
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

/**
 * Validiert externe Eingaben gegen ein Zod-Schema.
 * @param source Präfix für Fehlerpfade (z. B. "body", "query", "params").
 */
export function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  data: unknown,
  source = 'body',
): z.output<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path: [source, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
