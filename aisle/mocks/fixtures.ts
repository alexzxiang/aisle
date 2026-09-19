/**
 * Static imports of every fixture the mocks replay. Metro needs literal paths, so
 * this barrel is the one place the fixture file list lives.
 */
import type { PlannerJob, VisionQuestion } from '../src/core/contracts';
import trackJson from '../fixtures/track.json';
import perceptionIndex from '../fixtures/perception/index.json';
import framesIndex from '../fixtures/frames/index.json';
import storeJson from '../fixtures/stores/demo-store-01.json';
import crossingsJson from '../fixtures/crossings/demo.json';

import visionStorefront from '../fixtures/vision/storefront.json';
import visionAisle from '../fixtures/vision/aisle_disambiguate.json';
import visionScanLeft from '../fixtures/vision/scan_left.json';
import visionScanRight from '../fixtures/vision/scan_right.json';
import visionCurb from '../fixtures/vision/curb_crop.json';
import visionHand from '../fixtures/vision/hand_guidance.json';
import visionFree from '../fixtures/vision/free.json';

import planRoute from '../fixtures/plan/routeCompile.json';
import planIntent from '../fixtures/plan/parseIntent.json';
import planDisambiguate from '../fixtures/plan/disambiguate.json';
import planCrossing from '../fixtures/plan/crossingAnnounce.json';
import planAnswer from '../fixtures/plan/answer.json';

import type { FrameEntry } from './perception';
import type { PlanFixtureFile } from './planner';
import type { VisionFixtureFile } from './semanticVision';
import { type TrackFixture, asTrackFixture } from './track';

export const track: TrackFixture = asTrackFixture(trackJson);
export const perceptionPacks: Record<string, string> = perceptionIndex as Record<string, string>;
export const frames: Record<string, FrameEntry> = framesIndex as Record<string, FrameEntry>;
export const storeMap = storeJson;
export const crossings = crossingsJson;

export const visionFixtures: Record<VisionQuestion, VisionFixtureFile> = {
  storefront: visionStorefront as VisionFixtureFile,
  aisle_disambiguate: visionAisle as VisionFixtureFile,
  scan_left: visionScanLeft as VisionFixtureFile,
  scan_right: visionScanRight as VisionFixtureFile,
  curb_crop: visionCurb as VisionFixtureFile,
  hand_guidance: visionHand as VisionFixtureFile,
  free: visionFree as VisionFixtureFile,
};

export const planFixtures: Record<PlannerJob, PlanFixtureFile> = {
  routeCompile: planRoute as PlanFixtureFile,
  parseIntent: planIntent as PlanFixtureFile,
  disambiguate: planDisambiguate as PlanFixtureFile,
  crossingAnnounce: planCrossing as PlanFixtureFile,
  answer: planAnswer as PlanFixtureFile,
};
