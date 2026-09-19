/**
 * Express composition. D's routes (vision, tts, stt, health) mount directly; B's
 * routes (`./routes/plan`, `./routes/route`) are B's files — mounted behind a
 * try/catch dynamic import so the server still boots when they are absent, and
 * never created or overwritten here.
 */
import express, { type Express, type Router } from 'express';
import type { AppDeps } from './deps';
import { info, warn } from './lib/log';
import { createHealthRouter } from './routes/health';
import { createSttRouter } from './routes/stt';
import { createTtsRouter } from './routes/tts';
import { createVisionRouter } from './routes/vision';

export const JSON_LIMIT = '6mb'; // a 1024×768 JPEG at q0.8 is ~150–300 kB base64; 6 MB is generous headroom

export interface CreateAppOptions {
  deps: AppDeps | (() => Promise<AppDeps>);
  /** Loaders for B's routers; default imports the real files. Tests pass fakes or none. */
  externalRoutes?: Array<{ mount: string; load: () => Promise<{ default: Router }> }>;
}

export const DEFAULT_EXTERNAL_ROUTES: CreateAppOptions['externalRoutes'] = [
  { mount: '/api/plan', load: () => import('./routes/plan') as Promise<{ default: Router }> },
  { mount: '/api/route', load: () => import('./routes/route') as Promise<{ default: Router }> },
];

export interface MountedApp {
  app: Express;
  /** Which of B's routes were mounted (for the boot log and /api/health consumers). */
  external: Record<string, boolean>;
}

export async function createApp(opts: CreateAppOptions): Promise<MountedApp> {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: JSON_LIMIT }));

  app.get('/', (_req, res) => {
    res.json({ name: 'aisle-proxy', routes: ['/api/vision', '/api/plan', '/api/tts', '/api/stt', '/api/route', '/api/health', '/ws'] });
  });

  app.use('/api/vision', createVisionRouter(opts.deps));
  app.use('/api/tts', createTtsRouter(opts.deps));
  app.use('/api/stt', createSttRouter(opts.deps));
  app.use('/api/health', createHealthRouter(opts.deps));

  const external: Record<string, boolean> = {};
  for (const ext of opts.externalRoutes ?? DEFAULT_EXTERNAL_ROUTES ?? []) {
    try {
      const mod = await ext.load();
      if (!mod || typeof mod.default !== 'function') throw new Error('no default Router export');
      app.use(ext.mount, mod.default);
      external[ext.mount] = true;
      info('mounted external route', { mount: ext.mount });
    } catch (e) {
      external[ext.mount] = false;
      warn('external route not mounted (B\'s file absent or failed to load); answering 503 there', {
        mount: ext.mount,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      });
      app.use(ext.mount, (_req, res) => {
        res.status(503).json({ error: `${ext.mount} is not available in this build`, fallback: true });
      });
    }
  }

  // JSON body errors and anything a route threw synchronously.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
    res.status(status).json({ error: status === 500 ? 'internal error' : (err as Error).message });
  });

  return { app, external };
}
