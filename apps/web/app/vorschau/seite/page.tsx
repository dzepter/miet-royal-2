import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { CmsPageView } from '../../../components/site/cms-route';
import { getApiOriginMismatch, getSiteBootstrap } from '../../../components/site/site-data';
import { SiteFrame } from '../../../components/site/site-frame';
import { FallbackHome } from '../../../components/site/site-status';
import styles from '../../../components/site/site.module.css';
import { loadPreviewPage } from '../../../lib/site-api';
import { formatBerlinClock } from '../../../lib/site-format';
import { PREVIEW_TEXT, previewBannerText, previewCookieHeader } from '../../../lib/site-preview';

/**
 * Phase 16 (WEB, Order §9, Design §2.4.4): Vorschau eines CMS-Entwurfs im ECHTEN Renderer.
 * Liest das HttpOnly-Vorschau-Cookie serverseitig (`await cookies()`) und reicht NUR dieses an
 * `GET <WEB_API_ORIGIN>/public/cms/preview/page` weiter (no-store). Öffentliche Seiten lesen das
 * Cookie nie. Header (no-store, noindex/noarchive, no-referrer, DENY) setzt next.config.ts;
 * Metadaten noindex über `app/vorschau/layout.tsx`. Cookie-Wert wird nie geloggt.
 */

const loadPreview = cache(async () => {
  if (getApiOriginMismatch()) return { ok: false as const, reason: 'disabled' as const };
  const store = await cookies();
  const header = previewCookieHeader((name) => store.get(name)?.value);
  return loadPreviewPage(header);
});

export async function generateMetadata(): Promise<Metadata> {
  const result = await loadPreview();
  const title = result.ok ? (result.data.page?.title ?? 'Website-Einstellungen') : 'Vorschau';
  return {
    title: `Vorschau: ${title} – Miet-Royal`,
    robots: { index: false, follow: false, nocache: true },
  };
}

function PreviewMessage({ text }: { text: string }) {
  return (
    <div className={styles.site}>
      <main className={styles.main}>
        <section className={styles.statusPage} data-testid="preview-unavailable">
          <div className={`${styles.container} ${styles.narrow}`}>
            <p className={styles.eyebrow}>Website-Vorschau</p>
            <h1 className={styles.h1}>Keine Vorschau verfügbar</h1>
            <div className={`${styles.notice} ${styles.spacedTop}`} role="alert">
              <p>{text}</p>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default async function PreviewPageView() {
  const [result, bootstrap] = await Promise.all([loadPreview(), getSiteBootstrap()]);
  if (!result.ok) {
    const text =
      result.reason === 'disabled'
        ? PREVIEW_TEXT.DISABLED
        : result.reason === 'unavailable'
          ? PREVIEW_TEXT.UNAVAILABLE
          : PREVIEW_TEXT.NO_SESSION;
    return <PreviewMessage text={text} />;
  }
  const { preview, page, settings } = result.data;
  const boot = bootstrap.ok ? bootstrap.data : null;
  const banner = (
    <div className={styles.previewBanner} role="status" data-testid="preview-banner">
      {previewBannerText(preview)}
      <span>Gültig bis {formatBerlinClock(preview.expiresAt)} Uhr · nur für dich sichtbar</span>
    </div>
  );
  return (
    <SiteFrame
      bootstrap={boot}
      settingsOverride={settings}
      currentPath={page?.path ?? '/'}
      banner={banner}
    >
      {page !== null ? (
        <CmsPageView page={page} bootstrap={boot} settings={settings} />
      ) : (
        <FallbackHome businessName={settings?.businessName ?? 'Miet-Royal'} />
      )}
    </SiteFrame>
  );
}
