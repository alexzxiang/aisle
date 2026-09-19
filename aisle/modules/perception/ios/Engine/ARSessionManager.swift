//
//  ARSessionManager.swift
//  Aisle — PerceptionModule engine
//
//  The single camera owner (09 §1). One headless `ARSession` — a delegate, no
//  `ARSCNView` — on `ARWorldTrackingConfiguration` with `.gravityAndHeading`,
//  so yaw 0 is true north and the pose is usable as a heading and as a
//  centimetre-level relative position without LiDAR.
//
//  This file owns everything that comes from `ARFrame.camera` and the session
//  lifecycle, and nothing that touches pixels:
//
//    - configuration + video format selection (lowest-res 30 fps format with
//      width ≥ 1280; never 60 fps);
//    - tracking-state mapping (`NOT_AVAILABLE | LIMITED | NORMAL`) with the
//      LIMITED > 2 s drift freeze and the NOT_AVAILABLE > 5 s one-shot reset;
//    - interruptions (stop scheduling; on end re-run with `.resetTracking`, reset
//      filters, re-arm the signal gate);
//    - pose → yaw (deg, 0 = north), position (m), pitch → horizon row, yaw rate;
//    - `setCourseReference` → signed lateral offset against a bearing line
//      (+ = right), 5 Hz, smoothed 1 s, frozen when LIMITED;
//    - plane detection summary at 1 Hz.
//
//  The pure geometry (`WorldGeometry`, `DriftEstimator`) lives in
//  `Geometry.swift`, which imports no ARKit, so the drift math is unit-testable
//  with synthetic transforms on a Mac: a straight track yields 0 ± 0.02 m and a
//  0.5 m parallel offset yields 0.5 m (09 §10, `modules/perception/tests/`).
//

import ARKit
import Foundation
import simd

// MARK: - Tracking state mapping

extension TrackingStateName {
  public init(_ state: ARCamera.TrackingState) {
    switch state {
    case .notAvailable: self = .notAvailable
    case .limited: self = .limited
    case .normal: self = .normal
    }
  }
}

/// The two timers 09 §2 puts on tracking state: LIMITED > 2 s freezes the
/// pose-derived drift; NOT_AVAILABLE > 5 s triggers one tracking reset.
public struct TrackingWatchdog {
  public static let limitedFreezeSeconds = 2.0
  public static let notAvailableResetSeconds = 5.0

  public private(set) var state: TrackingStateName = .notAvailable
  public private(set) var limitedByMotion = false
  private var stateSince: Double?
  private var resetIssued = false

  public init() {}

  public struct Update: Equatable {
    public var changed: Bool
    public var driftFrozen: Bool
    public var shouldResetTracking: Bool
  }

  public mutating func update(_ arState: ARCamera.TrackingState, at t: Double) -> Update {
    let next = TrackingStateName(arState)
    if case .limited(let reason) = arState {
      limitedByMotion = reason == .excessiveMotion
    } else {
      limitedByMotion = false
    }
    let changed = next != state
    if changed {
      state = next
      stateSince = t
      resetIssued = false
    } else if stateSince == nil {
      stateSince = t
    }
    let held = t - (stateSince ?? t)

    let frozen = state != .normal && (state == .notAvailable || held >= TrackingWatchdog.limitedFreezeSeconds)
    var reset = false
    if state == .notAvailable && held >= TrackingWatchdog.notAvailableResetSeconds && !resetIssued {
      resetIssued = true
      reset = true
    }
    return Update(changed: changed, driftFrozen: frozen, shouldResetTracking: reset)
  }

  public mutating func reset() {
    state = .notAvailable
    limitedByMotion = false
    stateSince = nil
    resetIssued = false
  }
}

// MARK: - Video format

public enum VideoFormatPolicy {
  /// Field of view first, pixels second (the user held the phone in a kitchen
  /// and the app saw a letterboxed strip):
  ///   1. the ultra-wide camera when ARKit offers it (iOS 14.5+
  ///      `captureDeviceType`; ~120° instead of ~70°),
  ///   2. a 4:3 format over 16:9 (16:9 formats crop the sensor's top and
  ///      bottom, which is exactly the floor and the shelf we need),
  ///   3. 30 fps, never 60 (09 §2),
  ///   4. then the fewest pixels with width ≥ 1280.
  /// Falls back to the first 30 fps format, then to ARKit's default.
  public static func pick(from formats: [ARConfiguration.VideoFormat]) -> ARConfiguration.VideoFormat? {
    let thirty = formats.filter { $0.framesPerSecond == 30 }
    let candidates = thirty.isEmpty ? formats : thirty
    guard !candidates.isEmpty else { return nil }
    return candidates.min { lhs, rhs in
      let l = score(lhs)
      let r = score(rhs)
      if l.ultraWide != r.ultraWide { return l.ultraWide }
      if l.fourByThree != r.fourByThree { return l.fourByThree }
      if l.bigEnough != r.bigEnough { return l.bigEnough }
      return l.pixels < r.pixels
    }
  }

  static func score(_ f: ARConfiguration.VideoFormat) -> (ultraWide: Bool, fourByThree: Bool, bigEnough: Bool, pixels: CGFloat) {
    let w = f.imageResolution.width
    let h = f.imageResolution.height
    let aspect = h > 0 ? w / h : 0
    var ultraWide = false
    if #available(iOS 14.5, *) {
      ultraWide = f.captureDeviceType == .builtInUltraWideCamera
    }
    return (ultraWide, abs(aspect - 4.0 / 3.0) < 0.05, w >= 1280, w * h)
  }

  public static func describe(_ format: ARConfiguration.VideoFormat) -> String {
    var lens = "wide"
    if #available(iOS 14.5, *) {
      if format.captureDeviceType == .builtInUltraWideCamera { lens = "ultrawide" }
    }
    return "\(Int(format.imageResolution.width))x\(Int(format.imageResolution.height))@\(format.framesPerSecond) \(lens)"
  }
}

// MARK: - Session manager

/// What the engine needs from a frame, computed once (09 §2 "do the rotation
/// once per pipeline, not per model" applies to geometry too).
public struct FrameContext {
  public var frame: ARFrame
  public var geometry: FrameGeometry
  public var pose: PosePayload
  public var pitchDeg: Double
  /// Sensor-orientation buffer; every consumer applies `orientation`.
  public var pixelBuffer: CVPixelBuffer
  public var orientation: CGImagePropertyOrientation
  public var frameIndex: Int
  /// `Date.now()`-comparable milliseconds.
  public var timestampMs: Double
}

public protocol ARSessionManagerDelegate: AnyObject {
  func sessionManager(_ manager: ARSessionManager, didUpdate context: FrameContext)
  func sessionManager(_ manager: ARSessionManager, trackingStateChanged state: TrackingStateName)
  func sessionManager(_ manager: ARSessionManager, lateralOffset payload: LateralOffsetPayload)
  func sessionManager(_ manager: ARSessionManager, planes payload: PlanesPayload)
  func sessionManagerWasInterrupted(_ manager: ARSessionManager)
  func sessionManagerInterruptionEnded(_ manager: ARSessionManager)
  func sessionManager(_ manager: ARSessionManager, didFail error: Error)
}

public final class ARSessionManager: NSObject, ARSessionDelegate {
  public weak var delegate: ARSessionManagerDelegate?

  public let session = ARSession()
  /// Serial queue for every delegate callback and every piece of engine state.
  public let frameQueue = DispatchQueue(label: "aisle.perception.frames", qos: .userInteractive)

  /// 09 §5.6: the module applies `bodyOffsetDeg` to yaw before any heading
  /// comparison. Body heading = yaw − bodyOffsetDeg.
  public var bodyOffsetDeg: Double = 0

  public private(set) var chosenFormat: String = "default"
  public private(set) var isRunning = false
  public private(set) var isInterrupted = false
  public private(set) var frameIndex = 0
  public private(set) var lastFrameContext: FrameContext?
  /// The sharpest frame of the last second, copied out of ARKit's pool (round 6).
  public let sharpFrames = SharpFrameKeeper()

  private var watchdog = TrackingWatchdog()
  private var drift = DriftEstimator()
  private var yawHistory = TimedSamples<Double>(windowSeconds: 0.3)
  private var planeLimiter = RateLimiter(intervalSeconds: 1.0)
  private var floors: Set<UUID> = []
  private var verticals: Set<UUID> = []
  /// `frame.timestamp` is seconds since boot; convert once to epoch ms.
  private var timestampOffsetMs: Double?
  /// A course reference requested before the first frame is applied on it.
  private var pendingCourseBearing: Double?
  private var lastPitchDeg: Double = 0

  public override init() {
    super.init()
    session.delegate = self
    session.delegateQueue = frameQueue
  }

  // MARK: Configuration

  public func makeConfiguration() -> ARWorldTrackingConfiguration {
    let config = ARWorldTrackingConfiguration()
    config.worldAlignment = .gravityAndHeading
    config.planeDetection = [.horizontal, .vertical]
    config.environmentTexturing = .none
    config.isAutoFocusEnabled = true
    if let format = VideoFormatPolicy.pick(from: ARWorldTrackingConfiguration.supportedVideoFormats) {
      config.videoFormat = format
      chosenFormat = VideoFormatPolicy.describe(format)
    }
    return config
  }

  public func run() {
    guard ARWorldTrackingConfiguration.isSupported else {
      delegate?.sessionManager(self, didFail: ARSessionManagerError.worldTrackingUnsupported)
      return
    }
    let config = makeConfiguration()
    session.run(config, options: [.resetTracking, .removeExistingAnchors])
    isRunning = true
    isInterrupted = false
  }

  /// `resetTracking` only: keeps anchors, used by the NOT_AVAILABLE watchdog and
  /// by interruption recovery (09 §2).
  public func resetTracking() {
    guard isRunning else { return }
    session.run(makeConfiguration(), options: [.resetTracking])
  }

  public func pause() {
    session.pause()
    sharpFrames.reset()   // a paused session must not hand out an old room
    isRunning = false
    frameQueue.async { [weak self] in
      self?.watchdog.reset()
      self?.yawHistory.reset()
    }
  }

  // MARK: Context setters (call on any queue; applied on frameQueue)

  public func setCourseReference(bearingDeg: Double?) {
    frameQueue.async { [weak self] in
      guard let self else { return }
      guard let bearingDeg else {
        self.drift.clear()
        self.pendingCourseBearing = nil
        return
      }
      if let ctx = self.lastFrameContext {
        let p = SIMD3<Double>(ctx.pose.x, ctx.pose.y, ctx.pose.z)
        self.drift.anchor(at: p, bearingDeg: bearingDeg)
        self.pendingCourseBearing = nil
      } else {
        self.pendingCourseBearing = bearingDeg
      }
    }
  }

  public func setBodyOffsetDeg(_ deg: Double) {
    frameQueue.async { [weak self] in
      self?.bodyOffsetDeg = deg
    }
  }

  public var trackingState: TrackingStateName {
    watchdog.state
  }

  public var isCourseAnchored: Bool { drift.isAnchored }

  // MARK: ARSessionDelegate

  public func session(_ session: ARSession, didUpdate frame: ARFrame) {
    guard isRunning, !isInterrupted else { return }
    frameIndex += 1

    let nowSeconds = frame.timestamp
    if timestampOffsetMs == nil {
      timestampOffsetMs = Date().timeIntervalSince1970 * 1000 - nowSeconds * 1000
    }
    let timestampMs = nowSeconds * 1000 + (timestampOffsetMs ?? 0)

    let transform = frame.camera.transform
    let yaw = WorldGeometry.yawDeg(from: transform)
    let pitch = WorldGeometry.pitchDeg(from: transform)
    let position = WorldGeometry.position(from: transform)
    lastPitchDeg = pitch

    // Tracking state and its two watchdog timers.
    let tracking = watchdog.update(frame.camera.trackingState, at: nowSeconds)
    if tracking.changed {
      delegate?.sessionManager(self, trackingStateChanged: watchdog.state)
    }
    if tracking.shouldResetTracking {
      resetTracking()
    }

    // Yaw rate over the last ~0.3 s (looming sweep suppression, OCR blur gate).
    yawHistory.push(yaw, at: nowSeconds)
    var yawRate = 0.0
    if let oldest = yawHistory.oldest, nowSeconds > oldest.t {
      yawRate = Angles.wrapSigned(yaw - oldest.value) / (nowSeconds - oldest.t)
    }

    // Horizon row from pitch + intrinsics (sensor width = upright height).
    let sensorWidth = Double(CVPixelBufferGetWidth(frame.capturedImage))
    let horizon = WorldGeometry.horizonRow(
      pitchDeg: pitch, intrinsics: frame.camera.intrinsics, sensorWidth: sensorWidth)

    let bodyHeading = Angles.wrapUnsigned(yaw - bodyOffsetDeg)
    let geometry = FrameGeometry(
      bodyHeadingDeg: bodyHeading, horizonRow: horizon, yawRateDegPerSec: yawRate,
      trackingState: watchdog.state, timestamp: nowSeconds)
    let pose = PosePayload(
      yawDeg: yaw, x: position.x, y: position.y, z: position.z,
      trackingState: watchdog.state, timestamp: timestampMs)

    let context = FrameContext(
      frame: frame, geometry: geometry, pose: pose, pitchDeg: pitch,
      pixelBuffer: frame.capturedImage, orientation: .right,
      frameIndex: frameIndex, timestampMs: timestampMs)
    lastFrameContext = context
    // Round 6: keep a private copy of the sharpest recent frame for stills (SharpFrameKeeper.swift).
    sharpFrames.offer(pixelBuffer: frame.capturedImage, orientation: .right, horizonRow: horizon,
                      timestampMs: timestampMs, now: nowSeconds)

    // A course reference set before the first frame anchors now.
    if let pending = pendingCourseBearing {
      drift.anchor(at: position, bearingDeg: pending)
      pendingCourseBearing = nil
    }
    if let offset = drift.update(position: position, frozen: tracking.driftFrozen, at: nowSeconds) {
      delegate?.sessionManager(self, lateralOffset: offset)
    }

    delegate?.sessionManager(self, didUpdate: context)
  }

  public func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    updatePlanes(added: anchors, removed: [])
  }

  public func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    updatePlanes(added: [], removed: anchors)
  }

  private func updatePlanes(added: [ARAnchor], removed: [ARAnchor]) {
    for case let plane as ARPlaneAnchor in added {
      if plane.alignment == .horizontal { floors.insert(plane.identifier) } else { verticals.insert(plane.identifier) }
    }
    for case let plane as ARPlaneAnchor in removed {
      floors.remove(plane.identifier)
      verticals.remove(plane.identifier)
    }
    let t = lastFrameContext?.geometry.timestamp ?? Date().timeIntervalSince1970
    if planeLimiter.allow(at: t) {
      delegate?.sessionManager(self, planes: PlanesPayload(floors: floors.count, verticals: verticals.count))
    }
  }

  public func sessionWasInterrupted(_ session: ARSession) {
    isInterrupted = true
    delegate?.sessionManagerWasInterrupted(self)
  }

  public func sessionInterruptionEnded(_ session: ARSession) {
    isInterrupted = false
    watchdog.reset()
    yawHistory.reset()
    if isRunning {
      session.run(makeConfiguration(), options: [.resetTracking])
    }
    delegate?.sessionManagerInterruptionEnded(self)
  }

  public func session(_ session: ARSession, didFailWithError error: Error) {
    isRunning = false
    delegate?.sessionManager(self, didFail: error)
  }

  public func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool {
    // Relocalizing to a stale map in a moving user's hand mostly fails; a fresh
    // start is what the interruption path already does.
    false
  }

  /// Current plane summary on demand (the 1 Hz emit is edge-triggered on anchor
  /// changes; the engine also polls once a second so a static scene still reports).
  public func planesSnapshot() -> PlanesPayload {
    PlanesPayload(floors: floors.count, verticals: verticals.count)
  }

  public var limitedByMotion: Bool { watchdog.limitedByMotion }
}

public enum ARSessionManagerError: Error, CustomStringConvertible {
  case worldTrackingUnsupported

  public var description: String {
    switch self {
    case .worldTrackingUnsupported:
      return "ARWorldTrackingConfiguration is not supported on this device"
    }
  }
}
