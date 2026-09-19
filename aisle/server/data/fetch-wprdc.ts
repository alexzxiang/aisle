/**
 * Refresh `server/data/wprdc-signals.json` from the WPRDC CKAN datastore
 * (City of Pittsburgh Signalized Intersections, CC BY). Run from `server/`:
 *
 *   npx tsx data/fetch-wprdc.ts
 *
 * The bundled file is what `/api/route` reads; this script is only for a
 * refresh, never called at request time. Column names verified on download:
 * `id`, `description`, `operation_type`, `latitude`, `longitude`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESOURCE_ID = '79ddcc74-33d2-4735-9b95-4169c7d0413d';
const DATASET = 'https://data.wprdc.org/dataset/city-of-pittsburgh-signalized-intersections';
const API = `https://data.wprdc.org/api/3/action/datastore_search?resource_id=${RESOURCE_ID}&limit=5000`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wprdc-signals.json');

interface CkanRow { [k: string]: unknown }

async function main(): Promise<void> {
  const res = await fetch(API, { headers: { Accept: 'application/json', 'User-Agent': 'Aisle/0.1 (SteelHacks)' } });
  if (!res.ok) throw new Error(`WPRDC ${res.status}`);
  const json = (await res.json()) as { success: boolean; result?: { records?: CkanRow[]; fields?: Array<{ id: string }> } };
  const records = json.result?.records ?? [];
  if (!json.success || records.length === 0) throw new Error('WPRDC returned no records');
  const rows = records.map((r) => ({
    id: String(r.id ?? r._id ?? ''),
    description: String(r.description ?? ''),
    operation_type: typeof r.operation_type === 'string' && r.operation_type.trim() ? r.operation_type.trim() : null,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
  }));
  const file = {
    source: 'WPRDC — City of Pittsburgh Signalized Intersections',
    dataset: DATASET,
    resourceId: RESOURCE_ID,
    license: 'Creative Commons Attribution (CC BY)',
    fetchedAt: new Date().toISOString().slice(0, 10),
    fields: ['id', 'description', 'operation_type', 'latitude', 'longitude'],
    rowCount: rows.length,
    rows,
  };
  await fs.writeFile(OUT, JSON.stringify(file, null, 0).replace(/\{"id"/g, '\n{"id"'), 'utf8');
  process.stdout.write(`wrote ${rows.length} rows to ${OUT}\n`);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
