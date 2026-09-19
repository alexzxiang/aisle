/**
 * VisionRequest validation (01 §8, 05 Part 2): `question` against the enum, `mode`
 * against the state machine, image long edge ≤ 1024 (the phone already resized; a
 * 1280-wide upload is a bug), `seq` a non-negative integer. zod keeps the error
 * messages readable in the log.
 */
import { z } from 'zod';
import { DETECTION_CLASSES, type AppMode, type VisionQuestion, type VisionRequest } from '../../src/core/contracts';
import { MAX_IMAGE_LONG_EDGE } from './anthropic';

export const APP_MODES: readonly AppMode[] = [
  'IDLE', 'ONBOARDING', 'OUTDOOR_NAV', 'APPROACH_CROSSING', 'AT_CURB', 'CROSSING', 'TRANSITION',
  'INDOOR_NAV', 'AT_ITEM', 'ITEM_PICKUP', 'CHECKOUT_NAV', 'DONE', 'GUIDED_TASK',
];
export const VISION_QUESTIONS: readonly VisionQuestion[] = [
  'storefront', 'aisle_disambiguate', 'scan_left', 'scan_right', 'curb_crop', 'hand_guidance', 'free', 'task_step', 'situate',
];

const detection = z.object({
  cls: z.enum(DETECTION_CLASSES as unknown as [string, ...string[]]),
  near: z.number().min(0).max(1).optional(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  score: z.number(),
  trackId: z.number(),
});

const depth = z.object({
  centerBottomRel: z.number(), closingRate: z.number(), timestamp: z.number(),
  leftBottomRel: z.number().optional(), rightBottomRel: z.number().optional(),
});

export const visionRequestSchema = z.object({
  seq: z.number().int().nonnegative(),
  question: z.enum(VISION_QUESTIONS as [VisionQuestion, ...VisionQuestion[]]),
  mode: z.enum(APP_MODES as [AppMode, ...AppMode[]]),
  image: z
    .object({
      base64: z.string().min(16),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .refine((img) => Math.max(img.width, img.height) <= MAX_IMAGE_LONG_EDGE, { message: `image long edge must be ≤ ${MAX_IMAGE_LONG_EDGE}` })
    .optional(),
  facts: z.object({
    detections: z.array(detection).default([]),
    ocr: z.array(z.string()).default([]),
    depth: depth.optional(),
    signalState: z.enum(['WALK', 'DONT_WALK', 'COUNTDOWN', 'UNKNOWN']).optional(),
    headingDeg: z.number().optional(),
    knownSigns: z.array(z.string()).optional(),
    targetItem: z.string().optional(),
    sceneLabels: z.array(z.string().max(48)).max(8).optional(),
  }),
  userText: z.string().max(500).optional(),
});

export type ValidVisionRequest = z.infer<typeof visionRequestSchema>;

export interface ValidationOk { ok: true; req: VisionRequest }
export interface ValidationErr { ok: false; error: string; seq: number | null }

export function validateVisionRequest(body: unknown): ValidationOk | ValidationErr {
  const parsed = visionRequestSchema.safeParse(body);
  if (parsed.success) return { ok: true, req: parsed.data as VisionRequest };
  const seq = typeof (body as { seq?: unknown })?.seq === 'number' ? ((body as { seq: number }).seq) : null;
  const first = parsed.error.issues[0];
  const path = first?.path.join('.') ?? '';
  return { ok: false, error: `${path ? `${path}: ` : ''}${first?.message ?? 'invalid body'}`, seq };
}

/** A text-only request for the schema warm-up. */
export function emptyVisionRequest(question: VisionQuestion, seq = 0): VisionRequest {
  return { seq, question, mode: question === 'curb_crop' ? 'AT_CURB' : 'OUTDOOR_NAV', facts: { detections: [], ocr: [] } };
}
