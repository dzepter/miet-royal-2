/**
 * Sicherer Bootstrap des ERSTEN Admin-Kontos (pnpm staff:bootstrap-admin).
 *
 * - Es gibt keinen hardcodierten Admin und kein Masterpasswort.
 * - Funktioniert nur, solange noch KEIN Mitarbeiterkonto existiert.
 * - Eingaben kommen aus Umgebungsvariablen (BOOTSTRAP_ADMIN_*) oder – im
 *   Terminal – aus interaktiven Prompts; das Passwort wird nicht angezeigt
 *   und niemals geloggt.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';

async function promptVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const mutedOutput = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output: mutedOutput, terminal: true });
  try {
    const answerPromise = rl.question(question);
    muted = true;
    const answer = await answerPromise;
    process.stdout.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}

async function resolveInput(envName: string, question: string, hidden = false): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (!process.stdin.isTTY) {
    console.error(`${envName} ist nicht gesetzt und es gibt kein interaktives Terminal.`);
    process.exit(2);
  }
  const value = hidden ? await promptHidden(question) : await promptVisible(question);
  if (value.trim() === '') {
    console.error('Eingabe darf nicht leer sein.');
    process.exit(2);
  }
  return value.trim();
}

const config = loadConfig();
const firstName = await resolveInput('BOOTSTRAP_ADMIN_FIRST_NAME', 'Vorname: ');
const lastName = await resolveInput('BOOTSTRAP_ADMIN_LAST_NAME', 'Nachname: ');
const email = await resolveInput('BOOTSTRAP_ADMIN_EMAIL', 'E-Mail: ');
const password = await resolveInput(
  'BOOTSTRAP_ADMIN_PASSWORD',
  'Passwort (mind. 10 Zeichen, Eingabe unsichtbar): ',
  true,
);

const pool = createPool(config.databaseUrl);
try {
  const auth = new StaffAuthService(createDb(pool), config, new NoopMailAdapter());
  const admin = new StaffAdminService(auth);
  const user = await admin.bootstrapFirstAdmin({ firstName, lastName, email, password });
  console.log(
    `Admin-Konto angelegt (APP_ENV=${config.appEnv}): ${user.firstName} ${user.lastName} <${user.email}>`,
  );
  console.log('Rolle "Administrator" mit allen Berechtigungen wurde zugewiesen.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
