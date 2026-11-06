import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /waffeleisen-mieten – Sekundäres Angebot Waffeleisen – nur sichtbar, wenn bewusst veröffentlicht. */
const PATH = '/waffeleisen-mieten';
const TYPES = ['secondary_offer'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function WaffleIronPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
