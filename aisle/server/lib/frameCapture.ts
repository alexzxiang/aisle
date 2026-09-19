/**
 * Opt-in capture of real vision frames for the vision eval (TEAM-PLAN v2 C2).
 *
 * The phone already sends every still with its on-device facts to the proxy, so a living-room
 * run can be recorded here instead of waiting on Stream A's session export. Off unless
 * CAPTURE_FRAMES=1: otherwise the proxy keeps no images, and a captured frame is a photo of
 * someone's home. Frames land in server/data/cache/frames (git-ignored), one JPEG and one JSON
 * per vision call. Nothing here is on the response path, and a failed write is dropped.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VisionQuestion, VisionRequest, VisionResponse } from '../../src/core/contracts';
import type { VisionCallResult, VisionHooks } from './anthropic';

export const FRAMES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cache', 'frames');

export interface CapturedFrame {
  id: string;
  at: string;
  question: VisionQuestion;
  mode: VisionRequest['mode'];
  userText: string | null;
  facts: VisionRequest['facts'];
  /** File name beside this JSON; null when the phone sent facts only. */
  image: { file: string; width: number; height: number } | null;
  model: string;
  totalMs: number;
  response: VisionResponse | null;
}

export type VisionFn = (req: VisionRequest, hooks: VisionHooks) => Promise<VisionCallResult>;

export interface FrameCapture {
  vision: VisionFn;
  /** Resolves once every save started so far has finished (tests, clean shutdown). */
  flush(): Promise<void>;
}

export function withFrameCapture(
  vision: VisionFn,
  opts: {
    dir?: string;
    now?: () => number;
    write?: (path: string, data: string | Buffer) => Promise<void>;
    mkdirp?: (dir: string) => Promise<unknown>;
  } = {},
): FrameCapture {
  const dir = opts.dir ?? FRAMES_DIR;
  const now = opts.now ?? Date.now;
  const write = opts.write ?? ((p, d) => writeFile(p, d));
  const mkdirp = opts.mkdirp ?? ((d) => mkdir(d, { recursive: true }));
  const pending = new Set<Promise<void>>();
  let ready: Promise<unknown> | null = null;
  let n = 0;

  const save = async (req: VisionRequest, result: VisionCallResult, id: string, at: string): Promise<void> => {
    ready ??= mkdirp(dir);
    await ready;
    const image = req.image ? { file: `${id}.jpg`, width: req.image.width, height: req.image.height } : null;
    if (req.image) await write(join(dir, image!.file), Buffer.from(req.image.base64, 'base64'));
    const frame: CapturedFrame = {
      id, at, question: req.question, mode: req.mode, userText: req.userText ?? null, facts: req.facts,
      image, model: result.model, totalMs: result.totalMs, response: result.response,
    };
    await write(join(dir, `${id}.json`), `${JSON.stringify(frame, null, 2)}\n`);
  };

  return {
    async vision(req, hooks) {
      const result = await vision(req, hooks);
      n += 1;
      const id = `${now()}-${req.seq}-${n}`;
      const p = save(req, result, id, new Date(now()).toISOString()).catch(() => undefined);
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return result;
    },
    async flush() {
      await Promise.all([...pending]);
    },
  };
}
