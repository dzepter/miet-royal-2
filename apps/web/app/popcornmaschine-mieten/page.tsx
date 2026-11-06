import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /popcornmaschine-mieten – Sekundäres Angebot Popcorn – nur sichtbar, wenn bewusst veröffentlicht. */
const PATH = '/popcornmaschine-mieten';
const TYPES = ['secondary_offer'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function PopcornPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
