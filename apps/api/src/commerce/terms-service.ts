import { termsVersions, type Database, type TermsVersion } from '@mietroyal/database';
import type { AppConfig } from '@mietroyal/config';
import { desc, eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Versionierte Mietbedingungen (Phase-3-Vorgabe Nr. 27). Der endgültige
 * Rechtstext liegt noch nicht vor – es werden KEINE Rechtstexte erfunden.
 * Dev/Test dürfen einen klar als TEST markierten Platzhalter verwenden;
 * in Production wird Versand/Annahme ohne echten (Nicht-Test-)Text
 * blockiert.
 */
export class TermsService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async list(): Promise<TermsVersion[]> {
    return this.db.select().from(termsVersions).orderBy(desc(termsVersions.createdAt));
  }

  async create(input: { label: string; content: string; isTest: boolean }): Promise<TermsVersion> {
    if (input.label.trim() === '' || input.content.trim() === '') {
      throw new AuthError('VALIDATION', 'Label und Inhalt sind erforderlich.');
    }
    if (input.isTest && !input.label.toUpperCase().includes('TEST')) {
      throw new AuthError(
        'VALIDATION',
        'Test-Mietbedingungen müssen im Label als TEST markiert sein.',
      );
    }
    const inserted = await this.db
      .insert(termsVersions)
      .values({ label: input.label.trim(), content: input.content, isTest: input.isTest })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
    return row;
  }

  async byId(id: string): Promise<TermsVersion> {
    const rows = await this.db.select().from(termsVersions).where(eq(termsVersions.id, id));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Mietbedingungen nicht gefunden.');
    return row;
  }

  /**
   * Aktive Version für NEUE Versand-/Annahmevorgänge: die neueste Version;
   * in Production zählen ausschließlich Nicht-Test-Versionen. Existiert
   * keine geeignete Version, wird der Versand mit einem verständlichen
   * Konfigurationsfehler blockiert.
   */
  async activeForSending(): Promise<TermsVersion> {
    const rows = await this.db.select().from(termsVersions).orderBy(desc(termsVersions.createdAt));
    const candidates =
      this.config.appEnv === 'production' ? rows.filter((row) => !row.isTest) : rows;
    const active = candidates[0];
    if (active === undefined) {
      throw new AuthError(
        'CONFLICT',
        this.config.appEnv === 'production'
          ? 'Versand nicht möglich: Es sind keine echten Mietbedingungen konfiguriert (nur Testtexte sind vorhanden oder es existiert keine Version).'
          : 'Versand nicht möglich: Es ist keine Mietbedingungen-Version hinterlegt.',
      );
    }
    return active;
  }
}
