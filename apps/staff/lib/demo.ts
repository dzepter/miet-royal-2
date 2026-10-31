'use client';

import { useEffect, useState } from 'react';
import { apiFetch, type ApiResult } from './api';

/**
 * Phase 14 (Demo-Umgebung, Design §§3–5): Kennzeichnung, Live↔Demo-Wechsel
 * und Demo-Verwaltung (Status/Registry/Reset) der Staff-App. Texte zentral,
 * damit Badge, Dialoge und Hinweise überall gleich heißen (UX_RULES „Sprache“).
 */

export const DEMO_BADGE_TEXT = 'DEMO – keine echten Kundendaten';
export const DEMO_BADGE_SHORT = 'DEMO';
export const DEMO_TITLE_PREFIX = 'DEMO · ';
export const DEMO_RESET_CONFIRMATION = 'DEMO ZURÜCKSETZEN';
export const DEMO_OUTDATED_TEXT = 'Demo-Datenstand ist veraltet – Zurücksetzen empfohlen.';

export type AppEnvironmentName = 'development' | 'staging' | 'demo' | 'production';

export interface EnvironmentCounterpart {
  kind: 'demo' | 'live';
  /** Nur der Origin (vom Server validiert); die App hängt fest `/login` an. */
  url: string;
}

export interface DemoStaffRef {
  id: string;
  name: string;
}

export interface DemoStatus {
  environment: 'demo';
  datasetVersion: number | null;
  expectedDatasetVersion: number;
  outdated: boolean;
  outdatedHint: string | null;
  seededAt: string | null;
  seededBy: DemoStaffRef | null;
  lastResetAt: string | null;
  lastResetBy: DemoStaffRef | null;
  resetInProgress: boolean;
  resetStartedAt: string | null;
  resetStale: boolean;
  counts: { customers: number; processes: number; tours: number };
  seedEntities: number;
}

export interface DemoSeedEntity {
  seedKey: string;
  entityType: string;
  entityId: string;
  datasetVersion: number;
}

export interface DemoResetResult {
  ok: true;
  datasetVersion: number;
  seededAt: string;
  durationMs: number;
  deleted: Record<string, number>;
  seeded: Record<string, number>;
}

export function fetchDemoStatus(): Promise<ApiResult<DemoStatus>> {
  return apiFetch<DemoStatus>('/staff/demo/status');
}

export function fetchDemoSeedEntities(): Promise<
  ApiResult<{ expectedDatasetVersion: number; entities: DemoSeedEntity[] }>
> {
  return apiFetch('/staff/demo/seed-entities');
}

export function resetDemo(confirmation: string): Promise<ApiResult<DemoResetResult>> {
  return apiFetch<DemoResetResult>('/staff/demo/reset', { method: 'POST', body: { confirmation } });
}

/** Ziel-URL des Wechsels: fester Origin + /login – nie die aktuelle URL, nie Parameter. */
export function counterpartLoginUrl(counterpart: EnvironmentCounterpart): string {
  return `${counterpart.url.replace(/\/+$/, '')}/login`;
}

export function counterpartLabel(counterpart: EnvironmentCounterpart): string {
  return counterpart.kind === 'demo' ? 'Demo öffnen' : 'Live öffnen';
}

const ENVIRONMENTS: readonly AppEnvironmentName[] = [
  'development',
  'staging',
  'demo',
  'production',
];

/**
 * Umgebung des Servers für Seiten OHNE AuthGuard (Login, Passwort vergessen/
 * zurücksetzen) über `GET /api/health` (ohne Anmeldung). Fehler ⇒ null (kein
 * Badge, keine Fehlanzeige).
 */
export function useEnvironment(): AppEnvironmentName | null {
  const [environment, setEnvironment] = useState<AppEnvironmentName | null>(null);
  useEffect(() => {
    let cancelled = false;
    void apiFetch<{ environment?: string }>('/health').then((result) => {
      if (cancelled || result.data === null) return;
      const value = result.data.environment;
      if (typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value)) {
        setEnvironment(value as AppEnvironmentName);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return environment;
}

/** Dokumenttitel-Präfix „DEMO · “ (Design §3) – idempotent, auch nach Seitenwechseln. */
export function useDemoDocumentTitle(isDemo: boolean, dependency: string | null = null): void {
  useEffect(() => {
    if (!isDemo || typeof document === 'undefined') return;
    if (!document.title.startsWith(DEMO_TITLE_PREFIX)) {
      document.title = `${DEMO_TITLE_PREFIX}${document.title}`;
    }
  }, [isDemo, dependency]);
}
