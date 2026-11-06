import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /slushmaschine-mieten – Slushmaschine mieten (Hauptprodukt). */
const PATH = '/slushmaschine-mieten';
const TYPES = ['slush'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function SlushPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
