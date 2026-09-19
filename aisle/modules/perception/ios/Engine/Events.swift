//
//  Events.swift
//  Aisle — PerceptionModule engine
//
//  Event names and payload structs, matching `01-SHARED-CONTRACTS.md` §7 and
//  `09-PERCEPTION-MODULE.md` §6 field for field. Nothing in this file imports
//  ExpoModulesCore: the engine is plain Swift so it can be typechecked and
//  unit-tested without the Expo toolchain, and the wrapper in
//  `../PerceptionModule.swift` is the only file that knows about Expo.
//
//  Two representations per payload:
//    - `Codable`, for the jsonl debug export (09 §10) that D's replayer consumes;
//    - `dictionary`, the `[String: Any]` the Expo Modules API sends to JS.
//  Both are generated from the same struct so a fixture and a live event cannot
//  disagree about a field name.
//
//  Boxes are `[x, y, w, h]`, normalized 0..1, ORIGIN TOP-LEFT of the UPRIGHT
//  (portrait) frame. Timestamps are `Date.now()`-comparable milliseconds.
//

import Foundation

// MARK: - Event names

/// Exactly the events in 01 §7. The raw value is the name the JS bridge
/// subscribes to, so a typo here is a dead subscription, not a compile error —
/// `PerceptionEventName.allCases` is mirrored by `Events(...)` in the wrapper
/// and by `EVENT_NAMES` in `../index.ts`.
public enum PerceptionEventName: String, CaseIterable, Sendable {
  case signalState = "onSignalState"
  case vehicleApproaching = "onVehicleApproaching"
  case obstacleAhead = "onObstacleAhead"
  case hazard = "onHazard"
  case ocrText = "onOcrText"
  case detections = "onDetections"
  case pose = "onPose"
  case lateralOffset = "onLateralOffset"
  case planes = "onPlanes"
  case depth = "onDepth"
  case trackingState = "onTrackingState"
  case sceneClass = "onSceneClass"   // round 6: Apple's scene classifier, top labels
}

// MARK: - Enumerations (raw values are the contract strings)

public enum SignalState: String, Codable, CaseIterable, Sendable {
  case walk = "WALK"
  case dontWalk = "DONT_WALK"
  case countdown = "COUNTDOWN"
  case unknown = "UNKNOWN"
}

public enum Direction: String, Codable, CaseIterable, Sendable {
  case left = "LEFT"
  case center = "CENTER"
  case right = "RIGHT"

  /// 01 §7 / 09 §5.2: `< 0.33` LEFT, `> 0.67` RIGHT, else CENTER, from the box
  /// centre x in the upright frame.
  public static func fromCenterX(_ x: Double) -> Direction {
    if x < 0.33 { return .left }
    if x > 0.67 { return .right }
    return .center
  }
}

public enum DistanceClass: String, Codable, CaseIterable, Sendable {
  case near = "NEAR"
  case mid = "MID"
  case far = "FAR"
}

public enum HazardKind: String, Codable, CaseIterable, Sendable {
  case personAhead = "PERSON_AHEAD"
  case cartAhead = "CART_AHEAD"
}

public enum TrackingStateName: String, Codable, CaseIterable, Sendable {
  case notAvailable = "NOT_AVAILABLE"
  case limited = "LIMITED"
  case normal = "NORMAL"
}

/// `onLateralOffset.source` (01 §7). `none` means "no usable estimate" — JS
/// feeds 0 and lets heading alone drive (04 Task 6).
public enum LateralOffsetSource: String, Codable, CaseIterable, Sendable {
  case pose
  case ocrBox = "ocr_box"
  case shelf
  case curb
  case none
}

/// `Detection.cls` (01 §7). The signal classes are the three the trained model
/// emits, in the label order frozen in `10-CV-TRAINING-TRACK.md` §6.
public enum DetectionClass: String, Codable, CaseIterable, Sendable {
  case car
  case bus
  case truck
  case motorcycle
  case bicycle
  case person
  case cart
  case pedWalk = "ped_walk"
  case pedHand = "ped_hand"
  case pedCountdown = "ped_countdown"
  // Round 6: the surroundings. COCO already sees these at 15 fps; keeping them
  // is what lets the app say "couch ahead, tv on your left" without a network
  // call and gives Claude facts to anchor on. None of these reach the vehicle,
  // hazard or signal filters (those use the sets below).
  case chair
  case couch
  case bed
  case table
  case tv
  case laptop
  case fridge
  case oven
  case microwave
  case sink
  case toilet
  case bottle
  case cup
  case bowl
  case plant
  case book
  case clock
  case dog
  case cat
  case backpack
  case handbag
  case suitcase
  case umbrella
  case trafficLight = "traffic_light"
  case stopSign = "stop_sign"
  case hydrant
  case bench
  // Round 6b: food and kitchen things (a task like "find the eggs" lives among them).
  case banana
  case apple
  case sandwich
  case orange
  case broccoli
  case carrot
  case pizza
  case donut
  case cake
  case wineGlass = "wine_glass"
  case fork
  case knife
  case spoon
  case remote
  case keyboard
  case cellPhone = "cell_phone"
  case toaster
  case vase
  case scissors
  case teddyBear = "teddy_bear"
  case toothbrush
  case hairDrier = "hair_drier"
  case mouse
  case tie

  /// Classes 09 §5.2 treats as vehicles for the looming filter.
  public static let vehicleClasses: Set<DetectionClass> = [.car, .bus, .truck, .motorcycle, .bicycle]
  /// Classes 09 §5.4 treats as indoor hazards.
  public static let hazardClasses: Set<DetectionClass> = [.person, .cart]
  /// Classes 09 §5.1 feeds to the signal filter.
  public static let signalClasses: Set<DetectionClass> = [.pedWalk, .pedHand, .pedCountdown]
  /// Everything that is scenery rather than a hazard: reported, never acted on.
  public static let sceneClasses: Set<DetectionClass> = [
    .chair, .couch, .bed, .table, .tv, .laptop, .fridge, .oven, .microwave, .sink, .toilet,
    .bottle, .cup, .bowl, .plant, .book, .clock, .dog, .cat, .backpack, .handbag, .suitcase,
    .umbrella, .trafficLight, .stopSign, .hydrant, .bench,
    .banana, .apple, .sandwich, .orange, .broccoli, .carrot, .pizza, .donut, .cake, .wineGlass, .fork, .knife,
    .spoon, .remote, .keyboard, .cellPhone, .toaster, .vase, .scissors, .teddyBear, .toothbrush, .hairDrier, .mouse, .tie,
  ]

  /// The signal state a per-frame signal detection votes for; `nil` for
  /// everything that is not a pedestrian head.
  public var signalState: SignalState? {
    switch self {
    case .pedWalk: return .walk
    case .pedHand: return .dontWalk
    case .pedCountdown: return .countdown
    default: return nil
    }
  }
}

/// `ModeProfile` (01 §7). `AT_CURB` maps to `APPROACH_CROSSING` and
/// `TRANSITION` to `OUTDOOR_NAV` in JS, so the native side never sees them.
public enum ModeProfile: String, Codable, CaseIterable, Sendable {
  case idle = "IDLE"
  case outdoorNav = "OUTDOOR_NAV"
  case approachCrossing = "APPROACH_CROSSING"
  case crossing = "CROSSING"
  case indoorNav = "INDOOR_NAV"
  case itemPickup = "ITEM_PICKUP"
  /// Round 6c: the home screen. The camera is up for awareness (scenery detector, depth for
  /// "close", the scene classifier) at rates a phone can hold all day; no OCR, no signal model.
  case aware = "AWARE"
}

// MARK: - Geometry

/// Normalized box in the upright frame, origin top-left.
public struct NormalizedBox: Codable, Equatable, Sendable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }

  public var area: Double { max(0, w) * max(0, h) }
  public var centerX: Double { x + w / 2 }
  public var centerY: Double { y + h / 2 }
  public var bottom: Double { y + h }
  public var right: Double { x + w }
  public var array: [Double] { [x, y, w, h] }

  /// Vision → upright. Vision's `boundingBox` is bottom-left origin and
  /// normalized to the *processed* image, which with a `regionOfInterest` set is
  /// the ROI crop. Map to a top-left-origin, full-frame box. The one mapping
  /// every pipeline uses (OCR, COCO, signal), so a fix lands once.
  /// [verify in phase 0 on a printed sign held at a known corner.]
  public static func fromVision(minX: Double, minY: Double, width: Double, height: Double,
                                roi: (x: Double, y: Double, w: Double, h: Double)?) -> NormalizedBox {
    var x = minX
    var w = width
    var yTop = 1 - (minY + height)
    var h = height
    if let roi {
      x = roi.x + x * roi.w
      w *= roi.w
      let roiTop = 1 - (roi.y + roi.h)
      yTop = roiTop + yTop * roi.h
      h *= roi.h
    }
    let cx = min(max(0, x), 1)
    let cy = min(max(0, yTop), 1)
    return NormalizedBox(x: cx, y: cy, w: max(0, min(w, 1 - cx)), h: max(0, min(h, 1 - cy)))
  }

  public func intersectionOverUnion(_ other: NormalizedBox) -> Double {
    let ix = max(0, min(right, other.right) - max(x, other.x))
    let iy = max(0, min(bottom, other.bottom) - max(y, other.y))
    let inter = ix * iy
    let union = area + other.area - inter
    guard union > 0 else { return 0 }
    return inter / union
  }
}

// MARK: - Payloads

/// A payload that can cross the bridge as plain JSON.
public protocol PerceptionPayload: Codable {
  var dictionary: [String: Any] { get }
}

public struct SignalStatePayload: PerceptionPayload, Equatable {
  public var state: SignalState
  public var fresh: Bool
  public var confidence: Double
  public var nOfM: Int

  public init(state: SignalState, fresh: Bool, confidence: Double, nOfM: Int) {
    self.state = state
    self.fresh = fresh
    self.confidence = confidence
    self.nOfM = nOfM
  }

  public var dictionary: [String: Any] {
    ["state": state.rawValue, "fresh": fresh, "confidence": confidence, "nOfM": nOfM]
  }
}

public struct VehicleApproachingPayload: PerceptionPayload, Equatable {
  public var direction: Direction
  public var trackId: Int
  public var growth: Double

  public init(direction: Direction, trackId: Int, growth: Double) {
    self.direction = direction
    self.trackId = trackId
    self.growth = growth
  }

  public var dictionary: [String: Any] {
    ["direction": direction.rawValue, "trackId": trackId, "growth": growth]
  }
}

public struct ObstacleAheadPayload: PerceptionPayload, Equatable {
  public var distanceClass: DistanceClass
  public var direction: Direction

  public init(distanceClass: DistanceClass, direction: Direction) {
    self.distanceClass = distanceClass
    self.direction = direction
  }

  public var dictionary: [String: Any] {
    ["distanceClass": distanceClass.rawValue, "direction": direction.rawValue]
  }
}

public struct HazardPayload: PerceptionPayload, Equatable {
  public var kind: HazardKind
  public var direction: Direction

  public init(kind: HazardKind, direction: Direction) {
    self.kind = kind
    self.direction = direction
  }

  public var dictionary: [String: Any] {
    ["kind": kind.rawValue, "direction": direction.rawValue]
  }
}

/// `OcrRead` (01 §7). `text` is **raw**, exactly as Vision returned it: 09 §5.5
/// freezes normalization into JS so a replayed fixture and a live frame
/// normalize identically. Only the box is normalized here, into the upright
/// frame, because only Swift knows the sensor orientation.
public struct OcrReadPayload: PerceptionPayload, Equatable {
  public var text: String
  public var box: NormalizedBox
  public var confidence: Double
  public var timestamp: Double

  public init(text: String, box: NormalizedBox, confidence: Double, timestamp: Double) {
    self.text = text
    self.box = box
    self.confidence = confidence
    self.timestamp = timestamp
  }

  public var dictionary: [String: Any] {
    ["text": text, "box": box.array, "confidence": confidence, "timestamp": timestamp]
  }
}

public struct DetectionPayload: PerceptionPayload, Equatable {
  public var cls: DetectionClass
  public var box: NormalizedBox
  public var score: Double
  public var trackId: Int
  /// Round 6b: relative nearness at the box centre from the depth grid (0 far … 1 near), when a grid is fresh.
  public var near: Double?

  public init(cls: DetectionClass, box: NormalizedBox, score: Double, trackId: Int, near: Double? = nil) {
    self.cls = cls
    self.box = box
    self.score = score
    self.trackId = trackId
    self.near = near
  }

  public var dictionary: [String: Any] {
    var d: [String: Any] = ["cls": cls.rawValue, "box": box.array, "score": score, "trackId": trackId]
    if let near { d["near"] = near }
    return d
  }
}

public struct PosePayload: PerceptionPayload, Equatable {
  public var yawDeg: Double
  public var x: Double
  public var y: Double
  public var z: Double
  public var trackingState: TrackingStateName
  public var timestamp: Double

  public init(yawDeg: Double, x: Double, y: Double, z: Double,
              trackingState: TrackingStateName, timestamp: Double) {
    self.yawDeg = yawDeg
    self.x = x
    self.y = y
    self.z = z
    self.trackingState = trackingState
    self.timestamp = timestamp
  }

  public var dictionary: [String: Any] {
    [
      "yawDeg": yawDeg, "x": x, "y": y, "z": z,
      "trackingState": trackingState.rawValue, "timestamp": timestamp,
    ]
  }
}

public struct LateralOffsetPayload: PerceptionPayload, Equatable {
  public var offsetM: Double
  public var source: LateralOffsetSource

  public init(offsetM: Double, source: LateralOffsetSource) {
    self.offsetM = offsetM
    self.source = source
  }

  public var dictionary: [String: Any] {
    ["offsetM": offsetM, "source": source.rawValue]
  }
}

public struct PlanesPayload: PerceptionPayload, Equatable {
  public var floors: Int
  public var verticals: Int

  public init(floors: Int, verticals: Int) {
    self.floors = floors
    self.verticals = verticals
  }

  public var dictionary: [String: Any] {
    ["floors": floors, "verticals": verticals]
  }
}

public struct DepthSummaryPayload: PerceptionPayload, Equatable {
  public var centerBottomRel: Double
  public var closingRate: Double
  public var timestamp: Double
  /// Round 6b: the left and right bottom cells too, so JS can say "path ahead blocked, open to your left".
  public var leftBottomRel: Double?
  public var rightBottomRel: Double?

  public init(centerBottomRel: Double, closingRate: Double, timestamp: Double,
              leftBottomRel: Double? = nil, rightBottomRel: Double? = nil) {
    self.centerBottomRel = centerBottomRel
    self.closingRate = closingRate
    self.timestamp = timestamp
    self.leftBottomRel = leftBottomRel
    self.rightBottomRel = rightBottomRel
  }

  public var dictionary: [String: Any] {
    var d: [String: Any] = ["centerBottomRel": centerBottomRel, "closingRate": closingRate, "timestamp": timestamp]
    if let leftBottomRel { d["leftBottomRel"] = leftBottomRel }
    if let rightBottomRel { d["rightBottomRel"] = rightBottomRel }
    return d
  }
}

public struct TrackingStatePayload: PerceptionPayload, Equatable {
  public var state: TrackingStateName

  public init(state: TrackingStateName) {
    self.state = state
  }

  /// The JS callback receives the bare string (01 §7:
  /// `onTrackingState(cb: (s: TrackingState) => void)`), so the wrapper sends
  /// `{ "state": ... }` and `../index.ts` unwraps it. One shape on the wire.
  public var dictionary: [String: Any] { ["state": state.rawValue] }
}

/// `getStats()` — exactly the five fields frozen in 01 §7 and nothing else.
/// Per-model fps and per-stage ms go to the debug export, not here (09 §6).
public struct StatsPayload: PerceptionPayload, Equatable {
  public var detectorFps: Double
  public var depthFps: Double
  public var ocrFps: Double
  public var frameToEventMs: Double
  public var thermalState: String

  public init(detectorFps: Double, depthFps: Double, ocrFps: Double,
              frameToEventMs: Double, thermalState: String) {
    self.detectorFps = detectorFps
    self.depthFps = depthFps
    self.ocrFps = ocrFps
    self.frameToEventMs = frameToEventMs
    self.thermalState = thermalState
  }

  public static let zero = StatsPayload(
    detectorFps: 0, depthFps: 0, ocrFps: 0, frameToEventMs: 0, thermalState: "nominal")

  public var dictionary: [String: Any] {
    [
      "detectorFps": detectorFps, "depthFps": depthFps, "ocrFps": ocrFps,
      "frameToEventMs": frameToEventMs, "thermalState": thermalState,
    ]
  }
}

/// `snapshotJPEG` return value (01 §7).
public struct SnapshotPayload: PerceptionPayload, Equatable {
  public var base64: String
  public var width: Int
  public var height: Int
  public var seq: Int
  public var timestamp: Double

  public init(base64: String, width: Int, height: Int, seq: Int, timestamp: Double) {
    self.base64 = base64
    self.width = width
    self.height = height
    self.seq = seq
    self.timestamp = timestamp
  }

  public var dictionary: [String: Any] {
    ["base64": base64, "width": width, "height": height, "seq": seq, "timestamp": timestamp]
  }
}

// MARK: - Debug export (09 §10)

/// One line of `fixtures/perception/*.jsonl`, in the shape agreed with D
/// (05 Part 1): `{"t": 1234, "event": "onSignalState", "payload": {...}}`.
/// `t` is milliseconds from fixture start.
///
/// `payload` is the **01 §7 callback shape**, not the bridge envelope: D's
/// replayer (`mocks/perception.ts`) dispatches each line's payload straight to
/// the `PerceptionService` callback, so `onOcrText` / `onDetections` lines carry
/// a bare array and `onTrackingState` a bare string. `PerceptionEngine`
/// unwraps the `{items}` / `{state}` envelopes before recording — the export
/// must be consumable by the replayer unchanged (09 §11).
public struct DebugExportLine: Codable, Equatable {
  public var t: Double
  public var event: String
  public var payload: JSONValue

  public init(t: Double, event: String, payload: JSONValue) {
    self.t = t
    self.event = event
    self.payload = payload
  }

  /// The bridge sends `{items: [...]}` for the array events and `{state: "..."}`
  /// for tracking state (Expo events are dictionaries); the jsonl export records
  /// the 01 §7 callback shape instead, which is what D's replayer dispatches.
  public static func payload(for event: PerceptionEventName, wire payload: [String: Any]) -> JSONValue {
    switch event {
    case .ocrText, .detections:
      if let items = payload["items"] as? [Any] {
        return .array(items.map { JSONValue.from($0) })
      }
      return .array([])
    case .trackingState:
      if let state = payload["state"] as? String {
        return .string(state)
      }
      return .null
    default:
      return .object(payload.mapValues { JSONValue.from($0) })
    }
  }
}

/// A minimal JSON value so `DebugExportLine` stays `Codable` without `Any`.
public enum JSONValue: Codable, Equatable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case array([JSONValue])
  case object([String: JSONValue])
  case null

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let d = try? c.decode(Double.self) {
      self = .number(d)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else if let o = try? c.decode([String: JSONValue].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let s): try c.encode(s)
    case .number(let d): try c.encode(d)
    case .bool(let b): try c.encode(b)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    case .null: try c.encodeNil()
    }
  }

  /// Best-effort conversion from the `[String: Any]` the bridge sends, so the
  /// debug export and the live event carry byte-identical payloads.
  public static func from(_ any: Any) -> JSONValue {
    switch any {
    case let v as String: return .string(v)
    case let v as Bool: return .bool(v)
    case let v as Int: return .number(Double(v))
    case let v as Double: return .number(v)
    case let v as Float: return .number(Double(v))
    case let v as [Any]: return .array(v.map { JSONValue.from($0) })
    case let v as [String: Any]: return .object(v.mapValues { JSONValue.from($0) })
    default: return .null
    }
  }
}
