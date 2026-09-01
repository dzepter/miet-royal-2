import type { AppConfig } from '@mietroyal/config';

/**
 * Schmale Mail-Schnittstelle für Phase 1. Die echte E-Mail-Infrastruktur
 * kommt erst in einer späteren Phase (INTEGRATIONS.md) – hier wird bewusst
 * NICHTS davon vorweggenommen, nur der Adapterpunkt definiert.
 *
 * Sicherheitsregel: Reset-Tokens erscheinen niemals in Produktionslogs.
 * Nur der Development-Adapter gibt den Link aus (lokale Konsole).
 */
export interface StaffMailPort {
  sendPasswordReset(input: { to: string; resetToken: string }): Promise<void>;
}

/** Entwicklung: Link auf der lokalen Konsole ausgeben. */
export class DevConsoleMailAdapter implements StaffMailPort {
  async sendPasswordReset({ to, resetToken }: { to: string; resetToken: string }): Promise<void> {
    // Nur lokale Entwicklung – niemals in staging/demo/production verdrahtet.
    console.warn(
      `[dev-mail] Passwort-Reset für ${to}: /passwort-zuruecksetzen?token=${resetToken}`,
    );
  }
}

/**
 * staging/demo/production, solange es keinen echten Mailversand gibt:
 * bewusst still – der Token bleibt geheim, der Admin setzt Passwörter
 * über den Admin-Reset-Weg zurück.
 */
export class NoopMailAdapter implements StaffMailPort {
  async sendPasswordReset(): Promise<void> {
    // bewusst leer
  }
}

/** Tests: zugestellte Mails abfragbar machen. */
export class InMemoryMailAdapter implements StaffMailPort {
  readonly sent: { to: string; resetToken: string }[] = [];

  async sendPasswordReset(input: { to: string; resetToken: string }): Promise<void> {
    this.sent.push(input);
  }
}

export function createMailAdapter(config: AppConfig): StaffMailPort {
  return config.appEnv === 'development' ? new DevConsoleMailAdapter() : new NoopMailAdapter();
}
