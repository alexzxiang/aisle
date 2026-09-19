//
//  VehicleTracker.swift
//  Aisle — PerceptionModule engine
//
//  The COCO detector's consumers: the IoU tracker shared by every pipeline
//  (09 §4), the vehicle looming filter (09 §5.2) and the indoor person / cart
//  hazard (09 §5.4). Pure logic over `DetectionPayload` values; the detector
//  output is decoded elsewhere so this file runs unchanged on synthetic tracks
//  in a unit test.
//
//  Looming rule — fire `onVehicleApproaching` when, on one track:
//    - box-area growth > 40 % over the last 0.5 s (area now / area 0.5 s ago > 1.4),
//      with bottom-edge descent in the same window as the supporting signal;
//    - track age ≥ 0.3 s;
//    - box centre in the lower two-thirds of the upright frame;
//    - the same track has not fired in the last 4 s;
//    - the phone's yaw rate over the window < 30°/s (a sweep makes every parked
//      car "grow").
//  Parked cars (no growth) and flowing cross traffic (little growth, high
//  lateral velocity) must not fire. False-alarm budget: < 1 per 5 min. If it is
//  missed on recorded footage, raise the growth threshold before the track age.
//

import Foundation

// MARK: - Tracker

public struct Track: Equatable {
  public let id: Int
  public var cls: DetectionClass
  public var box: NormalizedBox
  public var score: Double
  public let firstSeenAt: Double
  public var lastSeenAt: Double
  public var missedFrames: Int
  /// (timestamp, box) for the last second (09 §4).
  public var history: TimedSamples<NormalizedBox>

  public init(id: Int, detection: DetectionPayload, at t: Double) {
    self.id = id
    self.cls = detection.cls
    self.box = detection.box
    self.score = detection.score
    self.firstSeenAt = t
    self.lastSeenAt = t
    self.missedFrames = 0
    self.history = TimedSamples(windowSeconds: 1.0)
    self.history.push(detection.box, at: t)
  }

  public var age: Double { lastSeenAt - firstSeenAt }

  public static func == (lhs: Track, rhs: Track) -> Bool {
    lhs.id == rhs.id && lhs.cls == rhs.cls && lhs.box == rhs.box
      && lhs.lastSeenAt == rhs.lastSeenAt && lhs.missedFrames == rhs.missedFrames
  }

  mutating func update(with detection: DetectionPayload, at t: Double) {
    cls = detection.cls
    box = detection.box
    score = detection.score
    lastSeenAt = t
    missedFrames = 0
    history.push(detection.box, at: t)
  }
}

/// A raw detector box before it has a track id.
public struct RawDetection: Equatable, Sendable {
  public var cls: DetectionClass
  public var box: NormalizedBox
  public var score: Double

  public init(cls: DetectionClass, box: NormalizedBox, score: Double) {
    self.cls = cls
    self.box = box
    self.score = score
  }
}

/// IoU association across consecutive detector frames: match when IoU ≥ 0.3,
/// greedy by score; a track survives 5 missed frames; `trackId` is monotonic
/// per session. Costs < 2 ms at COCO-nano output sizes.
public struct IoUTracker {
  public static let matchThreshold = 0.3
  public static let maxMissedFrames = 5

  public private(set) var tracks: [Track] = []
  private var nextId = 1

  public init() {}

  /// Associate this frame's detections and return them with track ids, in
  /// score order. Same class required for a match — a `person` never continues a
  /// `car` track.
  @discardableResult
  public mutating func update(_ detections: [RawDetection], at t: Double) -> [DetectionPayload] {
    let ordered = detections.sorted { $0.score > $1.score }
    var unmatchedTracks = Set(tracks.indices)
    var output: [DetectionPayload] = []
    output.reserveCapacity(ordered.count)

    for det in ordered {
      var bestIndex: Int?
      var bestIoU = IoUTracker.matchThreshold
      for index in unmatchedTracks where tracks[index].cls == det.cls {
        let iou = tracks[index].box.intersectionOverUnion(det.box)
        if iou >= bestIoU {
          bestIoU = iou
          bestIndex = index
        }
      }
      let payload = DetectionPayload(cls: det.cls, box: det.box, score: det.score, trackId: 0)
      if let index = bestIndex {
        unmatchedTracks.remove(index)
        tracks[index].update(with: payload, at: t)
        output.append(DetectionPayload(cls: det.cls, box: det.box, score: det.score, trackId: tracks[index].id))
      } else {
        let track = Track(id: nextId, detection: payload, at: t)
        nextId += 1
        tracks.append(track)
        output.append(DetectionPayload(cls: det.cls, box: det.box, score: det.score, trackId: track.id))
      }
    }

    // Age the tracks nothing matched; drop the ones that missed too many frames.
    for index in unmatchedTracks {
      tracks[index].missedFrames += 1
    }
    tracks.removeAll { $0.missedFrames > IoUTracker.maxMissedFrames }
    return output
  }

  public func track(id: Int) -> Track? {
    tracks.first { $0.id == id }
  }

  public mutating func reset() {
    tracks.removeAll()
    // `nextId` is deliberately not reset: trackId is monotonic per session.
  }
}

// MARK: - Looming

public struct LoomingConfig: Equatable, Sendable {
  public var growthWindowSeconds: Double = 0.5
  /// Ratio of area now to area 0.5 s ago that counts as approach.
  public var growthRatio: Double = 1.4
  public var minTrackAgeSeconds: Double = 0.3
  /// Box centre must be at or below this row (lower two-thirds of the frame).
  public var minCenterY: Double = 1.0 / 3.0
  public var perTrackCooldownSeconds: Double = 4.0
  public var maxYawRateDegPerSec: Double = 30
  /// Bottom-edge descent required in the window, as a fraction of frame height.
  /// The supporting signal, not the primary one; keep it small.
  public var minBottomDescent: Double = 0.0

  public init() {}
}

/// Why a track did not fire this frame. Diagnostics for the phase-0 tuning pass.
public enum LoomingRejection: String, Equatable, Sendable {
  case notVehicle
  case tooYoung
  case tooHigh
  case insufficientHistory
  case noGrowth
  case noDescent
  case sweeping
  case cooldown
}

public struct LoomingDecision: Equatable {
  public var fired: VehicleApproachingPayload?
  public var rejection: LoomingRejection?
  public var growth: Double

  public init(fired: VehicleApproachingPayload?, rejection: LoomingRejection?, growth: Double) {
    self.fired = fired
    self.rejection = rejection
    self.growth = growth
  }
}

public struct LoomingFilter {
  public var config: LoomingConfig
  private var cooldown: KeyedRateLimiter<Int>

  public init(config: LoomingConfig = LoomingConfig()) {
    self.config = config
    self.cooldown = KeyedRateLimiter(intervalSeconds: config.perTrackCooldownSeconds)
  }

  /// Evaluate one track at time `t`. Pure apart from the per-track cooldown.
  public mutating func evaluate(_ track: Track, yawRateDegPerSec: Double, at t: Double) -> LoomingDecision {
    guard DetectionClass.vehicleClasses.contains(track.cls) else {
      return LoomingDecision(fired: nil, rejection: .notVehicle, growth: 1)
    }
    guard track.age >= config.minTrackAgeSeconds else {
      return LoomingDecision(fired: nil, rejection: .tooYoung, growth: 1)
    }
    guard track.box.centerY >= config.minCenterY else {
      return LoomingDecision(fired: nil, rejection: .tooHigh, growth: 1)
    }
    guard let past = track.history.sample(secondsAgo: config.growthWindowSeconds, now: t),
          t - past.t >= config.growthWindowSeconds * 0.8, past.value.area > 0 else {
      return LoomingDecision(fired: nil, rejection: .insufficientHistory, growth: 1)
    }
    let growth = track.box.area / past.value.area
    guard growth > config.growthRatio else {
      return LoomingDecision(fired: nil, rejection: .noGrowth, growth: growth)
    }
    let descent = track.box.bottom - past.value.bottom
    guard descent >= config.minBottomDescent else {
      return LoomingDecision(fired: nil, rejection: .noDescent, growth: growth)
    }
    guard abs(yawRateDegPerSec) < config.maxYawRateDegPerSec else {
      return LoomingDecision(fired: nil, rejection: .sweeping, growth: growth)
    }
    guard cooldown.allow(track.id, at: t) else {
      return LoomingDecision(fired: nil, rejection: .cooldown, growth: growth)
    }
    let payload = VehicleApproachingPayload(
      direction: Direction.fromCenterX(track.box.centerX), trackId: track.id, growth: growth)
    return LoomingDecision(fired: payload, rejection: nil, growth: growth)
  }

  /// Run every live track; at most the strongest grower fires per frame so two
  /// boxes on one bus never produce two STOPs.
  public mutating func evaluate(tracks: [Track], yawRateDegPerSec: Double, at t: Double) -> VehicleApproachingPayload? {
    var best: VehicleApproachingPayload?
    for track in tracks where track.missedFrames == 0 {
      let decision = evaluate(track, yawRateDegPerSec: yawRateDegPerSec, at: t)
      if let fired = decision.fired, fired.growth > (best?.growth ?? 0) {
        best = fired
      }
    }
    cooldown.prune(before: t)
    return best
  }

  public mutating func reset() {
    cooldown.reset()
  }
}

// MARK: - Indoor hazards

public struct HazardConfig: Equatable, Sendable {
  /// Minimum normalized box area to count as "ahead", not "somewhere in the
  /// store". Calibrated on the venue video in phase 0.
  public var minArea: Double = 0.04
  public var minCenterY: Double = 1.0 / 3.0
  public var cooldownSeconds: Double = 3.0
  /// Cart heuristic (09 §3): a wide, low box beside or below a person.
  public var cartMinAspect: Double = 1.2
  public var cartMinBottom: Double = 0.6

  public init() {}
}

/// COCO `person` (and the `cart` heuristic) with box centre in the lower
/// two-thirds and area above a size threshold → `onHazard`, ≤ 1 per 3 s. INFO
/// semantics in JS; never STOP from this pipeline (09 §5.4).
public struct HazardFilter {
  public var config: HazardConfig
  private var limiter: RateLimiter

  public init(config: HazardConfig = HazardConfig()) {
    self.config = config
    self.limiter = RateLimiter(intervalSeconds: config.cooldownSeconds)
  }

  /// Cart is not a COCO class. Relabel a wide, low box that sits next to a
  /// person as `cart` so `Detection.cls` carries the heuristic honestly.
  public func applyCartHeuristic(_ detections: [DetectionPayload]) -> [DetectionPayload] {
    let people = detections.filter { $0.cls == .person }
    guard !people.isEmpty else { return detections }
    return detections.map { det in
      guard det.cls != .person, det.box.h > 0 else { return det }
      let aspect = det.box.w / det.box.h
      let isWideLow = aspect >= config.cartMinAspect && det.box.bottom >= config.cartMinBottom
      let nearPerson = people.contains { person in
        abs(person.box.centerX - det.box.centerX) < max(person.box.w, det.box.w)
      }
      if isWideLow && nearPerson {
        return DetectionPayload(cls: .cart, box: det.box, score: det.score, trackId: det.trackId)
      }
      return det
    }
  }

  public mutating func evaluate(_ detections: [DetectionPayload], at t: Double) -> HazardPayload? {
    let candidates = detections.filter {
      DetectionClass.hazardClasses.contains($0.cls)
        && $0.box.area >= config.minArea
        && $0.box.centerY >= config.minCenterY
    }
    guard let nearest = candidates.max(by: { $0.box.area < $1.box.area }) else { return nil }
    guard limiter.allow(at: t) else { return nil }
    let kind: HazardKind = nearest.cls == .cart ? .cartAhead : .personAhead
    return HazardPayload(kind: kind, direction: Direction.fromCenterX(nearest.box.centerX))
  }

  public mutating func reset() {
    limiter.reset()
  }
}

// MARK: - Class filtering

/// The COCO manifest carries the 80-class label order; the module keeps six
/// (10 §6). Anything else is dropped before the tracker sees it.
public enum CocoLabels {
  public static let kept: [String: DetectionClass] = [
    "car": .car, "bus": .bus, "truck": .truck, "motorcycle": .motorcycle,
    "bicycle": .bicycle, "person": .person,
  ]

  public static func detectionClass(for label: String) -> DetectionClass? {
    kept[label.lowercased()]
  }
}
