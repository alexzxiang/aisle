//
//  EngineChecks.swift
//  Aisle — PerceptionModule engine, 09 §10 unit checks
//
//  Synthetic-input checks for every filter, runnable on a Mac without a device
//  or an Xcode project: `modules/perception/tests/run.sh` compiles the ARKit-free
//  engine files with this file against the macOS SDK and runs `main`. Each check
//  prints PASS/FAIL; a non-zero exit means at least one failed.
//
//  Covered (09 §10 "Unit checks per filter"):
//    - Signal gate: off-strip, off-heading, off-centre boxes rejected; 4-of-8 is
//      UNKNOWN, 5-of-8 emits; onset: WALK-first → fresh:false, DONT_WALK→WALK →
//      fresh:true; COUNTDOWN never fresh; heartbeat 0.5 Hz.
//    - Vehicle looming: parked car never fires; 1.4× area in 0.5 s at age ≥ 0.3 s
//      fires once, then not for 4 s; yaw-sweep suppression; upper-third boxes
//      ignored; direction from centre x.
//    - Tracker: IoU association keeps ids; ids are monotonic; a track survives
//      5 missed frames and not 6.
//    - Depth: wall approach crosses FAR → MID → NEAR in order; NEAR + closing
//      emits once per 2 s; depth summary ≤ 5 Hz; shelf asymmetry sign.
//    - OCR: Vision box (bottom-left, ROI-relative) → upright full-frame box; the
//      text field is untouched; the blur gate skips a fast-yaw frame.
//    - Drift: straight track 0 ± 0.02 m; 0.5 m parallel offset reads 0.5 m; +
//      is right of the line; 5 Hz limiter; frozen → source none.
//    - Schedule: per-profile fps table; `.serious` halves; `.critical` keeps the
//      safety stage; frame-counter stride; IDLE pauses the session.
//    - Export: jsonl payloads carry the 01 §7 callback shapes D's replayer reads.
//

import CoreImage
import CoreVideo
import Foundation
import simd

// MARK: - Tiny harness

var failures = 0
var passes = 0

func check(_ name: String, _ condition: @autoclosure () -> Bool, _ detail: @autoclosure () -> String = "") {
  if condition() {
    passes += 1
    print("PASS  \(name)")
  } else {
    failures += 1
    let d = detail()
    print("FAIL  \(name)\(d.isEmpty ? "" : " — \(d)")")
  }
}

func approx(_ a: Double, _ b: Double, tol: Double) -> Bool { abs(a - b) <= tol }

func box(cx: Double, cy: Double, w: Double, h: Double) -> NormalizedBox {
  NormalizedBox(x: cx - w / 2, y: cy - h / 2, w: w, h: h)
}

func geometry(heading: Double, horizon: Double? = 0.40, yawRate: Double = 0, t: Double) -> FrameGeometry {
  FrameGeometry(bodyHeadingDeg: heading, horizonRow: horizon, yawRateDegPerSec: yawRate,
                trackingState: .normal, timestamp: t)
}

func det(_ cls: DetectionClass, cx: Double, cy: Double, w: Double = 0.06, h: Double = 0.10, score: Double = 0.9) -> DetectionPayload {
  DetectionPayload(cls: cls, box: box(cx: cx, cy: cy, w: w, h: h), score: score, trackId: -1)
}

// MARK: - Signal gate + vote + onset

func signalChecks() {
  let gate = SignalGate()
  let g = geometry(heading: 90, t: 0)

  // Not armed → nothing counts.
  let notArmed = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.40)], geometry: g, crossingBearingDeg: nil)
  check("gate: not armed rejects", notArmed.accepted == nil && notArmed.rejection == .notArmed)

  // Off heading (> 20° from the crossing bearing) → rejected even with a perfect box.
  let offHeading = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.40)], geometry: geometry(heading: 121, t: 0), crossingBearingDeg: 90)
  check("gate: heading 31° off is rejected", offHeading.rejection == .headingOff)
  let edgeHeading = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.40)], geometry: geometry(heading: 110, t: 0), crossingBearingDeg: 90)
  check("gate: heading 20° off is accepted", edgeHeading.accepted != nil)
  let wrapHeading = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.40)], geometry: geometry(heading: 350, t: 0), crossingBearingDeg: 5)
  check("gate: heading separation wraps across north", wrapHeading.accepted != nil)

  // Off the horizon strip (±12 % of frame height around the horizon row).
  let offStrip = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.70)], geometry: g, crossingBearingDeg: 90)
  check("gate: box 30 % below the horizon is off-strip", offStrip.rejection == .offHorizonStrip)
  let onStrip = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.51)], geometry: g, crossingBearingDeg: 90)
  check("gate: box 11 % below the horizon is on-strip", onStrip.accepted != nil)

  // Nearest the centre column wins; the parallel crosswalk's head at the edge is ignored.
  let two = gate.apply(detections: [det(.pedHand, cx: 0.10, cy: 0.40), det(.pedWalk, cx: 0.55, cy: 0.40)], geometry: g, crossingBearingDeg: 90)
  check("gate: nearest-centre box wins over an edge box", two.accepted?.cls == .pedWalk && two.candidateCount == 2)

  // Below the score floor → rejected.
  let weak = gate.apply(detections: [det(.pedWalk, cx: 0.5, cy: 0.40, score: 0.2)], geometry: g, crossingBearingDeg: 90)
  check("gate: score below the floor is rejected", weak.rejection == .belowScoreFloor)

  // 4-of-8 is UNKNOWN; 5-of-8 emits.
  var vote = SignalVote()
  vote.arm(at: 0)
  var emitted: [SignalStatePayload] = []
  var t = 0.0
  let walk = det(.pedWalk, cx: 0.5, cy: 0.40)
  for i in 0..<8 {
    t += 1.0 / 15.0
    if let r = vote.push(accepted: i < 4 ? walk : nil, at: t) { emitted.append(r.payload) }
  }
  check("vote: 4-of-8 stays UNKNOWN", emitted.allSatisfy { $0.state == .unknown }, "emitted \(emitted.map { $0.state.rawValue })")

  vote.arm(at: 0)
  emitted = []
  t = 0
  for i in 0..<8 {
    t += 1.0 / 15.0
    if let r = vote.push(accepted: i < 5 ? walk : nil, at: t) { emitted.append(r.payload) }
  }
  check("vote: 5-of-8 emits WALK with nOfM 5", emitted.contains { $0.state == .walk && $0.nOfM == 5 }, "emitted \(emitted.map { "\($0.state.rawValue)/\($0.nOfM)" })")

  // Onset: WALK first since arming → fresh:false.
  vote.arm(at: 0)
  emitted = []
  t = 0
  for _ in 0..<8 {
    t += 1.0 / 15.0
    if let r = vote.push(accepted: walk, at: t) { emitted.append(r.payload) }
  }
  let firstWalk = emitted.first { $0.state == .walk }
  check("onset: WALK already on when armed is fresh:false", firstWalk != nil && firstWalk!.fresh == false)

  // Onset: DONT_WALK → WALK observed → fresh:true.
  vote.arm(at: 0)
  emitted = []
  t = 0
  let hand = det(.pedHand, cx: 0.5, cy: 0.40)
  for _ in 0..<8 { t += 1.0 / 15.0; if let r = vote.push(accepted: hand, at: t) { emitted.append(r.payload) } }
  for _ in 0..<8 { t += 1.0 / 15.0; if let r = vote.push(accepted: walk, at: t) { emitted.append(r.payload) } }
  let sawDont = emitted.contains { $0.state == .dontWalk }
  let freshWalk = emitted.first { $0.state == .walk }
  check("onset: DONT_WALK → WALK is fresh:true", sawDont && freshWalk != nil && freshWalk!.fresh == true)

  // COUNTDOWN is never fresh.
  let count = det(.pedCountdown, cx: 0.5, cy: 0.40)
  for _ in 0..<8 { t += 1.0 / 15.0; if let r = vote.push(accepted: count, at: t) { emitted.append(r.payload) } }
  check("onset: COUNTDOWN is fresh:false", emitted.filter { $0.state == .countdown }.allSatisfy { !$0.fresh } && emitted.contains { $0.state == .countdown })

  // Heartbeat: a held state re-emits every 2 s, not every frame.
  vote.arm(at: 0)
  emitted = []
  t = 0
  var stamps: [Double] = []
  for _ in 0..<90 {   // 6 s at 15 fps
    t += 1.0 / 15.0
    if let r = vote.push(accepted: hand, at: t), r.payload.state == .dontWalk { stamps.append(t) }
  }
  var minGap = Double.infinity
  for i in 1..<stamps.count { minGap = min(minGap, stamps[i] - stamps[i - 1]) }
  check("heartbeat: DONT_WALK held re-emits at 0.5 Hz", stamps.count >= 2 && stamps.count <= 4 && minGap >= 2.0 - 1e-9, "stamps \(stamps)")

  // Whole detector: disarm resets; rearm keeps the bearing.
  let detector = SignalDetector()
  detector.setCrossingBearing(90, at: 0)
  check("detector: armed after setCrossingBearing", detector.isArmed && detector.crossingBearingDeg == 90)
  detector.setCrossingBearing(nil, at: 1)
  check("detector: nil disarms", !detector.isArmed)
  detector.setCrossingBearing(450, at: 2)
  check("detector: bearing wraps to 0..360", detector.crossingBearingDeg == 90)
  let outcome = detector.process(detections: [walk], geometry: geometry(heading: 90, t: 2.1))
  check("detector: one frame is not a state", outcome.reading == nil || outcome.reading?.payload.state == .unknown)
}

// MARK: - Tracker + looming + hazards

func trackerChecks() {
  var tracker = IoUTracker()
  let a = RawDetection(cls: .car, box: box(cx: 0.5, cy: 0.6, w: 0.10, h: 0.08), score: 0.9)
  let out1 = tracker.update([a], at: 0)
  let out2 = tracker.update([RawDetection(cls: .car, box: box(cx: 0.51, cy: 0.6, w: 0.10, h: 0.08), score: 0.9)], at: 1.0 / 15.0)
  check("tracker: overlapping boxes keep the id", out1.first?.trackId == out2.first?.trackId && out1.first?.trackId == 1)
  let out3 = tracker.update([RawDetection(cls: .person, box: box(cx: 0.51, cy: 0.6, w: 0.10, h: 0.08), score: 0.9)], at: 2.0 / 15.0)
  check("tracker: a different class never continues a track", out3.first?.trackId == 2)
  check("tracker: the unmatched frame counted as one miss", tracker.track(id: 1)?.missedFrames == 1)
  for _ in 0..<4 { _ = tracker.update([], at: 1) }
  check("tracker: survives 5 missed frames", tracker.track(id: 1) != nil && tracker.track(id: 1)?.missedFrames == 5)
  _ = tracker.update([], at: 1)
  check("tracker: dropped after 6 missed frames", tracker.track(id: 1) == nil)
  tracker.reset()
  let out4 = tracker.update([a], at: 3)
  check("tracker: ids stay monotonic across reset", (out4.first?.trackId ?? 0) > 2)

  // Looming — parked car (constant area) never fires over 5 s.
  var looming = LoomingFilter()
  var t = 0.0
  var parked = IoUTracker()
  var fired = 0
  for _ in 0..<75 {
    t += 1.0 / 15.0
    parked.update([RawDetection(cls: .car, box: box(cx: 0.3, cy: 0.6, w: 0.10, h: 0.08), score: 0.9)], at: t)
    if looming.evaluate(tracks: parked.tracks, yawRateDegPerSec: 0, at: t) != nil { fired += 1 }
  }
  check("looming: parked car never fires", fired == 0, "fired \(fired)")

  // Approaching: area grows 1.5× per 0.5 s; fires once at age ≥ 0.3 s, then not for 4 s.
  looming = LoomingFilter()
  var approach = IoUTracker()
  var events: [(t: Double, payload: VehicleApproachingPayload)] = []
  t = 0
  var side = 0.06
  for _ in 0..<90 {   // 6 s
    t += 1.0 / 15.0
    side *= pow(1.5, (1.0 / 15.0) / 0.5 / 2)   // area ×1.5 per 0.5 s (side grows by sqrt)
    let bottom = min(0.95, 0.55 + t * 0.03)
    approach.update([RawDetection(cls: .car, box: NormalizedBox(x: 0.75 - side / 2, y: bottom - side, w: side, h: side), score: 0.9)], at: t)
    if let p = looming.evaluate(tracks: approach.tracks, yawRateDegPerSec: 0, at: t) { events.append((t, p)) }
  }
  check("looming: approaching car fires", !events.isEmpty)
  check("looming: first fire after track age ≥ 0.3 s and ≥ 0.4 s of history", (events.first?.t ?? 0) >= 0.4, "first at \(events.first?.t ?? -1)")
  var gaps: [Double] = []
  for i in 1..<events.count { gaps.append(events[i].t - events[i - 1].t) }
  check("looming: same track waits 4 s between fires", gaps.allSatisfy { $0 >= 4.0 - 1e-9 }, "gaps \(gaps)")
  check("looming: growth > 1.4 reported and direction RIGHT from centre x", (events.first?.payload.growth ?? 0) > 1.4 && events.first?.payload.direction == .right)

  // Yaw sweep suppression: same approach, camera panning at 45°/s → nothing.
  looming = LoomingFilter()
  approach = IoUTracker()
  t = 0
  side = 0.06
  fired = 0
  for _ in 0..<45 {
    t += 1.0 / 15.0
    side *= pow(1.5, (1.0 / 15.0) / 0.5 / 2)
    approach.update([RawDetection(cls: .car, box: NormalizedBox(x: 0.45 - side / 2, y: 0.6, w: side, h: side), score: 0.9)], at: t)
    if looming.evaluate(tracks: approach.tracks, yawRateDegPerSec: 45, at: t) != nil { fired += 1 }
  }
  check("looming: yaw sweep at 45°/s suppresses", fired == 0, "fired \(fired)")

  // Upper third of the frame (a billboard, an overpass) never fires.
  looming = LoomingFilter()
  approach = IoUTracker()
  t = 0
  side = 0.06
  fired = 0
  for _ in 0..<45 {
    t += 1.0 / 15.0
    side *= pow(1.5, (1.0 / 15.0) / 0.5 / 2)
    approach.update([RawDetection(cls: .truck, box: NormalizedBox(x: 0.45, y: 0.05, w: side, h: side), score: 0.9)], at: t)
    if looming.evaluate(tracks: approach.tracks, yawRateDegPerSec: 0, at: t) != nil { fired += 1 }
  }
  check("looming: box in the upper third never fires", fired == 0, "fired \(fired)")

  // Hazards: person ahead, ≤ 1 per 3 s, cart heuristic.
  var hazards = HazardFilter()
  let person = DetectionPayload(cls: .person, box: box(cx: 0.5, cy: 0.6, w: 0.25, h: 0.5), score: 0.9, trackId: 1)
  let h1 = hazards.evaluate([person], at: 10)
  let h2 = hazards.evaluate([person], at: 11)
  let h3 = hazards.evaluate([person], at: 13.1)
  check("hazard: person ahead → PERSON_AHEAD CENTER, then ≤ 1 per 3 s", h1?.kind == .personAhead && h1?.direction == .center && h2 == nil && h3 != nil)
  let wideLow = DetectionPayload(cls: .bicycle, box: NormalizedBox(x: 0.35, y: 0.65, w: 0.30, h: 0.15), score: 0.8, trackId: 2)
  let relabeled = hazards.applyCartHeuristic([person, wideLow])
  check("hazard: a wide low box beside a person is relabelled cart", relabeled.contains { $0.cls == .cart && $0.trackId == 2 })
  let tiny = DetectionPayload(cls: .person, box: box(cx: 0.5, cy: 0.6, w: 0.05, h: 0.1), score: 0.9, trackId: 3)
  check("hazard: a small (far) person is not a hazard", hazards.evaluate([tiny], at: 20) == nil)
}

// MARK: - Depth

func depthChecks() {
  func grid(center: Double, left: Double? = nil, right: Double? = nil, t: Double) -> DepthGrid {
    let l = left ?? (center * 0.8)
    let r = right ?? (center * 0.8)
    return DepthGrid(cells: [[0.1, 0.1, 0.1], [l, center * 0.9, r], [l, center, r]], timestamp: t)
  }

  var est = ObstacleEstimator()   // uncalibrated thresholds: near 0.80, mid 0.55
  var classes: [DistanceClass] = []
  var obstacleTimes: [Double] = []
  var depthTimes: [Double] = []
  var t = 0.0
  var rel = 0.20
  // Walk at a wall from 4 m: relative depth climbs 0.20 → 0.95 over 6 s at 10 Hz.
  for _ in 0..<60 {
    t += 0.1
    rel = min(0.95, rel + 0.0125)
    let o = est.process(grid(center: rel, t: t), indoor: false)
    if classes.last != o.distanceClass { classes.append(o.distanceClass) }
    if o.obstacle != nil { obstacleTimes.append(t) }
    if o.depth != nil { depthTimes.append(t) }
  }
  check("depth: wall approach crosses FAR → MID → NEAR in order", classes == [.far, .mid, .near], "classes \(classes)")
  check("depth: at least one obstacle event, spaced ≥ 2 s", !obstacleTimes.isEmpty && zip(obstacleTimes, obstacleTimes.dropFirst()).allSatisfy { $1 - $0 >= 2.0 - 1e-9 }, "times \(obstacleTimes)")
  var minDepthGap = Double.infinity
  for i in 1..<depthTimes.count { minDepthGap = min(minDepthGap, depthTimes[i] - depthTimes[i - 1]) }
  check("depth: onDepth ≤ 5 Hz", minDepthGap >= 0.2 - 1e-9, "min gap \(minDepthGap)")

  // MID and static → no obstacle; MID and closing fast → obstacle.
  est = ObstacleEstimator()
  var midStatic = 0
  t = 100
  for _ in 0..<30 {
    t += 0.1
    if est.process(grid(center: 0.60, t: t), indoor: false).obstacle != nil { midStatic += 1 }
  }
  check("depth: MID and static never warns", midStatic == 0, "warned \(midStatic)")
  est = ObstacleEstimator()
  var midClosing = 0
  t = 200
  rel = 0.50
  for _ in 0..<20 {
    t += 0.1
    rel += 0.03   // 0.3 rel/s, above the walking-pace rate
    if est.process(grid(center: min(rel, 0.79), t: t), indoor: false).obstacle != nil { midClosing += 1 }
  }
  check("depth: MID closing fast warns", midClosing >= 1)

  // Shelf asymmetry: nearer on the right → positive (user drifted right).
  est = ObstacleEstimator()
  let o = est.process(grid(center: 0.3, left: 0.2, right: 0.6, t: 300), indoor: true)
  check("depth: shelf nearer on the right → positive offset, source shelf", (o.shelfOffset?.offsetM ?? -1) > 0 && o.shelfOffset?.source == .shelf)
  let outdoor = est.process(grid(center: 0.3, left: 0.2, right: 0.6, t: 301), indoor: false)
  check("depth: no shelf offset outdoors", outdoor.shelfOffset == nil)

  // Grid reduction + normalisation from a synthetic map.
  var reduced = DepthGrid.reduce(width: 30, height: 30, timestamp: 1) { x, y in Float(y) / 29 }
  reduced.normalizeInPlace()
  check("depth: reduce() reads rows top→bottom and normalises to 0…1", reduced.cells[0][1] < reduced.cells[1][1] && reduced.cells[1][1] < reduced.cells[2][1] && approx(reduced.cells[2][1], 1, tol: 1e-9))
  check("depth: nearest bottom direction", DepthGrid(cells: [[0, 0, 0], [0, 0, 0], [0.9, 0.5, 0.2]], timestamp: 0).nearestBottomDirection == .left)

  // Calibration hook only accepts a sane pair.
  var cal = ObstacleEstimator()
  cal.calibrate(nearRel: 0.7, midRel: 0.4)
  check("depth: calibrate sets thresholds", cal.config.thresholds == DistanceThresholds(near: 0.7, mid: 0.4))
  cal.calibrate(nearRel: 0.3, midRel: 0.6)
  check("depth: calibrate rejects near ≤ mid", cal.config.thresholds == DistanceThresholds(near: 0.7, mid: 0.4))
}

// MARK: - OCR box + blur gate

func ocrChecks() {
  // Vision box in the upper-40 % ROI: a box filling the top half of the ROI is the
  // top 20 % of the upright frame.
  let b = OcrReader.normalizeBox(CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.5), upperBandFraction: 0.40)
  check("ocr: ROI box → upright full-frame box (top-left origin)", approx(b.x, 0.25, tol: 1e-9) && approx(b.y, 0.0, tol: 1e-9) && approx(b.w, 0.5, tol: 1e-9) && approx(b.h, 0.2, tol: 1e-9), "\(b)")
  let b2 = OcrReader.normalizeBox(CGRect(x: 0, y: 0, width: 1, height: 0.5), upperBandFraction: 0.40)
  check("ocr: bottom half of the ROI is rows 0.20…0.40", approx(b2.y, 0.20, tol: 1e-9) && approx(b2.h, 0.20, tol: 1e-9), "\(b2)")

  // No text normalisation in Swift: the payload carries the string as Vision gave it.
  let raw = OcrReadPayload(text: "A1SLE 3", box: b, confidence: 0.8, timestamp: 1)
  check("ocr: text crosses the bridge unmodified", raw.dictionary["text"] as? String == "A1SLE 3")

  let reader = OcrReader()
  check("ocr: blur gate skips a fast-yaw frame", reader.shouldSkip(yawRateDegPerSec: 60, trackingLimitedByMotion: false, at: 0) == .blur)
  check("ocr: excessive-motion tracking skips", reader.shouldSkip(yawRateDegPerSec: 0, trackingLimitedByMotion: true, at: 0) == .trackingLimited)
  check("ocr: a still frame may run", reader.shouldSkip(yawRateDegPerSec: 5, trackingLimitedByMotion: false, at: 0) == nil)
  reader.setKnownSigns([" DAIRY", "3", "DAIRY", ""])
  check("ocr: known signs are trimmed, deduplicated and sorted", reader.knownSigns == ["3", "DAIRY"])
}

// MARK: - Drift

func driftChecks() {
  // Camera looking along bearing 90° (east): forward = +x. A transform whose −z
  // column points east.
  func transform(position: SIMD3<Double>, bearingDeg: Double) -> simd_float4x4 {
    let r = Float(Angles.toRadians(bearingDeg))
    // forward (−z column) = (sin b, 0, −cos b); right (+x column) = (cos b, 0, sin b).
    let forward = SIMD3<Float>(sin(r), 0, -cos(r))
    let right = SIMD3<Float>(cos(r), 0, sin(r))
    let up = SIMD3<Float>(0, 1, 0)
    var m = matrix_identity_float4x4
    m.columns.0 = SIMD4<Float>(right, 0)
    m.columns.1 = SIMD4<Float>(up, 0)
    m.columns.2 = SIMD4<Float>(-forward, 0)
    m.columns.3 = SIMD4<Float>(Float(position.x), Float(position.y), Float(position.z), 1)
    return m
  }

  check("drift: yaw from a transform facing east is 90°", approx(WorldGeometry.yawDeg(from: transform(position: .zero, bearingDeg: 90)), 90, tol: 1e-3))
  check("drift: yaw from a transform facing north is 0°", approx(WorldGeometry.yawDeg(from: transform(position: .zero, bearingDeg: 0)), 0, tol: 1e-3))
  check("drift: pitch of a level camera is 0°", approx(WorldGeometry.pitchDeg(from: transform(position: .zero, bearingDeg: 45)), 0, tol: 1e-3))

  // Straight track along bearing 30° for 20 m: offset stays 0 ± 0.02 m.
  let anchor = SIMD3<Double>(1, 0, -2)
  let dir = WorldGeometry.groundDirection(bearingDeg: 30)
  var worst = 0.0
  for i in 0...40 {
    let d = Double(i) * 0.5
    let p = SIMD3<Double>(anchor.x + dir.x * d, 0, anchor.z + dir.y * d)
    worst = max(worst, abs(WorldGeometry.lateralOffset(position: p, anchor: anchor, bearingDeg: 30)))
  }
  check("drift: straight track reads 0 ± 0.02 m", worst <= 0.02, "worst \(worst)")

  // 0.5 m parallel offset to the right reads +0.5; to the left −0.5.
  let right = SIMD2<Double>(-dir.y, dir.x)
  let pRight = SIMD3<Double>(anchor.x + dir.x * 5 + right.x * 0.5, 0, anchor.z + dir.y * 5 + right.y * 0.5)
  let pLeft = SIMD3<Double>(anchor.x + dir.x * 5 - right.x * 0.5, 0, anchor.z + dir.y * 5 - right.y * 0.5)
  check("drift: 0.5 m right of the line reads +0.5 m", approx(WorldGeometry.lateralOffset(position: pRight, anchor: anchor, bearingDeg: 30), 0.5, tol: 1e-6))
  check("drift: 0.5 m left of the line reads −0.5 m", approx(WorldGeometry.lateralOffset(position: pLeft, anchor: anchor, bearingDeg: 30), -0.5, tol: 1e-6))
  check("drift: along-track distance is 5 m", approx(WorldGeometry.alongTrack(position: pRight, anchor: anchor, bearingDeg: 30), 5, tol: 1e-6))
  // Facing north (bearing 0): +x (east) is to the right.
  check("drift: east of a northbound line is +", WorldGeometry.lateralOffset(position: SIMD3<Double>(1, 0, -3), anchor: .zero, bearingDeg: 0) > 0.99)

  // Estimator: 5 Hz limiter, smoothing converges, frozen → source none.
  var est = DriftEstimator()
  check("drift: not anchored before setCourseReference", !est.isAnchored)
  est.anchor(at: anchor, bearingDeg: 30)
  var emits: [(t: Double, p: LateralOffsetPayload)] = []
  var t = 0.0
  for _ in 0..<40 {   // 4 s at 10 Hz, standing 0.5 m right
    t += 0.1
    if let p = est.update(position: pRight, frozen: false, at: t) { emits.append((t, p)) }
  }
  var minGap = Double.infinity
  for i in 1..<emits.count { minGap = min(minGap, emits[i].t - emits[i - 1].t) }
  check("drift: emits at ≤ 5 Hz", minGap >= 0.2 - 1e-9, "min gap \(minGap)")
  check("drift: smoothed offset converges to 0.5 m within 4 s, source pose", approx(emits.last?.p.offsetM ?? 0, 0.5, tol: 0.03) && emits.last?.p.source == .pose, "last \(String(describing: emits.last?.p))")
  let frozen = est.update(position: pRight, frozen: true, at: t + 1)
  check("drift: frozen (LIMITED) reports source none", frozen?.source == LateralOffsetSource.none && frozen?.offsetM == 0)
  est.clear()
  check("drift: clear disarms", !est.isAnchored && est.update(position: pRight, frozen: false, at: t + 2) == nil)

  // Horizon row: level camera → principal point row; tilting up moves it down the frame.
  let intrinsics = simd_float3x3(columns: (SIMD3<Float>(1000, 0, 0), SIMD3<Float>(0, 1000, 0), SIMD3<Float>(640, 360, 1)))
  let level = WorldGeometry.horizonRow(pitchDeg: 0, intrinsics: intrinsics, sensorWidth: 1280)
  let up = WorldGeometry.horizonRow(pitchDeg: 10, intrinsics: intrinsics, sensorWidth: 1280)
  check("drift: horizon row at cx for a level camera", approx(level ?? -1, 0.5, tol: 1e-6))
  check("drift: tilting up moves the horizon down the frame", (up ?? 0) > (level ?? 1))
  check("drift: unusable pitch → nil", WorldGeometry.horizonRow(pitchDeg: 85, intrinsics: intrinsics, sensorWidth: 1280) == nil)
}

// MARK: - Schedule + thermal + throttle

func scheduleChecks() {
  let idle = ProfileSchedules.schedule(for: .idle, segmentationEnabled: false)
  check("schedule: IDLE pauses the session and runs nothing", !idle.sessionRunning && PipelineStage.allCases.allSatisfy { idle.fps(for: $0) == 0 })
  let curb = ProfileSchedules.schedule(for: .approachCrossing, segmentationEnabled: false)
  check("schedule: APPROACH_CROSSING = detector 15 / signal 15 / depth 10 / ocr 0", curb.detectorFps == 15 && curb.signalFps == 15 && curb.depthFps == 10 && curb.ocrFps == 0)
  let indoor = ProfileSchedules.schedule(for: .indoorNav, segmentationEnabled: false)
  check("schedule: INDOOR_NAV = detector 15 / signal 0 / depth 10 / ocr 3", indoor.detectorFps == 15 && indoor.signalFps == 0 && indoor.depthFps == 10 && indoor.ocrFps == 3)
  let pickup = ProfileSchedules.schedule(for: .itemPickup, segmentationEnabled: false)
  check("schedule: ITEM_PICKUP = detector 5 / depth 5 / ocr 0", pickup.detectorFps == 5 && pickup.depthFps == 5 && pickup.ocrFps == 0)
  check("schedule: segmentation off unless enabled", ProfileSchedules.schedule(for: .outdoorNav, segmentationEnabled: false).segmentationFps == 0 && ProfileSchedules.schedule(for: .outdoorNav, segmentationEnabled: true).segmentationFps == 10)
  check("schedule: INDOOR_NAV never holds the signal model", !ProfileSchedules.requiredModels(for: .indoorNav, segmentationEnabled: false).contains(.signal))
  check("schedule: APPROACH_CROSSING never holds OCR", !ProfileSchedules.requiredModels(for: .approachCrossing, segmentationEnabled: false).contains(.ocr))

  let serious = curb.downshifted(for: .serious, safetyStage: .signal)
  check("thermal: .serious halves every rate", serious.detectorFps == 7.5 && serious.signalFps == 7.5 && serious.depthFps == 5)
  let critical = curb.downshifted(for: .critical, safetyStage: .signal)
  check("thermal: .critical keeps only the safety stage", critical.detectorFps == 0 && critical.depthFps == 0 && critical.signalFps == 7.5)
  check("thermal: nominal is unchanged", curb.downshifted(for: .nominal, safetyStage: .signal) == curb)
  check("thermal: safety stage per profile", ProfileSchedules.safetyStage(for: .crossing) == .signal && ProfileSchedules.safetyStage(for: .outdoorNav) == .detector && ProfileSchedules.safetyStage(for: .indoorNav) == .depth)

  check("throttle: stride 15 fps @ 30 Hz = 2, 10 fps = 3, 3 fps = 10, 0 fps = never", FrameThrottle.stride(targetFps: 15, sourceFps: 30) == 2 && FrameThrottle.stride(targetFps: 10, sourceFps: 30) == 3 && FrameThrottle.stride(targetFps: 3, sourceFps: 30) == 10 && FrameThrottle.stride(targetFps: 0, sourceFps: 30) == nil)
  var th = FrameThrottle()
  var ran = 0
  for f in 1...30 where th.shouldRun(frame: f, targetFps: 10) { ran += 1 }
  check("throttle: 10 fps target runs 10 of 30 frames", ran == 10, "ran \(ran)")
  th.markBusy()
  check("throttle: a busy stage drops the frame instead of queueing", !th.shouldRun(frame: 31, targetFps: 10))
  th.markIdle()

  var voter = NOfMVoter<Int>(n: 2, m: 3)
  voter.push(1); voter.push(nil); voter.push(1)
  check("filters: N-of-M counts abstentions against the window", voter.winner()?.value == 1 && voter.winner()?.votes == 2)
  voter.push(nil); voter.push(nil)
  check("filters: silence can win", voter.winner() == nil)
  var fps = FpsMeter()
  for i in 0..<30 { fps.tick(at: Double(i) / 15.0) }
  check("filters: fps meter reads ~15", approx(fps.fps(at: 29.0 / 15.0), 15, tol: 0.6), "\(fps.fps(at: 29.0 / 15.0))")
}

// MARK: - Export shape

func exportChecks() {
  let ocr = DebugExportLine.payload(for: .ocrText, wire: ["items": [OcrReadPayload(text: "3 DAIRY", box: NormalizedBox(x: 0.4, y: 0.1, w: 0.2, h: 0.05), confidence: 0.9, timestamp: 12).dictionary]])
  if case .array(let items) = ocr, case .object(let first)? = items.first, case .string(let text)? = first["text"] {
    check("export: onOcrText records a bare array of reads", text == "3 DAIRY")
  } else {
    check("export: onOcrText records a bare array of reads", false, "\(ocr)")
  }
  let tracking = DebugExportLine.payload(for: .trackingState, wire: TrackingStatePayload(state: .limited).dictionary)
  check("export: onTrackingState records the bare string", tracking == .string("LIMITED"))
  let signal = DebugExportLine.payload(for: .signalState, wire: SignalStatePayload(state: .walk, fresh: true, confidence: 0.9, nOfM: 6).dictionary)
  check("export: other events record their object", signal == .object(["state": .string("WALK"), "fresh": .bool(true), "confidence": .number(0.9), "nOfM": .number(6)]))

  let line = DebugExportLine(t: 1234, event: PerceptionEventName.detections.rawValue,
                             payload: DebugExportLine.payload(for: .detections, wire: ["items": [DetectionPayload(cls: .car, box: NormalizedBox(x: 0.1, y: 0.5, w: 0.1, h: 0.1), score: 0.8, trackId: 7).dictionary]]))
  let enc = JSONEncoder()
  enc.outputFormatting = [.sortedKeys]
  let json = (try? enc.encode(line)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
  check("export: a line serialises as {event, payload:[...], t}", json.hasPrefix("{\"event\":\"onDetections\",\"payload\":[{") && json.hasSuffix(",\"t\":1234}"), json)
  let decoded = try? JSONDecoder().decode(DebugExportLine.self, from: json.data(using: .utf8)!)
  check("export: round-trips through Codable", decoded == line)

  // 01 §7's eleven, plus the additions each round has made deliberately. This stays
  // strict on purpose: `modules/perception/index.ts` and D's jsonl replayer key off
  // these exact strings, so a native event JS does not forward is a silent dead end.
  // Adding one here is the step that says "the bridge handles it too".
  //
  // It has now broken twice unnoticed (onSceneClass in round 6, onHandPose in round 7)
  // because .github/workflows/ci.yml runs Jest and vitest but never this harness.
  // The failure prints the difference so the fix is obvious without reading the file.
  let expectedEvents: Set<String> = [
    "onSignalState", "onVehicleApproaching", "onObstacleAhead", "onHazard",
    "onOcrText", "onDetections", "onPose", "onLateralOffset", "onPlanes",
    "onDepth", "onTrackingState",
    "onSceneClass",   // round 6: Apple's scene classifier
    "onHandPose",     // round 7: the user's own hand, via Vision hand pose
  ]
  let actualEvents = Set(PerceptionEventName.allCases.map { $0.rawValue })
  let added = actualEvents.subtracting(expectedEvents).sorted()
  let removed = expectedEvents.subtracting(actualEvents).sorted()
  check("events: names match 01 §7 plus the rounds' deliberate additions",
        actualEvents == expectedEvents,
        "new in Events.swift and not in this list: \(added.isEmpty ? "none" : added.joined(separator: ", "))"
          + "; in this list and gone from Events.swift: \(removed.isEmpty ? "none" : removed.joined(separator: ", "))"
          + " — add it to the bridge in modules/perception/index.ts too, then to this list")
  check("events: stats carry exactly the five frozen fields", Set(StatsPayload.zero.dictionary.keys) == ["detectorFps", "depthFps", "ocrFps", "frameToEventMs", "thermalState"])
  check("events: direction thresholds 0.33 / 0.67", Direction.fromCenterX(0.2) == .left && Direction.fromCenterX(0.5) == .center && Direction.fromCenterX(0.8) == .right)
  let iou = NormalizedBox(x: 0, y: 0, w: 1, h: 1).intersectionOverUnion(NormalizedBox(x: 0.5, y: 0, w: 1, h: 1))
  check("events: IoU of half-overlapping unit boxes is 1/3", approx(iou, 1.0 / 3.0, tol: 1e-9))
}

// MARK: - Snapshot encoder

/// A pixel buffer carrying a one-pixel-wide vertical stripe pattern: the finest
/// detail a sensor can hold, and the first thing a bad downscale destroys.
private func stripedBuffer(width: Int, height: Int, period: Int = 2) -> CVPixelBuffer? {
  var out: CVPixelBuffer?
  let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
  guard CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                            kCVPixelFormatType_32BGRA, attrs as CFDictionary, &out) == kCVReturnSuccess,
        let buffer = out else { return nil }
  CVPixelBufferLockBaseAddress(buffer, [])
  defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
  let stride = CVPixelBufferGetBytesPerRow(buffer)
  let p = base.assumingMemoryBound(to: UInt8.self)
  for y in 0..<height {
    for x in 0..<width {
      let v: UInt8 = (x / period) % 2 == 0 ? 0 : 255
      let i = y * stride + x * 4
      p[i] = v; p[i + 1] = v; p[i + 2] = v; p[i + 3] = 255
    }
  }
  return buffer
}

func snapshotChecks() {
  // --- geometry: the long edge is what the token budget assumes ---
  let landscape = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: 1920, height: 1440))
  let toned = SnapshotEncoder.scaleToLongEdge(landscape, maxWidth: 768)
  check("snapshot: long edge lands on maxWidth", approx(Double(toned.extent.width), 768, tol: 1.5), "\(toned.extent)")
  check("snapshot: aspect is preserved", approx(Double(toned.extent.height), 576, tol: 1.5), "\(toned.extent)")
  check("snapshot: origin is normalised to zero",
        approx(Double(toned.extent.minX), 0, tol: 0.51) && approx(Double(toned.extent.minY), 0, tol: 0.51), "\(toned.extent)")

  let portrait = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: 1440, height: 1920))
  let tonedPortrait = SnapshotEncoder.scaleToLongEdge(portrait, maxWidth: 768)
  check("snapshot: a portrait frame is maxWidth TALL, not wide",
        approx(Double(tonedPortrait.extent.height), 768, tol: 1.5) && approx(Double(tonedPortrait.extent.width), 576, tol: 1.5),
        "\(tonedPortrait.extent)")

  let small = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: 320, height: 240))
  check("snapshot: an already-small frame is never upscaled",
        SnapshotEncoder.scaleToLongEdge(small, maxWidth: 768).extent.width == 320)

  check("snapshot: expectedSize matches a 4:3 sensor", SnapshotEncoder.expectedSize(maxWidth: 768) == (768, 576))
  check("snapshot: the allowed widths are the four the contract names",
        SnapshotEncoder.allowedWidths == [512, 640, 768, 1024])

  // --- the reason Lanczos is here: a 4x reduction must not alias detail away ---
  // One-pixel stripes reduced 4x. Bilinear point-samples and returns near-flat
  // bands; a prefiltered reduction keeps a mid-grey average with real variation.
  if let striped = stripedBuffer(width: 1024, height: 256) {
    let image = CIImage(cvPixelBuffer: striped)
    let lanczos = SnapshotEncoder.lanczosScaled(image, scale: 0.25)
    check("snapshot: Lanczos is available and returns an image", lanczos != nil)
    if let lanczos {
      check("snapshot: Lanczos reduction keeps the frame's geometry",
            approx(Double(lanczos.extent.width), 256, tol: 1.5), "\(lanczos.extent)")
    }
    let encoder = SnapshotEncoder()
    let source = SnapshotSource(pixelBuffer: striped, orientation: .up, horizonRow: nil, timestampMs: 42)
    switch encoder.encode(source: source, maxWidth: 512) {
    case .success(let payload):
      check("snapshot: encode produces the scaled size", payload.width == 512 && payload.height == 128, "\(payload.width)x\(payload.height)")
      check("snapshot: encode carries the frame timestamp, not the wall clock", approx(payload.timestamp, 42, tol: 0.001))
      check("snapshot: encode returns non-empty JPEG base64", payload.base64.count > 100)
      check("snapshot: sequence numbers start at one and rise", payload.seq == 1)
    case .failure(let error):
      check("snapshot: encode produces the scaled size", false, "\(error)")
    }
    // A second encode must advance the sequence: the client drops stale seqs.
    let encoder2 = SnapshotEncoder()
    _ = encoder2.encode(source: source, maxWidth: 512)
    if case .success(let second) = encoder2.encode(source: source, maxWidth: 512) {
      check("snapshot: seq advances per encode", second.seq == 2, "\(second.seq)")
    }
  } else {
    check("snapshot: could build a striped test buffer", false)
  }

  // --- an unsupported width is refused rather than silently resized ---
  let encoder = SnapshotEncoder()
  var rejected = false
  encoder.snapshot(maxWidth: 999, source: { nil }) { result in
    if case .failure(let error) = result, case SnapshotError.invalidWidth = error { rejected = true }
  }
  check("snapshot: an unsupported width is rejected", rejected)

  // --- curb crop: a horizon strip, full width, around the row the engine reports ---
  let frame = CIImage(color: CIColor(red: 0.5, green: 0.5, blue: 0.5)).cropped(to: CGRect(x: 0, y: 0, width: 1000, height: 1000))
  let crop = SnapshotEncoder.curbCrop(frame, horizonRow: 0.4)
  check("snapshot: curb crop keeps full width", approx(Double(crop.extent.width), 1000, tol: 0.51), "\(crop.extent)")
  check("snapshot: curb crop keeps the configured height fraction",
        approx(Double(crop.extent.height), 1000 * SnapshotEncoder.curbCropHeightFraction, tol: 0.51), "\(crop.extent)")
  let cropTop = SnapshotEncoder.curbCrop(frame, horizonRow: 0.0)
  check("snapshot: a horizon at the top clamps inside the frame",
        cropTop.extent.minY >= -0.51 && cropTop.extent.height <= 1000, "\(cropTop.extent)")
  let cropNil = SnapshotEncoder.curbCrop(frame, horizonRow: nil)
  check("snapshot: a missing horizon row falls back to a sane default strip",
        approx(Double(cropNil.extent.height), 1000 * SnapshotEncoder.curbCropHeightFraction, tol: 0.51))
}

// MARK: - Main

@main
enum EngineChecks {
  static func main() {
    check("food: cheese crosses the native bridge as cheese", OpenImagesLabels.detectionClass(for: "Cheese") == .cheese)
    check("food: an opaque container remains a container", OpenImagesLabels.detectionClass(for: "Container") == .foodContainer)
    check("food: animal chicken is not relabelled meat", OpenImagesLabels.detectionClass(for: "Chicken") == nil)
    check("food: groceries are scenery, never indoor hazards", DetectionClass.sceneClasses.contains(.cheese) && !DetectionClass.hazardClasses.contains(.cheese))
    signalChecks()
    trackerChecks()
    depthChecks()
    ocrChecks()
    driftChecks()
    scheduleChecks()
    exportChecks()
    snapshotChecks()
    print("\n\(passes) passed, \(failures) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
