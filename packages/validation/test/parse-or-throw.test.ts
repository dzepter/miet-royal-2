import { describe, expect, it } from 'vitest';
import { parseOrThrow, RequestValidationError, z } from '../src/index.ts';

describe('parseOrThrow', () => {
  const schema = z.object({ email: z.string().min(3), amount: z.number().int() });

  it('gibt validierte Daten typisiert zurück', () => {
    const value = parseOrThrow(schema, { email: 'a@b.c', amount: 5 });
    expect(value).toEqual({ email: 'a@b.c', amount: 5 });
  });

  it('wirft RequestValidationError mit Feldpfaden, aber ohne Eingabewerte', () => {
    try {
      parseOrThrow(schema, { email: 'supergeheimer-wert-x', amount: 'viel' }, 'body');
      expect.unreachable('ungültige Eingabe muss abgelehnt werden');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestValidationError);
      const validationError = error as RequestValidationError;
      expect(validationError.issues.map((i) => i.path)).toContain('body.amount');
      expect(JSON.stringify(validationError.issues)).not.toContain('supergeheimer-wert-x');
    }
  });
});
