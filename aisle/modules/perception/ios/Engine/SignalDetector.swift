//
//  SignalDetector.swift
//  Aisle — PerceptionModule engine
//
//  The pedestrian-signal pipeline (09 §5.1). This is the filter whose mistake
//  hurts most, so every rule is explicit and testable, and the decision logic
//  never touches a pixel: `SignalGate` and `SignalVote` take detections and a
//  geometry snapshot and return a state.
//
//  The four rules, in the order they apply:
//
//   1. **Armed only.** Nothing runs until `setCrossingBearing(deg)` armed the
//      gate. `nil` disarms and resets every filter.
//   2. **Geometric gate**, all three required: body heading within ±20° of the
//      crossing bearing; box centre inside the horizon strip (horizon row ±12 %
//      of frame height, from the ARKit camera pitch); of what survives, the box
//      nearest the frame centre column wins and the rest are ignored. This is
//      the defence against reading the parallel crosswalk's head.
//   3. **5 of 8.** Per-frame class into a ring of 8; a state is emitted only
//      when ≥ 5 agree, otherwise UNKNOWN. Absorbs LED PWM flicker.
//   4. **Onset.** If the first non-UNKNOWN state since arming is WALK, it is
//      `fresh: false` ("Walk already on — wait for next"). A WALK that follows
//      an observed DONT_WALK is `fresh: true`. COUNTDOWN is always
//      `fresh: false`.
//
//  UNKNOWN is silence downstream, never a guess (00, principle 7).
//

import Foundation

// MARK: - Geometry snapshot

/// Everything the gate needs to know about the frame, computed once per frame
/// by `ARSessionManager` from `frame.camera` and passed in. Keeping it a value
/// type is what makes the gate unit-testable without ARKit.
public struct FrameGeometry: Equatable, Sendable {
  /// Body heading in degrees true north: ARKit yaw minus `bodyOffsetDeg`.
  public var bodyHeadingDeg: Double
  /// Normalized row (0 = top, 1 = bottom) of the horizon in the upright frame,
  /// from `cy - f * tan(pitch)` (09 §2). `nil` when pitch is unusable.
  public var horizonRow: Double?
  /// Camera yaw rate in degrees per second, for the sweep suppression in §5.2.
  public var yawRateDegPerSec: Double
  public var trackingState: TrackingStateName
  /// Seconds, monotonic.
  public var timestamp: Double

  public init(bodyHeadingDeg: Double, horizonRow: Double?, yawRateDegPerSec: Double,
              trackingState: TrackingStateName, timestamp: Double) {
    self.bodyHeadingDeg = bodyHeadingDeg
    self.horizonRow = horizonRow
    self.yawRateDegPerSec = yawRateDegPerSec
    self.trackingState = trackingState
    self.timestamp = timestamp
  }
}

// MARK: - Tunables

public struct SignalGateConfig: Equatable, Sendable {
  /// ±20°: the best compass accuracy tier guarantees ±20° (01 §2), so a tighter
  /// window would reject valid frames. 10 §9 allows one tightening pass to ±15°
  /// if parallel confusion stays ≥ 2 % after the gate.
  public var headingToleranceDeg: Double = 20
  /// Horizon strip half-height as a fraction of frame height.
  public var horizonStripHalfHeight: Double = 0.12
  /// Fallback strip centre when pitch is unusable: the upper-middle of the
  /// frame, where a signal head sits for a chest-mounted phone tilted up ~10°.
  public var fallbackHorizonRow: Double = 0.40
  /// Per-class confidence floor when the manifest carries none (10 §6).
  public var defaultScoreFloor: Double = 0.35

  public init() {}

  public init(headingToleranceDeg: Double, horizonStripHalfHeight: Double,
              fallbackHorizonRow: Double, defaultScoreFloor: Double) {
    self.headingToleranceDeg = headingToleranceDeg
    self.horizonStripHalfHeight = horizonStripHalfHeight
    self.fallbackHorizonRow = fallbackHorizonRow
    self.defaultScoreFloor = defaultScoreFloor
  }
}

// MARK: - Gate

/// Why a frame produced no vote. Diagnostics only — the user hears silence
/// either way — but the phase-0 measurement needs to know which rule fired.
public enum GateRejection: String, Equatable, Sendable {
  case notArmed
  case headingOff
  case noSignalDetections
  case belowScoreFloor
  case offHorizonStrip
}

public struct GateResult: Equatable {
  public var accepted: DetectionPayload?
  public var rejection: GateRejection?
  /// How many signal-class boxes the gate saw before the nearest-centre pick.
  /// A number > 1 means another head was in frame — usually the parallel
  /// crosswalk's, which is what the gate exists to discard.
  public var candidateCount: Int

  public init(accepted: DetectionPayload?, rejection: GateRejection?, candidateCount: Int) {
    self.accepted = accepted
    self.rejection = rejection
    self.candidateCount = candidateCount
  }
}

public struct SignalGate {
  public var config: SignalGateConfig

  public init(config: SignalGateConfig = SignalGateConfig()) {
    self.config = config
  }

  /// Apply rules 1 and 2. Returns the single detection that may vote this frame.
  public func apply(detections: [DetectionPayload],
                    geometry: FrameGeometry,
                    crossingBearingDeg: Double?,
                    thresholds: [DetectionClass: Double] = [:]) -> GateResult {
    guard let bearing = crossingBearingDeg else {
      return GateResult(accepted: nil, rejection: .notArmed, candidateCount: 0)
    }

    // Rule 2a — body heading within tolerance of the crossing bearing.
    let separation = Angles.separation(geometry.bodyHeadingDeg, bearing)
    guard separation <= config.headingToleranceDeg else {
      return GateResult(accepted: nil, rejection: .headingOff, candidateCount: 0)
    }

    let signalBoxes = detections.filter { DetectionClass.signalClasses.contains($0.cls) }
    guard !signalBoxes.isEmpty else {
      return GateResult(accepted: nil, rejection: .noSignalDetections, candidateCount: 0)
    }

    let confident = signalBoxes.filter {
      $0.score >= (thresholds[$0.cls] ?? config.defaultScoreFloor)
    }
    guard !confident.isEmpty else {
      return GateResult(accepted: nil, rejection: .belowScoreFloor,
                        candidateCount: signalBoxes.count)
    }

    // Rule 2b — box centre inside the horizon strip.
    let strip = geometry.horizonRow ?? config.fallbackHorizonRow
    let inStrip = confident.filter {
      abs($0.box.centerY - strip) <= config.horizonStripHalfHeight
    }
    guard !inStrip.isEmpty else {
      return GateResult(accepted: nil, rejection: .offHorizonStrip,
                        candidateCount: confident.count)
    }

    // Rule 2c — nearest the frame centre column; ignore the rest.
    let nearest = inStrip.min { lhs, rhs in
      abs(lhs.box.centerX - 0.5) < abs(rhs.box.centerX - 0.5)
    }
    return GateResult(accepted: nearest, rejection: nil, candidateCount: inStrip.count)
  }
}

// MARK: - Vote + onset

public struct SignalReading: Equatable {
  public var payload: SignalStatePayload
  /// Set when the vote changed state this frame (as opposed to a heartbeat).
  public var changed: Bool

  public init(payload: SignalStatePayload, changed: Bool) {
    self.payload = payload
    self.changed = changed
  }
}

/// Rules 3 and 4. Owns the 8-frame window, the onset memory and the
/// change-plus-heartbeat emit budget.
public struct SignalVote {
  public static let windowSize = 8
  public static let agreementRequired = 5
  /// 01 §7: on change plus a 0.5 Hz heartbeat.
  public static let heartbeatSeconds = 2.0
  /// 09 §5.1 step 6: ten seconds of UNKNOWN after arming is JS's cue for
  /// "Can't see the signal". The module just keeps reporting; the constant lives
  /// here so both sides agree on the number.
  public static let unknownPatienceSeconds = 10.0

  private var voter = NOfMVoter<SignalState>(n: SignalVote.agreementRequired, m: SignalVote.windowSize)
  private var scores: RingBuffer<Double> = RingBuffer(capacity: SignalVote.windowSize)
  private var emitter = ChangeOrHeartbeat<SignalState>(heartbeatSeconds: SignalVote.heartbeatSeconds)
  private var lastState: SignalState = .unknown
  /// The first non-UNKNOWN state observed since arming, for the onset rule.
  private var firstObservedState: SignalState?
  /// Has a DONT_WALK been observed since arming? Only then is a WALK fresh.
  private var sawDontWalk = false
  private var armedAt: Double?

  public init() {}

  public mutating func arm(at t: Double) {
    reset()
    armedAt = t
  }

  public mutating func reset() {
    voter.reset()
    scores.reset()
    emitter.reset()
    lastState = .unknown
    firstObservedState = nil
    sawDontWalk = false
    armedAt = nil
  }

  public var isArmed: Bool { armedAt != nil }

  /// Seconds of UNKNOWN since arming, for the JS-side patience timer.
  public func unknownDuration(at t: Double) -> Double {
    guard let armedAt, firstObservedState == nil else { return 0 }
    return max(0, t - armedAt)
  }

  /// Push one frame's gated result and get the state to emit, if any.
  /// `accepted == nil` pushes an abstention: silence has to be able to win.
  public mutating func push(accepted: DetectionPayload?, at t: Double) -> SignalReading? {
    let frameState = accepted?.cls.signalState
    voter.push(frameState)
    if let accepted { scores.push(accepted.score) }

    let winner = voter.winner()
    let state = winner?.value ?? .unknown
    let votes = winner?.votes ?? 0

    if state != .unknown {
      if firstObservedState == nil { firstObservedState = state }
      if state == .dontWalk { sawDontWalk = true }
    }

    let fresh = freshness(for: state)
    let changed = state != lastState
    guard emitter.shouldEmit(state, at: t) else {
      lastState = state
      return nil
    }
    lastState = state

    let confidence = state == .unknown ? 0 : meanScore()
    return SignalReading(
      payload: SignalStatePayload(state: state, fresh: fresh, confidence: confidence, nOfM: votes),
      changed: changed)
  }

  /// Rule 4. A WALK is fresh only when the module itself observed DONT_WALK →
  /// WALK; a WALK that was already showing when tracking began is stale, and
  /// COUNTDOWN is always stale (there is no onset to have seen).
  private func freshness(for state: SignalState) -> Bool {
    switch state {
    case .walk:
      return sawDontWalk && firstObservedState != .walk
    case .dontWalk, .countdown, .unknown:
      return false
    }
  }

  /// `confidence` = mean score of the agreeing frames (09 §5.1 step 5).
  private func meanScore() -> Double {
    let values = scores.elements
    guard !values.isEmpty else { return 0 }
    return values.reduce(0, +) / Double(values.count)
  }
}

// MARK: - Detector

/// Gate + vote wired together, plus the arming state. One instance per session;
/// the engine calls `setCrossingBearing` and then `process` per signal frame.
public final class SignalDetector {
  public private(set) var crossingBearingDeg: Double?
  public var gate: SignalGate
  private var vote = SignalVote()
  /// Per-class score floors from the model manifest (10 §6). The module may
  /// raise the walk threshold from device measurements, never lower it.
  public private(set) var thresholds: [DetectionClass: Double] = [:]

  public init(gate: SignalGate = SignalGate()) {
    self.gate = gate
  }

  /// Arms (non-nil) or disarms and resets (nil) — 09 §5: every filter resets on
  /// `setCrossingBearing(null)`.
  public func setCrossingBearing(_ deg: Double?, at t: Double) {
    if let deg {
      crossingBearingDeg = Angles.wrapUnsigned(deg)
      vote.arm(at: t)
    } else {
      crossingBearingDeg = nil
      vote.reset()
    }
  }

  public var isArmed: Bool { crossingBearingDeg != nil && vote.isArmed }

  /// Read per-class thresholds from the manifest, clamping each to at least the
  /// gate's floor so a manifest can never make the model more permissive than
  /// the module's own bar.
  public func applyManifest(_ manifest: ModelManifest?) {
    guard let manifest else { return }
    var next: [DetectionClass: Double] = [:]
    for label in manifest.labels {
      guard let cls = DetectionClass(rawValue: label) else { continue }
      let fromManifest = manifest.threshold(for: label, default: gate.config.defaultScoreFloor)
      next[cls] = max(fromManifest, gate.config.defaultScoreFloor)
    }
    thresholds = next
  }

  /// Raise one class's floor from a device measurement (10 §6: upward only).
  public func raiseThreshold(_ cls: DetectionClass, to value: Double) {
    let current = thresholds[cls] ?? gate.config.defaultScoreFloor
    thresholds[cls] = max(current, value)
  }

  public func reset() {
    vote.reset()
    if let bearing = crossingBearingDeg {
      crossingBearingDeg = bearing
    }
  }

  /// Re-arm after a session interruption without forgetting the bearing
  /// (09 §2: interruptions reset the filters and re-arm the gate if one was set).
  public func rearm(at t: Double) {
    guard crossingBearingDeg != nil else { return }
    vote.arm(at: t)
  }

  public struct Outcome: Equatable {
    public var reading: SignalReading?
    public var gateResult: GateResult
    public var unknownSeconds: Double

    public init(reading: SignalReading?, gateResult: GateResult, unknownSeconds: Double) {
      self.reading = reading
      self.gateResult = gateResult
      self.unknownSeconds = unknownSeconds
    }
  }

  /// One signal-model frame.
  public func process(detections: [DetectionPayload], geometry: FrameGeometry) -> Outcome {
    let gateResult = gate.apply(
      detections: detections, geometry: geometry,
      crossingBearingDeg: crossingBearingDeg, thresholds: thresholds)
    guard isArmed else {
      return Outcome(reading: nil, gateResult: gateResult, unknownSeconds: 0)
    }
    let reading = vote.push(accepted: gateResult.accepted, at: geometry.timestamp)
    return Outcome(
      reading: reading, gateResult: gateResult,
      unknownSeconds: vote.unknownDuration(at: geometry.timestamp))
  }
}
