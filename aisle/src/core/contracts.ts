/**
 * Aisle — shared contracts.
 *
 * This file is the TypeScript rendering of `01-SHARED-CONTRACTS.md` (FROZEN).
 * Types only: no implementation logic lives here. Every name and field is
 * verbatim from 01; anything that differs from 01 is a bug, not a decision.
 * A change here is flagged in the shared channel, acked by every consumer,
 * and landed together with the edit to 01 in one commit.
 *
 * Section numbers below match 01.
 */

// ---------------------------------------------------------------------------
// 1. App state machine
// ---------------------------------------------------------------------------

export type AppMode =
  | 'IDLE'               // pre-task, awaiting item request
  | 'ONBOARDING'         // disclaimer + haptic/beacon tutorial
  | 'OUTDOOR_NAV'        // walking a route leg
  | 'APPROACH_CROSSING'  // mapped crossing within ~25 m on the route
  | 'AT_CURB'            // stopped at the curb; aligning; reading the signal / scanning
  | 'CROSSING'           // moving along the crossing bearing
  | 'TRANSITION'         // store-entry handoff in progress
  | 'INDOOR_NAV'         // navigating to the target aisle
  | 'AT_ITEM'            // arrived at the target aisle
  | 'ITEM_PICKUP'        // stretch: hand guidance to the package
  | 'CHECKOUT_NAV'       // navigating to checkout
  | 'DONE'
  | 'GUIDED_TASK';     // goal-directed step guidance anywhere (home, street, store): IDLE → GUIDED_TASK → DONE

/*
Legal transitions only:

  IDLE → ONBOARDING → OUTDOOR_NAV
  OUTDOOR_NAV → APPROACH_CROSSING → AT_CURB → CROSSING → OUTDOOR_NAV   (repeats per crossing)
  APPROACH_CROSSING → OUTDOOR_NAV                                        (route re-plan, crossing dropped)
  OUTDOOR_NAV → TRANSITION → INDOOR_NAV → AT_ITEM → CHECKOUT_NAV → DONE
  AT_ITEM → ITEM_PICKUP → CHECKOUT_NAV                                   (stretch beat)
  * → IDLE                                                               (abort)

`CROSSED` is not a mode: `FAR_CURB_REACHED` (§5) returns the machine to `OUTDOOR_NAV`.
Any agent may read mode; only Agent A's store may write it, via `setMode()`.
*/

// ---------------------------------------------------------------------------
// 2. HapticService (Agent A implements)
// ---------------------------------------------------------------------------

export type HapticPattern =
  | 'TURN'      // rising triple pulse — "rotate now" (spoken turn is followed by this)
  | 'STOP'      // one long sharp buzz — vehicle approach or hard obstacle ONLY
  | 'CONFIRM'   // soft single tap — acknowledged / arrived / re-aligned after a turn
  | 'LISTEN'    // round 9: medium tap then a light one — the microphone is live, speak now
  | 'SENT';     // round 9: success notification — released, heard, being understood

export type CompassAccuracy = 0 | 1 | 2 | 3;   // expo-location tiers; 3 = < 20° uncertainty

export interface CourseError {
  headingErrorDeg: number;     // signed, −180..180; + = user is pointed right of target bearing
  crossTrackM: number;         // signed metres off the leg / crossing line; + = right of line
  roadSide: 'LEFT' | 'RIGHT' | 'NONE';  // which side the roadway is on for this leg
  compassAccuracy: CompassAccuracy;
}

export interface HapticService {
  play(pattern: HapticPattern): void;

  /**
   * COURSE — the fourth pattern, run as a continuous service. Silence when on course.
   * Buzz rate and intensity rise with |headingErrorDeg| beyond the dead zone, or with
   * cross-track drift toward the roadway. Same rule on legs, at the curb, mid-crossing,
   * down an aisle. Polls getError at ≥ 10 Hz.
   */
  startCourse(getError: () => CourseError): void;
  stopCourse(): void;
}

// ---------------------------------------------------------------------------
// 3. SpeechService (Agent A implements)
// ---------------------------------------------------------------------------

export type SpeechPriority = 'CRITICAL' | 'NAV' | 'INFO';

export interface SpeechRequest {
  text: string;            // ≤ 12 words, numbers written as words ("twenty feet")
                           // except when cacheKey is on the long-phrase allow-list (`disclaimer`)
  priority: SpeechPriority;
  cacheKey?: string;       // plays assets/audio/<cacheKey>.mp3 locally — 0 ms network
  dedupeKey?: string;      // suppresses a repeat within cooldownMs
  cooldownMs?: number;     // default 8000
  interrupt?: boolean;     // CRITICAL only
  /** Round 17: a live-text hazard line ("Chair ahead, close. Stop.") declares its class so CRITICAL may carry it. */
  hazardClass?: 'obstacle';
  /** Fifteen-word limit only in GUIDED_TASK for model exploration narration. */
  searchNarration?: boolean;
}

export interface SpeechService {
  say(req: SpeechRequest): void;
  /** Play audio already streaming from the proxy (§8 streaming contract). Same queue. */
  playStream(streamId: string, priority: SpeechPriority): void;
  clearQueue(priority?: SpeechPriority): void;
  isSpeaking(): boolean;
  setRate(rate: number): void;   // expo-audio playbackRate with pitch correction, 0.8–1.6
}

/**
 * Cache keys every agent may use (Agent A generates the files; text is canonical).
 * Kept here as a type so a typo in a `cacheKey` is a compile error.
 */
export type CacheKey =
  | 'disclaimer' | 'compass_uncertain' | 'crossing_ahead_signalized' | 'push_button_likely'
  | 'walk_signal_on' | 'walk_already_on_wait' | 'dont_walk' | 'countdown' | 'cant_see_signal'
  | 'vehicle_left' | 'vehicle_right' | 'vehicle_ahead' | 'far_curb' | 'no_signal_point_left' | 'now_right'
  | 'no_vehicles_left' | 'no_vehicles_right' | 'listen_then_cross' | 'vehicle_approaching_left'
  | 'vehicle_approaching_right' | 'cant_see_well_left' | 'cant_see_well_right'
  | 'turn_left_soon' | 'turn_right_soon' | 'turn_left_now' | 'turn_right_now' | 'entering_store'
  | 'keep_going' | 'passed_it_turn_around' | 'checkout_ahead' | 'obstacle_ahead' | 'tilt_camera_up'
  | 'turn_left_a_little' | 'turn_right_a_little' | 'reach_out' | 'higher' | 'lower' | 'left' | 'right'
  | 'touching' | 'ask_staff' | 'offline_notice' | 'reach_forward';

// ---------------------------------------------------------------------------
// 4. SensorService (Agent A implements; pose comes from Agent C's module)
// ---------------------------------------------------------------------------

export interface GeoFix {
  lat: number;
  lng: number;
  accuracyM: number;        // Apple: ~63–68 % bound, not a hard radius
  courseDeg: number | null; // GPS course over ground, null when speed < 0.5 m/s
  speedMps: number | null;
  timestamp: number;
}

export interface HeadingSample {
  trueHeadingDeg: number;   // 0–359 true north (expo-location watchHeadingAsync)
  accuracy: CompassAccuracy;
  timestamp: number;
}

export type TrackingState = 'NOT_AVAILABLE' | 'LIMITED' | 'NORMAL';

export interface Pose {
  /** Changes whenever native ARKit resets its coordinate origin. */
  worldSessionId?: string;
  pitchDeg?: number;
  /** Sparse measured world points, bounded by the native emitter. */
  mappingPoints?: Array<{ x: number; y: number; z: number }>;
  yawDeg: number;           // ARKit world yaw, gravityAndHeading aligned (0 = true north)
  x: number; y: number; z: number;   // metres in the ARKit world frame
  trackingState: TrackingState;
  timestamp: number;
}

export interface SensorService {
  subscribeHeading(cb: (h: HeadingSample) => void): () => void;
  subscribeLocation(cb: (fix: GeoFix) => void): () => void;
  subscribeSteps(cb: (stepsSinceStart: number) => void): () => void;
  subscribePose(cb: (p: Pose) => void): () => void;          // re-emitted from PerceptionService
  getHeading(): HeadingSample | null;
  getFusedHeadingDeg(): number | null;   // ARKit yaw corrected by trueHeading; null when both bad
  getLastFix(): GeoFix | null;
  getStepsSince(timestamp: number): number;
  /** "Walk straight for five seconds": trueHeading vs GPS course while speed > 0.5 m/s. */
  calibrateBodyOffset(): Promise<{ offsetDeg: number; ok: boolean }>;
  /** The producer for HapticService.startCourse. Fuses heading, dead reckoning, GPS
   *  cross-track and (when present) the perception module's lateral offset. */
  courseErrorFor(target: {
    /** The bearing to hold. A getter lets the reference follow a curving leg's tangent,
     *  read fresh each poll, without restarting COURSE (a fixed number is the constant case). */
    bearingDeg: number | (() => number);
    line?: Array<{ lat: number; lng: number }>;
    roadSide: 'LEFT' | 'RIGHT' | 'NONE';
  }): () => CourseError;
}

// ---------------------------------------------------------------------------
// 5. Event bus (Agent A implements, everyone emits/subscribes)
// ---------------------------------------------------------------------------

export type TaskContext = 'home' | 'store' | 'classroom' | 'street' | 'unknown';
export type Direction = 'LEFT' | 'CENTER' | 'RIGHT';
export type Side = 'LEFT' | 'RIGHT';
export type SignalState = 'WALK' | 'DONT_WALK' | 'COUNTDOWN' | 'UNKNOWN';
export type DistanceClass = 'NEAR' | 'MID' | 'FAR';          // < 1 m, 1–2.5 m, > 2.5 m (relative depth)
export type HazardKind = 'PERSON_AHEAD' | 'CART_AHEAD';       // indoor, INFO priority
export type TransitionReason = 'FUSED' | 'MANUAL';
export type CameraDirection = 'up' | 'down' | 'left' | 'right' | 'closer' | 'none';
export type UserAction = 'none' | 'turn_left' | 'turn_right' | 'walk_forward' | 'stop' | 'reach';
export type HandHint = 'left' | 'right' | 'higher' | 'lower' | 'forward' | 'touching' | 'not_seen';   // 'forward' (round 6c): reach further
export type VehiclesSeen = 'none' | 'distant' | 'approaching' | 'unclear';

export type AppEvent =
  // task and routing
  | { type: 'ITEM_REQUESTED'; item: string; source: 'voice' | 'keyboard' | 'mock' }
  | { type: 'ROUTE_READY'; legCount: number; destName: string; crossingCount: number }
  | { type: 'OUTDOOR_LEG_ADVANCED'; index: number; instruction: string }
  // crossings
  | { type: 'CROSSING_AHEAD'; crossingId: string; street: string; signalized: boolean | null;
      pushButtonLikely: boolean; bearingDeg: number; distanceM: number }
  | { type: 'CURB_REACHED'; crossingId: string }
  | { type: 'SIGNAL_STATE'; state: SignalState; fresh: boolean; confidence: number }
  | { type: 'VEHICLE_APPROACHING'; direction: Direction; trackId: number }
  | { type: 'SCAN_RESULT'; side: Side; vehiclesSeen: VehiclesSeen; source: 'detector' | 'claude' }
  | { type: 'CROSSING_STARTED'; crossingId: string }
  | { type: 'FAR_CURB_REACHED'; crossingId: string }
  | { type: 'CROSSING_ABORTED'; crossingId: string; reason: 'user' | 'walked_past' | 'replan' }  // B; AT_CURB / CROSSING → OUTDOOR_NAV (01 §1 post-review)
  | { type: 'DESTINATION_REQUESTED'; name: string; source: 'voice' | 'keyboard' | 'mock' }  // "take me to CVS": A resolves a place, trip runs destination-only
  | { type: 'TASK_REQUESTED'; goal: string; context: TaskContext; source: 'voice' | 'keyboard' | 'mock' }  // "eggs in my fridge": guided steps
  | { type: 'TASK_STEP'; index: number; total: number; instruction: string }
  | { type: 'TASK_COMPLETED'; goal: string }
  // course keeping (all modes)
  | { type: 'COURSE_DEVIATION'; meters: number; side: Side }
  | { type: 'OBSTACLE_AHEAD'; distanceClass: DistanceClass; direction: Direction }
  | { type: 'HAZARD'; kind: HazardKind; direction: Direction }
  // transition and indoor
  | { type: 'STORE_ENTERED'; reason: TransitionReason; confidence: number }
  | { type: 'AISLE_IDENTIFIED'; aisleId: string; label: string; confidence: number;
      source: 'ocr' | 'claude' }
  | { type: 'TARGET_AISLE_REACHED'; aisleId: string; side: Side }
  | { type: 'CHECKOUT_REACHED' }
  // active perception (Tier 1)
  | { type: 'CAMERA_REQUEST'; direction: CameraDirection }
  | { type: 'USER_ACTION'; action: UserAction }
  | { type: 'ITEM_HAND_GUIDANCE'; hint: HandHint; step: number }
  // system
  | { type: 'ERROR'; scope: string; message: string };

export type AppEventType = AppEvent['type'];

export interface EventBus {
  emit(e: AppEvent): void;
  on<T extends AppEvent['type']>(
    type: T,
    cb: (e: Extract<AppEvent, { type: T }>) => void
  ): () => void;
}

// ---------------------------------------------------------------------------
// 6. Store map schema (Agent C owns the format, Agent D produces fixtures)
// ---------------------------------------------------------------------------

export interface StoreMap {
  storeId: string;
  displayName: string;
  entrance: { lat: number; lng: number; radiusM: number; pinnedBy: string; pinnedAt: string };
  signHeightM?: number;
  aisles: Array<{ id: string; label: string; spokenLabel: string; signText: string[];
                 order: number; categories: string[] }>;
  landmarks: Array<{ id: string; label: string; spokenLabel: string; signText: string[];
                     afterAisleOrder: number }>;
  itemIndex: Record<string, { aisleId: string; sideWhenAscending: Side; shelf?: string; packageHint?: string }>;
}

// ---------------------------------------------------------------------------
// 7. PerceptionService (Agent C implements — JS side of the native PerceptionModule)
// ---------------------------------------------------------------------------

export type ModeProfile =
  | 'IDLE' | 'OUTDOOR_NAV' | 'APPROACH_CROSSING' | 'CROSSING' | 'INDOOR_NAV' | 'ITEM_PICKUP'
  | 'AWARE';   // round 6c: the home screen — camera up for awareness at all-day rates
  // AT_CURB uses the APPROACH_CROSSING profile; TRANSITION uses OUTDOOR_NAV.

/** Safety classes (vehicles, people, carts, signal heads) plus the scenery classes the room needs (round 6). */
export const SAFETY_DETECTION_CLASSES = ['car', 'bus', 'truck', 'motorcycle', 'bicycle', 'person', 'cart', 'ped_walk', 'ped_hand', 'ped_countdown'] as const;
/** Round 7: the user's own hand / arm — never a hazard, never "a person ahead". */
export const SELF_DETECTION_CLASSES = ['hand'] as const;
/** Round 6b: food and kitchen things. */
export const FOOD_DETECTION_CLASSES = ['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'pizza', 'donut', 'cake', 'wine_glass', 'fork', 'knife', 'spoon', 'remote', 'keyboard', 'cell_phone', 'toaster', 'vase', 'scissors', 'teddy_bear', 'toothbrush', 'hair_drier', 'mouse', 'tie'] as const;
/** Round 9: what a home is made of, and the small things people ask for — from the Open Images detector (`oiv7-yolo-nano`, alternate frames indoors). */
export const HOME_DETECTION_CLASSES = [
  'pastry', 'basket', 'strawberry', 'watermelon', 'grapefruit',
  'cheese', 'cream', 'dairy', 'seafood', 'pasta', 'juice', 'ice_cream', 'cucumber', 'pepper', 'grape', 'lemon', 'pear', 'peach', 'food_container',
  'door', 'door_handle', 'countertop', 'cabinet', 'drawer', 'light_switch', 'stairs', 'shelf', 'window', 'mirror', 'pillow', 'towel',
  'trash_can', 'lamp', 'plate', 'mug', 'kettle', 'can', 'box', 'egg', 'milk', 'bread', 'glasses', 'shoe', 'washing_machine', 'dishwasher',
  'bathtub', 'shower', 'faucet', 'desk', 'stool', 'nightstand', 'wardrobe', 'headphones', 'watch', 'wheelchair', 'street_light',
  'traffic_sign', 'parking_meter', 'curtain', 'monitor', 'printer', 'fireplace', 'ladder', 'pan', 'stove', 'cutting_board', 'soap',
  'candle', 'tree', 'bag', 'tomato', 'potato', 'fruit', 'vegetable', 'snack', 'tablet', 'pen', 'coin',
] as const;
export const SCENE_DETECTION_CLASSES = [...FOOD_DETECTION_CLASSES, 'chair', 'couch', 'bed', 'table', 'tv', 'laptop', 'fridge', 'oven', 'microwave', 'sink', 'toilet', 'bottle', 'cup', 'bowl', 'plant', 'book', 'clock', 'dog', 'cat', 'backpack', 'handbag', 'suitcase', 'umbrella', 'traffic_light', 'stop_sign', 'hydrant', 'bench', ...HOME_DETECTION_CLASSES] as const;
export const DETECTION_CLASSES = [...SAFETY_DETECTION_CLASSES, ...SELF_DETECTION_CLASSES, ...SCENE_DETECTION_CLASSES] as const;
export type DetectionClass = (typeof DETECTION_CLASSES)[number];

export interface Detection {
  cls: DetectionClass;
  box: [x: number, y: number, w: number, h: number];  // normalized 0..1, upright frame
  score: number;
  trackId: number;
  /** Relative nearness at the box centre from the depth grid, 0 far … 1 near; absent when no fresh depth. */
  near?: number;
}

/** Round 7: the user's own hand from Vision hand pose, normalized upright coordinates (origin top-left). */
export interface HandPoseEvent {
  tipX: number; tipY: number;      // index fingertip
  wristX: number; wristY: number;
  box: [x: number, y: number, w: number, h: number];
  confidence: number;
  timestamp: number;
  /** Round 9: depth-grid nearness at the fingertip (0 far … 1 near), when the grid was fresh. */
  near?: number;
}

export interface SceneClassEvent {
  labels: Array<{ id: string; confidence: number }>;   // VNClassifyImageRequest identifiers, best first
  timestamp: number;
}

export interface OcrRead {
  text: string;           // raw, upper band only
  box: [number, number, number, number];
  confidence: number;
  timestamp: number;
}

export interface DepthSummary {
  source?: 'lidar';
  pathMeters?: [number, number, number]; // portrait left/center/right, high-confidence LiDAR only
  centerBottomRel: number;   // relative depth 0..1 (1 = nearest) in the centre-bottom cell
  closingRate: number;       // d(rel)/dt, positive = approaching
  timestamp: number;
  leftBottomRel?: number;    // round 6b: the bottom-left / bottom-right cells, for "open to your left"
  rightBottomRel?: number;
}

/** Long edge: 512 scans, 640 signs/labels, 768 legacy room, 1024 curb crop, 1280 full-scene exploration. */
export type SnapshotWidth = 512 | 640 | 768 | 1024 | 1280;

export interface Snapshot {
  base64: string; width: number; height: number; seq: number; timestamp: number;
}

export interface PerceptionService {
  start(profile: ModeProfile): Promise<void>;
  setProfile(profile: ModeProfile): void;
  stop(): void;

  // context the native filters need (set by B / A / C-indoor; null clears)
  setCrossingBearing(bearingDeg: number | null): void;   // arms the signal gate + onset tracking; NOT a scan-side setter (§5)
  setCourseReference(ref: { bearingDeg: number } | null): void;  // anchors pose-derived drift at the current pose
  setBodyOffsetDeg(offsetDeg: number): void;             // from SensorService.calibrateBodyOffset
  setKnownSigns(words: string[]): void;                  // OCR customWords from the store map

  onSignalState(cb: (e: { state: SignalState; fresh: boolean; confidence: number; nOfM: number }) => void): () => void;
  onVehicleApproaching(cb: (e: { direction: Direction; trackId: number; growth: number }) => void): () => void;
  onObstacleAhead(cb: (e: { distanceClass: DistanceClass; direction: Direction }) => void): () => void;
  onHazard(cb: (e: { kind: HazardKind; direction: Direction }) => void): () => void;   // indoor person / cart
  onOcrText(cb: (reads: OcrRead[]) => void): () => void;
  onDetections(cb: (d: Detection[]) => void): () => void;        // ≤ 5 Hz, for DebugPanel + facts
  onPose(cb: (p: Pose) => void): () => void;                    // 10 Hz
  onLateralOffset(cb: (e: { offsetM: number; source: 'pose' | 'ocr_box' | 'shelf' | 'curb' | 'none' }) => void): () => void;
  onPlanes(cb: (e: { floors: number; verticals: number }) => void): () => void;  // 1 Hz
  onDepth(cb: (d: DepthSummary) => void): () => void;           // ≤ 5 Hz
  onTrackingState(cb: (s: TrackingState) => void): () => void;
  /** Round 6: Apple's on-device scene classifier, top labels at ≤ 2 Hz ("kitchen 0.71", "refrigerator 0.4"). */
  onSceneClass(cb: (e: SceneClassEvent) => void): () => void;
  /** Round 7: the user's own hand, ≤ 10 Hz while a hand is being steered. */
  onHandPose(cb: (e: HandPoseEvent) => void): () => void;

  snapshotJPEG(maxWidth: SnapshotWidth): Promise<Snapshot>;  // upright, EXIF baked in
  getTrackingState(): TrackingState;
  getStats(): { detectorFps: number; depthFps: number; ocrFps: number; frameToEventMs: number; thermalState: string };
  /** The native engine's own log lines (video format, model loads) — DebugPanel and Metro. Absent on mocks. */
  debugLog?(): string[];
}

// ---------------------------------------------------------------------------
// 8. SemanticVision (Agent C owns the schema; proxy route by Agent D) — Tier 1 Claude
// ---------------------------------------------------------------------------

export type VisionQuestion =
  | 'storefront' | 'aisle_disambiguate' | 'scan_left' | 'scan_right'
  | 'curb_crop' | 'hand_guidance' | 'free' | 'task_step' | 'situate';

/** `situate`: where the camera seems to be. Coarse on purpose; `label` carries the specifics. */
export type SceneSetting = 'street' | 'crossing' | 'entrance' | 'store' | 'home' | 'classroom' | 'kitchen' | 'hallway' | 'room' | 'vehicle' | 'unknown';
export const SCENE_SETTINGS: readonly SceneSetting[] = ['street', 'crossing', 'entrance', 'store', 'home', 'classroom', 'kitchen', 'hallway', 'room', 'vehicle', 'unknown'];

/** The awareness loop's state (situate.ts): what the app believes about where the user is. */
export interface SceneHypothesis {
  setting: SceneSetting;
  /** A place phrase: "in a kitchen", "on a sidewalk by a road"; the user's own words when `source` is 'user'. */
  label: string;
  confidence: number;
  /** True once the user answered yes or told the app where they are. */
  confirmed: boolean;
  source: 'camera' | 'user';
  at: number;
}

export interface VisionRequest {
  /** Fast observations only; never authoritative for task completion. */
  searchMode?: 'explore';
  seq: number;
  question: VisionQuestion;
  mode: AppMode;
  image?: { base64: string; width: number; height: number };  // 512×384 default; 640×480 when text must be read; omit when facts suffice
  facts: {                                  // on-device truth, sent as text
    detections: Detection[];
    ocr: string[];
    depth?: DepthSummary;
    signalState?: SignalState;
    headingDeg?: number;
    knownSigns?: string[];                  // aisle_disambiguate only
    targetItem?: string;                    // hand_guidance only
    sceneLabels?: string[];                 // round 6: Apple's scene classifier, "kitchen 0.71" … (≤ 8)
  };
  userText?: string;                        // 'free' only
}

// Response schema (field order is the contract — `speech` first so TTS can start when it closes)
export interface VisionResponse {
  /** Optional for older proxies; structured evidence for active item search. */
  search?: import('./searchObservation').SearchObservation;
  speech: string;                           // ≤ 12 words or "" ; never the forbidden words
  cameraRequest: CameraDirection;
  userAction: UserAction;
  aisle: { matchedAisleId: string | null; matchedLandmarkId: string | null; confidence: number };
  storefront: { visible: boolean; confidence: number };
  scan: { vehiclesSeen: VehiclesSeen; confidence: number };
  signal: { state: SignalState; confidence: number };      // curb_crop only; UNKNOWN unless confident
  hand: { hint: HandHint };                                 // hand_guidance only
  task: { done: boolean; confidence: number };              // task_step only: is the current step complete?
  target: { box: [x: number, y: number, w: number, h: number] | null; confidence: number }; // task_step / hand_guidance: where the step's target is in the still (round 7)
  scene: { setting: SceneSetting; label: string; confidence: number }; // situate only: label ≤ 5 words ("in a kitchen", "on a sidewalk")
  confidence: number;                                        // 0..1 overall; < 0.5 → callers ignore
  seq: number;
}

// ---------------------------------------------------------------------------
// 9. Planner (Agent B owns schemas; proxy route by Agent D) — Tier 2 Nemotron
// ---------------------------------------------------------------------------

export type PlannerJob = 'routeCompile' | 'parseIntent' | 'disambiguate' | 'crossingAnnounce' | 'answer' | 'taskPlan';

export interface PlannerResult<T> { job: PlannerJob; output: T; fallback: boolean; latencyMs: number }

// routeCompile — once at route fetch; B pre-synthesizes the variable phrases immediately
export interface RouteCompileInput {
  steps: Array<{ index: number; instruction: string; maneuver: string; distanceM: number; startBearingDeg: number }>;
  crossings: Array<{ crossingId: string; afterStep: number; street: string; signalized: boolean | null; pushButtonLikely: boolean; bearingDeg: number }>;
}
export interface RouteCompileOutput {
  legs: Array<{ index: number; soon: string; now: string; confirm: string }>;  // each ≤ 12 words, numbers as words
  crossingAnnouncements: Array<{ crossingId: string; text: string }>;         // "Crossing ahead: Forbes. Signalized."
}

// parseIntent — after push-to-talk STT
export interface ParseIntentInput { transcript: string; mode: AppMode; knownItems: string[] }
export interface ParseIntentOutput {
  intent: 'find_item' | 'navigate_to' | 'guided_task' | 'repeat' | 'how_far' | 'where_am_i' | 'abort' | 'help' | 'unknown';
  item: string | null;
  destination?: string | null;  // navigate_to: a place name ("CVS", "the library")
  goal?: string | null;         // guided_task: the goal in the user's words ("eggs in my fridge")
  reply: string;   // ≤ 12 words
}

// disambiguate — "dairy" vs "eggs" → aisle
export interface DisambiguateInput { item: string; storeMap: StoreMap }
export interface DisambiguateOutput { aisleId: string | null; confidence: number; askBack: string | null }

// crossingAnnounce — which OSM node is on the path, signalized?, push button likely?
export interface CrossingAnnounceInput {
  candidates: Array<{ nodeId: string; distToPolylineM: number; tags: Record<string, string>; wprdcOperationType?: string }>;
  street: string;
}
export interface CrossingAnnounceOutput { nodeId: string | null; signalized: boolean | null; pushButtonLikely: boolean; text: string }

// answer — "repeat / how far / where am I", re-plan after a missed turn
export interface AnswerInput { question: 'repeat' | 'how_far' | 'where_am_i' | 'replan'; context: Record<string, unknown> }
export interface AnswerOutput { reply: string }   // ≤ 12 words

// taskPlan — a goal in the user's words → 3–8 spoken steps for the guided-task loop
export interface TaskPlanInput {
  goal: string;
  context: TaskContext;
  facts?: {
    detections: string[];
    ocr: string[];
    /** The awareness loop's place label ("in a kitchen by a refrigerator"). */
    scene?: string;
    /** What the camera described just now ("Kitchen counter ahead, fridge on your left."). */
    description?: string;
  };
}
export interface TaskPlanOutput {
  askFirst: string;                                        // ≤ 12 words, e.g. "Let me see your surroundings."
  steps: Array<{ instruction: string; lookFor: string }>;  // instruction ≤ 12 words; lookFor = what the camera should confirm
}

// ---------------------------------------------------------------------------
// 10. CrossingController (Agent B) and TransitionDetector (Agent D)
// ---------------------------------------------------------------------------

export interface Crossing {
  crossingId: string; street: string; signalized: boolean | null; pushButtonLikely: boolean;
  bearingDeg: number; nearCurb: { lat: number; lng: number }; farCurb: { lat: number; lng: number };
  roadSide: Side;
}

export interface CrossingController {
  arm(c: Crossing): void;               // on CROSSING_AHEAD; runs approach announcement once at ~25 m
  curbReached(): void;                  // → AT_CURB: TURN + COURSE to bearingDeg; ticker on; speech policy narrows
  signalUpdate(e: { state: SignalState; fresh: boolean }): void;   // from PerceptionService; owns the phrase choice
  startUnsignalizedScan(): Promise<void>;   // left scan → right scan → 2 s pause → perception report
  crossingStarted(): void;              // → CROSSING: beacon to farCurb, COURSE holds bearing
  farCurbReached(): void;               // CONFIRM, beacon off, → OUTDOOR_NAV
  setManualSignal(state: SignalState | null): void;   // DebugPanel rung 4 — always wired
  abort(reason?: 'user' | 'walked_past' | 'replan'): void;   // emits CROSSING_ABORTED → OUTDOOR_NAV (§1)
}

export interface TransitionSignals {
  distanceMinThenRise: number;   // 0 | 0.3
  accuracyStepUp: number;        // 0 | 0.3
  stepsSinceMin: number;         // 0 | 0.2  (≥ 15 steps)
  storefrontFrame: number;       // 0 | 0.2  (one Tier-1 positive, ≤ 1 call / 5 s)
  ambientLight: number;          // bonus, Android only
}

export interface TransitionSignal {
  reason: TransitionReason;
  confidence: number;            // sum of TransitionSignals, fire at ≥ 0.6
  signals: TransitionSignals;
  detectedAt: number;
}

export interface TransitionDetector {
  start(dest: { lat: number; lng: number; radiusM: number }): void;
  stop(): void;
  onEnter(cb: (s: TransitionSignal) => void): () => void;   // fires once; 10 s debounce
  forceEnter(): void;                                        // manual override — always wire this up
}
