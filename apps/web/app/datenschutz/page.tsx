import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /datenschutz – Datenschutzhinweise (Pflicht für Website-Anfragen, Order §17). */
const PATH = '/datenschutz';
const TYPES = ['legal'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function PrivacyPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
