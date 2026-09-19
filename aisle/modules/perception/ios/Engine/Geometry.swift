//
//  Geometry.swift
//  Aisle — PerceptionModule engine
//
//  Pure math over ARKit's `.gravityAndHeading` world frame and the pose-derived
//  drift estimator (09 §5.6). No ARKit import: `simd` transforms in, numbers
//  out, so the 09 §10 drift checks run on a Mac without a device
//  (`modules/perception/tests/run.sh`). `ARSessionManager.swift` feeds it real
//  `frame.camera.transform`s; the checks feed it synthetic ones.
//

import Foundation
import simd

// MARK: - Pure geometry

/// Math over ARKit's `.gravityAndHeading` world frame: +y up, −z true north,
/// +x east. Camera looks down its own −z.
public enum WorldGeometry {
  /// Heading of the camera's optical axis, degrees clockwise from true north.
  public static func yawDeg(from transform: simd_float4x4) -> Double {
    let forward = -simd_make_float3(transform.columns.2)
    let heading = atan2(Double(forward.x), Double(-forward.z))
    return Angles.wrapUnsigned(Angles.toDegrees(heading))
  }

  /// Elevation of the optical axis above horizontal, degrees (+ = tilted up).
  /// Orientation-independent, unlike `eulerAngles.x`.
  public static func pitchDeg(from transform: simd_float4x4) -> Double {
    let forward = -simd_make_float3(transform.columns.2)
    let clamped = max(-1, min(1, Double(forward.y)))
    return Angles.toDegrees(asin(clamped))
  }

  public static func position(from transform: simd_float4x4) -> SIMD3<Double> {
    let p = transform.columns.3
    return SIMD3<Double>(Double(p.x), Double(p.y), Double(p.z))
  }

  /// Unit vector along a bearing in the (x, z) ground plane.
  public static func groundDirection(bearingDeg: Double) -> SIMD2<Double> {
    let r = Angles.toRadians(bearingDeg)
    return SIMD2<Double>(sin(r), -cos(r))
  }

  /// Signed perpendicular distance of `position` from the line through `anchor`
  /// along `bearingDeg`; + = right of the line when facing along it.
  public static func lateralOffset(position: SIMD3<Double>, anchor: SIMD3<Double>, bearingDeg: Double) -> Double {
    let d = groundDirection(bearingDeg: bearingDeg)
    let right = SIMD2<Double>(-d.y, d.x)
    let delta = SIMD2<Double>(position.x - anchor.x, position.z - anchor.z)
    return simd_dot(delta, right)
  }

  /// Distance travelled along the line (for the JS dead-reckoning cross-check).
  public static func alongTrack(position: SIMD3<Double>, anchor: SIMD3<Double>, bearingDeg: Double) -> Double {
    let d = groundDirection(bearingDeg: bearingDeg)
    let delta = SIMD2<Double>(position.x - anchor.x, position.z - anchor.z)
    return simd_dot(delta, d)
  }

  /// Horizon row in the upright frame, normalized 0 (top) … 1 (bottom), from
  /// the camera pitch and the sensor intrinsics (09 §2). For a portrait-held
  /// phone (`.right`), sensor +x runs down the upright frame, so the vertical
  /// focal length and principal point are the sensor's x terms. Tilting up
  /// moves the horizon down the frame.
  ///
  /// [verify on the demo phone in phase 0: the sign convention against a
  /// spirit level; flip `+` to `−` here and nowhere else if it is mirrored.]
  public static func horizonRow(pitchDeg: Double, intrinsics: simd_float3x3, sensorWidth: Double) -> Double? {
    guard sensorWidth > 0, abs(pitchDeg) < 80 else { return nil }
    let fx = Double(intrinsics.columns.0.x)
    let cx = Double(intrinsics.columns.2.x)
    guard fx > 0 else { return nil }
    let row = (cx + fx * tan(Angles.toRadians(pitchDeg))) / sensorWidth
    return min(max(row, -0.5), 1.5)
  }
}

// MARK: - Drift

/// `setCourseReference({bearingDeg})` records the current position as the
/// anchor and the bearing as the line (09 §5.6).
public struct DriftEstimator {
  public static let emitIntervalSeconds = 0.2   // 5 Hz

  private var anchor: SIMD3<Double>?
  private var bearingDeg: Double?
  private var smoother = ExponentialSmoother(timeConstantSeconds: 1.0)
  private var limiter = RateLimiter(intervalSeconds: DriftEstimator.emitIntervalSeconds)

  public init() {}

  public var isAnchored: Bool { anchor != nil && bearingDeg != nil }
  public var referenceBearingDeg: Double? { bearingDeg }

  public mutating func anchor(at position: SIMD3<Double>, bearingDeg: Double) {
    anchor = position
    self.bearingDeg = Angles.wrapUnsigned(bearingDeg)
    smoother.reset()
    limiter.reset()
  }

  public mutating func clear() {
    anchor = nil
    bearingDeg = nil
    smoother.reset()
    limiter.reset()
  }

  /// Returns a payload at most 5 Hz. `frozen` (tracking LIMITED / lost) emits
  /// `source: 'none'` so the SensorService falls back to heading + dead
  /// reckoning instead of trusting a drifting pose.
  public mutating func update(position: SIMD3<Double>, frozen: Bool, at t: Double) -> LateralOffsetPayload? {
    guard let anchor, let bearingDeg else { return nil }
    guard limiter.allow(at: t) else { return nil }
    if frozen {
      return LateralOffsetPayload(offsetM: 0, source: .none)
    }
    let raw = WorldGeometry.lateralOffset(position: position, anchor: anchor, bearingDeg: bearingDeg)
    let smoothed = smoother.update(raw, at: t)
    return LateralOffsetPayload(offsetM: smoothed, source: .pose)
  }
}
