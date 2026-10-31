import type { AppConfig } from '@mietroyal/config';
import type { PdfRenderOptions } from '@mietroyal/documents';

/**
 * Phase 14 (reset, Order §89): sichtbare Umgebungskennzeichnung der
 * Kundendokumente (Angebot, Auftragsbestätigung, Lieferschein, Übergabe- und
 * Rückgabeprotokoll). Ausschließlich in APP_ENV=demo wird das Label gesetzt;
 * in jeder anderen Umgebung bleibt das Dokument unverändert. Dieselbe
 * Formulierung wie Badge/Banner der Staff- und Web-App.
 */
export const PDF_DEMO_ENVIRONMENT_LABEL = 'DEMO – keine echten Kundendaten';

export function pdfEnvironmentLabel(config: Pick<AppConfig, 'appEnv'>): string | undefined {
  return config.appEnv === 'demo' ? PDF_DEMO_ENVIRONMENT_LABEL : undefined;
}

/** Render-Optionen für `@mietroyal/documents` (leer außerhalb der Demo). */
export function pdfRenderOptions(config: Pick<AppConfig, 'appEnv'>): PdfRenderOptions {
  const environmentLabel = pdfEnvironmentLabel(config);
  return environmentLabel === undefined ? {} : { environmentLabel };
}
