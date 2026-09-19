/**
 * Record the `/api/route` response for the demo route (03 Task 9): the phone
 * receives `crossings[]`, the script and the warnings fully formed, and Agent
 * D's mock serves this file as `fixtures/route/demo.json`. Run from `server/`:
 *
 *   npx tsx data/record-demo-route.ts [originLat originLng destLat destLng storeId]
 *
 * With `GOOGLE_MAPS_API_KEY` / `NVIDIA_API_KEY` in the environment the route is
 * live (Google, Overpass, Nemotron); without them it is built from the recorded
 * Google and Overpass fixtures and the templated script, and `sources` says so.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import { createRequestLog } from '../lib/log';
import { buildRoute } from '../routes/route';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'fixtures', 'route-demo.json');

// Forbes Ave at Schenley Dr → the Forbes / S Bouquet crossing → pinned entrance (venue walk to confirm).
const DEFAULTS = { originLat: 40.4428803, originLng: -79.9546937, destLat: 40.4422747, destLng: -79.9570206, storeId: 'demo-store-01' };

async function main(): Promise<void> {
  const [a, b, c, d, id] = process.argv.slice(2);
  const q = {
    originLat: a ? Number(a) : DEFAULTS.originLat,
    originLng: b ? Number(b) : DEFAULTS.originLng,
    destLat: c ? Number(c) : DEFAULTS.destLat,
    destLng: d ? Number(d) : DEFAULTS.destLng,
    storeId: id ?? DEFAULTS.storeId,
  };
  const config = loadConfig();
  const log = createRequestLog({ sink: () => {} });
  const value = await buildRoute(q, { config, log, cacheDir: null, plan: { config, log } });
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${OUT}\n  legs=${value.legs.length} crossings=${value.crossings.length} sources=${JSON.stringify(value.sources)} planner=${JSON.stringify(value.planner)}\n`);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
