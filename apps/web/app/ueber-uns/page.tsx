import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /ueber-uns – Über uns. */
const PATH = '/ueber-uns';
const TYPES = ['about'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function AboutPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
