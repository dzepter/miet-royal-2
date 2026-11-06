import { PreviewConsume } from '../../components/site/preview-consume';
import { getApiOriginMismatch } from '../../components/site/site-data';

/**
 * Phase 16 (WEB, Order §9, Design §2.4/§11.2.10): Einlöseseite der CMS-Vorschau
 * (`/vorschau#token=…`). Weichen Build- und Laufzeit-Origin der API ab, bleibt die Vorschau
 * fail-closed gesperrt (das Cookie käme sonst von einer anderen API als die Seite).
 */
export default function PreviewPage() {
  return <PreviewConsume disabled={getApiOriginMismatch()} />;
}
