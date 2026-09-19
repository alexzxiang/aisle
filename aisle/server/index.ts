/**
 * Aisle proxy entry point (05 Part 2): one Node 20+ process, HTTP + WebSocket on the
 * same port, keys from server/.env (dotenv) or the host's secret store. Hosted in
 * us-east; the same process runs locally with `npm run dev` bound to 0.0.0.0:8787
 * for the hotspot/LAN fallback.
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app';
import { loadConfig, missingKeys } from './config';
import { createDefaultDeps } from './deps';
import { warmOverpassArea } from './routes/crossings';
import { info, warn } from './lib/log';
import { attachVisionSocket } from './ws/visionSocket';

async function main(): Promise<void> {
  const config = loadConfig();
  const missing = missingKeys();
  if (missing.length) warn('missing keys — the matching upstreams will report red in /api/health', { missing });

  const deps = await createDefaultDeps({ config });
  const { app, external } = await createApp({ deps });
  const server = createServer(app);
  attachVisionSocket(server, deps, { path: '/ws' });

  server.listen(config.port, config.host, () => {
    info('aisle-proxy listening', { host: config.host, port: config.port, region: config.region, external });
  });

  if (config.warmupOnStart) {
    // Never block listen on the warm-up; a red pair is reported, not fatal.
    void deps.warmup.warmAll();
    deps.warmup.start();
    // Crossings for the demo area, once, with the full Overpass timeout (round 6c): every
    // route inside it is then served from memory instead of racing a flaky mirror.
    void warmOverpassArea().then((r) => info('overpass demo area warm', r)).catch(() => undefined);
  } else {
    info('warm-up skipped (WARMUP_ON_START=0)');
  }

  const shutdown = (): void => {
    deps.warmup.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  warn('fatal', { error: e instanceof Error ? e.stack ?? e.message : String(e) });
  process.exit(1);
});
