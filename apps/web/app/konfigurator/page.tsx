import type { Metadata } from 'next';
import { Configurator } from '../../components/configurator/configurator';
import {
  getApiOriginMismatch,
  getCatalog,
  getSeoEnv,
  getSiteBootstrap,
} from '../../components/site/site-data';
import { SiteFrame } from '../../components/site/site-frame';
import { SiteUnavailable } from '../../components/site/site-status';
import styles from '../../components/site/site.module.css';
import { berlinToday } from '../../lib/configurator';
import { configuratorMetadata } from '../../lib/site-meta';
import { CONFIGURATOR_PATH, SECONDARY_CTA_LABEL, isPrivacyPublished } from '../../lib/site-nav';

/**
 * Phase 16 (WEB, Order §11–§17, Design §5): Slush-Konfigurator. Der Server lädt Katalog
 * (aktive Produkte mit aktuellem Preis, Abholregion – nie die exakte Adresse) und Website-
 * Einstellungen parallel; der Client-Wizard sendet nur Auswahl/Anfrage an die API.
 * Ohne veröffentlichte Datenschutzhinweise ist Absenden gesperrt (Order §17, fail-closed).
 */

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Katalog weg, keine wählbare Maschine, Datenschutz nicht veröffentlicht oder Origin-Sperre ⇒
 * noindex (Review web_security-2, Phase 17 D8/§22); Canonical immer `/konfigurator` ohne Query.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [bootstrap, catalog, seo] = await Promise.all([
    getSiteBootstrap(),
    getCatalog(),
    getSeoEnv(),
  ]);
  return configuratorMetadata(catalog, {
    ...seo,
    privacyPublished: bootstrap.ok && isPrivacyPublished(bootstrap.data.pages),
    originMismatch: getApiOriginMismatch(),
  });
}

export default async function ConfiguratorPage({ searchParams }: Props) {
  const [bootstrap, catalog, params] = await Promise.all([
    getSiteBootstrap(),
    getCatalog(),
    searchParams,
  ]);
  const boot = bootstrap.ok ? bootstrap.data : null;
  const requested = typeof params.maschine === 'string' ? params.maschine : '';
  const initialMachineSlug =
    catalog.ok && catalog.data.machines.some((machine) => machine.slug === requested)
      ? requested
      : '';
  // Nur auf Grundlage einer erreichbaren API entscheiden; ohne Einstellungen ⇒ gesperrt.
  const privacyPublished = boot !== null && isPrivacyPublished(boot.pages);

  return (
    <SiteFrame bootstrap={boot} currentPath={CONFIGURATOR_PATH}>
      {!catalog.ok ? (
        <SiteUnavailable title="Konfigurator gleich wieder da" />
      ) : (
        <>
          <header className={styles.pageHeader}>
            <div className={styles.container}>
              <p className={styles.eyebrow}>{SECONDARY_CTA_LABEL}</p>
              <h1 className={styles.h1}>Slush konfigurieren</h1>
              <p className={styles.lead}>
                In sechs kurzen Schritten zu deiner Anfrage: Event, Maschine, Sirup, Abholung oder
                Lieferung, Kontakt – und am Ende ein unverbindliches Angebot.
              </p>
            </div>
          </header>
          <div className={styles.container}>
            {catalog.data.machines.length === 0 ? (
              <div className={styles.notice} role="status" data-testid="cfg-no-machines">
                <p>
                  Gerade sind online keine Maschinen wählbar. Bitte versuche es später erneut oder
                  kontaktiere uns direkt.
                </p>
              </div>
            ) : (
              <Configurator
                catalog={catalog.data}
                privacyPublished={privacyPublished}
                submitDisabled={getApiOriginMismatch()}
                today={berlinToday()}
                initialMachineSlug={initialMachineSlug}
              />
            )}
          </div>
        </>
      )}
    </SiteFrame>
  );
}
