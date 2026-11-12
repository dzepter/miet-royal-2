'use client';

import { useRef, useState } from 'react';
import { ratingStars, ratingText } from '../../lib/site-format';
import {
  GOOGLE_MAPS_LOGO,
  REVIEWS_TEXT,
  displayableReviews,
  fetchReviews,
  originalTextOf,
  reviewsAttribution,
  reviewsNotice,
  reviewsPolicyNotice,
  safeHttpsUrl,
  translationLabel,
} from '../../lib/reviews';
import type { ReviewsAttribution } from '../../lib/reviews';
import type { PublicReviewsResponse, ReviewMode } from '../../lib/site-types';
import styles from './site.module.css';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; data: PublicReviewsResponse }
  | { kind: 'error' };

/**
 * Phase 16 (WEB, Order §18, Design §1.5/§4/§11.2.6): Bewertungen per Klick-zum-Laden.
 * Vor dem Klick wird nichts von Google geladen (kein Script, kein Widget, keine Bilder).
 * Google: Pflicht-Attribution (Autorname + Link, Profilbild mit `referrerPolicy="no-referrer"`,
 * offizielles Google-Maps-Logo als Attribution (Phase 17, Design D19 – `GoogleMapsAttribution`),
 * „Google Maps“ in Linktexten mit `translate="no"` + nowrap, Sortierhinweis, Richtlinienhinweis +
 * Link, Übersetzungshinweis, Originaltext aufklappbar, Meldelink). Demo: eindeutig „DEMO“, nie
 * „Google“, nie das Logo. Eine Antwort mit anderem Modus als `mode` (SSR) wird verworfen. Ein
 * Ausfall betrifft nur diese Sektion („Bewertungen sind gerade nicht verfügbar.“).
 */
export function ReviewsSection({
  mode,
  heading,
  intro,
}: {
  /** SSR-Modus (`google`/`demo`); nur Antworten mit genau diesem Modus werden angezeigt. */
  mode: ReviewMode;
  heading: string;
  intro?: string | undefined;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setPhase({ kind: 'loading' });
    const outcome = await fetchReviews(mode);
    loadingRef.current = false;
    setPhase(outcome.kind === 'ok' ? { kind: 'loaded', data: outcome.data } : { kind: 'error' });
  }

  return (
    <div data-testid="reviews-section" data-review-mode={mode}>
      <h2 className={styles.h2}>
        {heading}{' '}
        {mode === 'demo' ? (
          <span className={styles.badge} data-testid="reviews-demo-badge">
            {REVIEWS_TEXT.DEMO_BADGE}
          </span>
        ) : null}
      </h2>
      {intro ? <p className={styles.intro}>{intro}</p> : null}

      {phase.kind === 'idle' || phase.kind === 'loading' || phase.kind === 'error' ? (
        <div>
          <p className={`${styles.muted} ${styles.small}`} data-testid="reviews-notice">
            {reviewsNotice(mode)}
          </p>
          {phase.kind === 'error' ? (
            <div className={styles.noticeError} role="alert" data-testid="reviews-error">
              <p>{REVIEWS_TEXT.UNAVAILABLE}</p>
            </div>
          ) : null}
          <div className={styles.buttonRow}>
            <button
              type="button"
              className={styles.buttonSecondary}
              onClick={() => void load()}
              disabled={phase.kind === 'loading'}
              aria-busy={phase.kind === 'loading'}
              data-testid="reviews-load"
            >
              {phase.kind === 'loading' ? REVIEWS_TEXT.LOADING : REVIEWS_TEXT.BUTTON}
            </button>
          </div>
        </div>
      ) : (
        <ReviewsList data={phase.data} />
      )}
    </div>
  );
}

/** „Google Maps“ in Linktexten nie übersetzen und nie umbrechen (Google-Attribution, POL). */
function GoogleMapsName({ testId }: { testId?: string | undefined }) {
  return (
    <span translate="no" className={styles.noWrap} data-testid={testId}>
      Google Maps
    </span>
  );
}

/**
 * Phase 17 (REVIEWS-QA, Design D19 / Auftrag §25): Attribution mit dem OFFIZIELLEN Google-Maps-
 * Logo statt Text (POL 2026-11-09: „Attribution should take the form of the Google Maps logo
 * whenever possible“ – eine Website-Sektion hat keinen Platzmangel).
 * - Unverändertes Asset aus `apps/web/public/` (Gray-Variante auf dem Creme-Hintergrund; kein
 *   Nachbau, keine Farb-/Formänderung, kein Filter), `width`/`height` im nativen Verhältnis
 *   98:18 (kein Layout-Shift), CSS-Höhe 18 px (POL 16–19 dp), Breite auto.
 * - Eigenständiges Element oben im Inhalt der Sektion (neben der Gesamtbewertung, gleicher
 *   Container) – nie inline in einem Satz; `translate="no"`; Accessibility-Label „Google Maps“ als
 *   alt-Text (kein zusätzlicher versteckter Text nötig).
 * - Freiraum ≥ 10 px: vertikal durch Innenabstand (`clearSpacePx`, zugleich 44 px Touchfläche
 *   des Links), horizontal durch Flex-Abstand 1rem (`.reviewSummary`) und Seitenrand (`.container`).
 * - Verlinkt auf den Ort bei Google Maps (`placeUri`), nur wenn vorhanden und https; sonst Logo
 *   ohne Link. Nur im Modus `google` gerendert – Demo zeigt Text, nie das Logo.
 */
function GoogleMapsAttribution({
  attribution,
}: {
  attribution: Extract<ReviewsAttribution, { kind: 'google-maps-logo' }>;
}) {
  const logo = (
    <img
      src={attribution.src}
      alt={attribution.alt}
      width={attribution.width}
      height={attribution.height}
      decoding="async"
      style={{ display: 'block', height: `${attribution.height}px`, width: 'auto' }}
    />
  );
  const clearSpace = { display: 'block', padding: `${GOOGLE_MAPS_LOGO.clearSpacePx}px 0` } as const;
  return (
    <div
      translate="no"
      data-testid="reviews-attribution"
      data-attribution="google-maps-logo"
      style={{ display: 'flex', alignSelf: 'center' }}
    >
      {attribution.href !== null ? (
        <a href={attribution.href} rel="noopener noreferrer" target="_blank" style={clearSpace}>
          {logo}
        </a>
      ) : (
        <span style={clearSpace}>{logo}</span>
      )}
    </div>
  );
}

function ReviewsList({ data }: { data: PublicReviewsResponse }) {
  const reviews = displayableReviews(data);
  const google = data.mode === 'google';
  const placeUri = google ? safeHttpsUrl(data.placeUri) : null;
  const attribution = reviewsAttribution(data);
  const policy = reviewsPolicyNotice(data);
  const translatedLabel = translationLabel(data);
  return (
    <div data-testid="reviews-list">
      <div className={styles.reviewSummary}>
        {data.rating !== null ? (
          <p className={styles.flush}>
            <span className={styles.stars} aria-hidden="true">
              {ratingStars(data.rating)}
            </span>{' '}
            <strong>{ratingText(data.rating)}</strong>
            {data.total !== null ? ` · ${data.total} Bewertungen` : null}
          </p>
        ) : null}
        {attribution.kind === 'google-maps-logo' ? (
          <GoogleMapsAttribution attribution={attribution} />
        ) : (
          <p
            className={`${styles.flush} ${styles.small}`}
            data-testid="reviews-attribution"
            data-attribution="text"
          >
            Quelle: {attribution.text}
          </p>
        )}
        {placeUri !== null ? (
          <p className={`${styles.flush} ${styles.small}`}>
            <a href={placeUri} rel="noopener noreferrer" target="_blank">
              Alle Bewertungen auf <GoogleMapsName />
            </a>
          </p>
        ) : null}
      </div>
      {policy !== null ? (
        <p className={`${styles.muted} ${styles.small}`} data-testid="reviews-policy">
          {policy.text}{' '}
          <a href={policy.href} rel="noopener noreferrer" target="_blank">
            {REVIEWS_TEXT.POLICY_LINK}
          </a>
        </p>
      ) : null}
      {data.sortNote.trim() !== '' ? (
        <p className={`${styles.muted} ${styles.small}`}>{data.sortNote}</p>
      ) : null}
      {reviews.length === 0 ? (
        <p className={styles.muted}>Gerade sind keine Bewertungen verfügbar.</p>
      ) : (
        <ul className={styles.reviewList}>
          {reviews.map((review, index) => {
            const authorUri = safeHttpsUrl(review.authorUri);
            const photoUri = safeHttpsUrl(review.authorPhotoUri);
            const reviewUri = safeHttpsUrl(review.reviewUri);
            const flagUri = safeHttpsUrl(review.flagUri);
            const originalText = originalTextOf(data, review);
            return (
              <li key={`${review.authorName}-${index}`} className={styles.review}>
                <div className={styles.reviewAuthor}>
                  {photoUri !== null ? (
                    <img
                      src={photoUri}
                      alt=""
                      width={40}
                      height={40}
                      className={styles.avatar}
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : null}
                  <div>
                    {authorUri !== null ? (
                      <a href={authorUri} rel="noopener noreferrer" target="_blank">
                        {review.authorName}
                      </a>
                    ) : (
                      <strong>{review.authorName}</strong>
                    )}
                    {review.relativeTime ? (
                      <div className={`${styles.muted} ${styles.small}`}>{review.relativeTime}</div>
                    ) : null}
                  </div>
                </div>
                <p className={styles.flush}>
                  <span className={styles.stars} aria-hidden="true">
                    {ratingStars(review.rating)}
                  </span>{' '}
                  <span className={styles.small}>Bewertung: {ratingText(review.rating)}</span>
                </p>
                <p className={styles.reviewText}>{review.text}</p>
                {review.translated === true && translatedLabel !== null ? (
                  <p
                    className={`${styles.muted} ${styles.small} ${styles.flush}`}
                    data-testid="reviews-translated"
                  >
                    {translatedLabel}
                  </p>
                ) : null}
                {originalText !== null ? (
                  <details className={styles.reviewOriginal} data-testid="reviews-original">
                    <summary>{REVIEWS_TEXT.ORIGINAL_TEXT}</summary>
                    <p className={styles.reviewText}>{originalText}</p>
                  </details>
                ) : null}
                {reviewUri !== null || flagUri !== null ? (
                  <div className={styles.reviewLinks}>
                    {reviewUri !== null ? (
                      <a href={reviewUri} rel="noopener noreferrer" target="_blank">
                        Auf <GoogleMapsName /> ansehen
                      </a>
                    ) : null}
                    {flagUri !== null ? (
                      <a href={flagUri} rel="noopener noreferrer" target="_blank">
                        Bewertung melden
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
