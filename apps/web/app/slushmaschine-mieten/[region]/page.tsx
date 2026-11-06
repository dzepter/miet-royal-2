import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CmsRoute, cmsRouteMetadata } from '../../../components/site/cms-route';
import { REGION_PATH_PREFIX, isValidRegionSlug } from '../../../lib/site-nav';

/**
 * Phase 16 (WEB, Order §4/§20, Design §5): regionale Seiten `/slushmaschine-mieten/<ort>` –
 * jede Seite ist ein eigener CMS-Eintrag mit eigenem Inhalt; nur veröffentlichte Seiten sind
 * erreichbar (sonst 404). Keine automatisch erzeugten Ortsseiten, kein generateStaticParams.
 */
const TYPES = ['region'] as const;

type Props = { params: Promise<{ region: string }> };

async function regionPath(params: Props['params']): Promise<string> {
  const { region } = await params;
  if (!isValidRegionSlug(region)) notFound();
  return `${REGION_PATH_PREFIX}${region}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return cmsRouteMetadata(await regionPath(params), TYPES);
}

export default async function RegionPage({ params }: Props) {
  return <CmsRoute path={await regionPath(params)} expectedTypes={TYPES} />;
}
