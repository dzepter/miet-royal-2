import type { Metadata } from 'next';
import { CmsRoute, cmsRouteMetadata } from '../../components/site/cms-route';

/** Phase 16 (WEB, Design §5): CMS-Seite /faq – Häufige Fragen. */
const PATH = '/faq';
const TYPES = ['faq'] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsRouteMetadata(PATH, TYPES);
}

export default function FaqPage() {
  return <CmsRoute path={PATH} expectedTypes={TYPES} />;
}
