'use client';

import { useEffect, useRef, useState } from 'react';
import { stripFragmentFromLocation } from '../../lib/portal';
import {
  PREVIEW_PAGE_PATH,
  PREVIEW_TEXT,
  consumeOutcomeMessage,
  consumePreviewToken,
  readPreviewToken,
} from '../../lib/site-preview';
import styles from './site.module.css';

type Phase = { kind: 'opening' } | { kind: 'message'; text: string; canOpenCurrent: boolean };

/**
 * Phase 16 (WEB, Order §9, Design §2.4): Einlöseseite der CMS-Vorschau – Fragment-Muster wie
 * `/konto/anmelden`: `#token=…` wird gelesen, SOFORT per `history.replaceState` entfernt und nur
 * im Speicher gehalten (nie Storage/Cookie/URL/Konsole); danach einmalig
 * `POST /api/public/cms/preview/consume`. Die API setzt das HttpOnly-Vorschau-Cookie; danach
 * öffnet sich `/vorschau/seite`. Ohne SiteFrame (keine Website-Navigation).
 */
export function PreviewConsume({ disabled }: { disabled: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'opening' });
  const started = useRef(false);

  useEffect(() => {
    // StrictMode ruft Effekte doppelt auf – das Token darf nur EINMAL eingelöst werden.
    if (started.current) return;
    started.current = true;
    const token = readPreviewToken(window.location.hash);
    if (window.location.hash !== '') stripFragmentFromLocation();
    if (disabled) {
      setPhase({ kind: 'message', text: PREVIEW_TEXT.DISABLED, canOpenCurrent: false });
      return;
    }
    if (token === null) {
      setPhase({ kind: 'message', text: PREVIEW_TEXT.MISSING, canOpenCurrent: true });
      return;
    }
    void consumePreviewToken(token).then((outcome) => {
      if (outcome.kind === 'ok') {
        window.location.replace(PREVIEW_PAGE_PATH);
        return;
      }
      setPhase({ kind: 'message', text: consumeOutcomeMessage(outcome), canOpenCurrent: false });
    });
  }, [disabled]);

  return (
    <div className={styles.site}>
      <main className={styles.main}>
        <section className={styles.statusPage} data-testid="preview-consume">
          <div className={`${styles.container} ${styles.narrow}`}>
            <p className={styles.eyebrow}>Website-Vorschau</p>
            {phase.kind === 'opening' ? (
              <h1 className={styles.h1} aria-live="polite">
                {PREVIEW_TEXT.OPENING}
              </h1>
            ) : (
              <>
                <h1 className={styles.h1}>Vorschau nicht geöffnet</h1>
                <div
                  className={`${styles.notice} ${styles.spacedTop}`}
                  role="alert"
                  data-testid="preview-consume-message"
                >
                  <p>{phase.text}</p>
                </div>
                {phase.canOpenCurrent ? (
                  <div className={styles.buttonRow}>
                    <a href={PREVIEW_PAGE_PATH} className={styles.buttonSecondary}>
                      Aktive Vorschau anzeigen
                    </a>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
