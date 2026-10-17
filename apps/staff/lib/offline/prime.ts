'use client';

import { apiFetch, type Me } from '../api';
import { offlineRuntime } from './runtime';

/**
 * Nach einer ONLINE bestätigten Anmeldung (Phase-8-Order §7): das Passwort
 * liegt im Formular vor – damit Wrap A des lokalen Schlüssels erzeugen bzw.
 * erneuern, die Offline-Lease ausstellen und das erste Arbeitspaket laden.
 * Kein zusätzlicher Prompt, keine PIN. Fehler werden geschluckt: die
 * Online-Nutzung funktioniert auch ohne Offline-Arbeitsbereich.
 */
export async function primeOfflineWorkspace(password: string): Promise<void> {
  try {
    const runtime = offlineRuntime();
    if (!runtime.available) return;
    const me = await apiFetch<Me>('/auth/me');
    const user = me.data?.user;
    if (me.data === null || user === undefined || user.id === undefined) return;
    if (me.data.environment === undefined) return;
    await runtime.init({
      userId: user.id,
      environment: me.data.environment,
      firstName: user.firstName,
      lastName: user.lastName,
    });
    const authorized = await runtime.authorizeOnline(password);
    if (!authorized) return;
    await runtime.checkConnectivity(false);
    await runtime.refreshPackage();
  } catch {
    // Offline-Vorbereitung ist nie ein Anmeldefehler.
  }
}
