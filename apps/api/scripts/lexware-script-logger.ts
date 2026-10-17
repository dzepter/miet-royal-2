/**
 * Minimaler Logger für die Lexware-Scripts: gibt nur Codes/IDs aus (der
 * Client loggt Methode, maskierten Pfad, Status, Dauer – nie Key/Body).
 */
import type { LexwareLogger } from '../src/lexware/context.ts';

function line(level: string, obj: Record<string, unknown>, msg: string): void {
  const text = `[${level}] ${msg} ${JSON.stringify(obj)}`;
  if (level === 'error' || level === 'warn') console.error(text);
  else if (process.env.LEXWARE_SCRIPT_VERBOSE === '1') console.log(text);
}

export const scriptLogger: LexwareLogger = {
  info: (obj, msg) => line('info', obj, msg),
  warn: (obj, msg) => line('warn', obj, msg),
  error: (obj, msg) => line('error', obj, msg),
};
