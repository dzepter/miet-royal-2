import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /kontakt – Kontakt (öffentliche Kontaktseite; Token-Links liegen unter /kontakt/[token]). */
const PATH = '/kontakt';
const TYPES = ['contact'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function ContactPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
