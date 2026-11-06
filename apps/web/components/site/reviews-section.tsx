'use client';

import { useRef, useState } from 'react';
import { ratingStars, ratingText } from '../../lib/site-format';
import {
  REVIEWS_TEXT,
  attributionText,
  displayableReviews,
  fetchReviews,
  originalTextOf,
  reviewsNotice,
  reviewsPolicyNotice,
  safeHttpsUrl,
  translationLabel,
} from '../../lib/reviews';
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
 * „Google Maps“ mit `translate="no"` + nowrap, Sortierhinweis, Richtlinienhinweis + Link,
 * Übersetzungshinweis, Originaltext aufklappbar, Meldelink). Demo: eindeutig „DEMO“, nie
 * „Google“. Eine Antwort mit anderem Modus als `mode` (SSR) wird verworfen. Ein Ausfall
 * betrifft nur diese Sektion („Bewertungen sind gerade nicht verfügbar.“).
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

/** „Google Maps“ nie übersetzen und nie umbrechen (Google-Attribution, POL). */
function GoogleMapsName({ testId }: { testId?: string | undefined }) {
  return (
    <span translate="no" className={styles.noWrap} data-testid={testId}>
      Google Maps
    </span>
  );
}

function ReviewsList({ data }: { data: PublicReviewsResponse }) {
  const reviews = displayableReviews(data);
  const google = data.mode === 'google';
  const placeUri = google ? safeHttpsUrl(data.placeUri) : null;
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
        <p className={`${styles.flush} ${styles.small}`} data-testid="reviews-attribution">
          Quelle: {google ? <GoogleMapsName testId="reviews-google-maps" /> : attributionText(data)}
          {placeUri !== null ? (
            <>
              {' · '}
              <a href={placeUri} rel="noopener noreferrer" target="_blank">
                Alle Bewertungen auf <GoogleMapsName />
              </a>
            </>
          ) : null}
        </p>
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
