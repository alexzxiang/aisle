//
//  ObstacleEstimator.swift
//  Aisle — PerceptionModule engine
//
//  Relative depth (Depth Anything V2 small) → obstacles, aisle centring and the
//  end-of-aisle wall (09 §5.3). The model gives a unitless inverse-depth map:
//  1 = nearest, 0 = farthest, per frame. Nothing here claims metres; NEAR / MID
//  / FAR are per-phone thresholds calibrated in phase 0 by walking at a wall
//  from 4 m, and `DistanceClassifier.thresholds` is where that number lands.
//
//  Per depth frame:
//    - centre-bottom cell = centre third × bottom third of the upright frame;
//      its median relative depth and its closing rate over 0.5 s;
//    - `onDepth {centerBottomRel, closingRate}` ≤ 5 Hz;
//    - `onObstacleAhead {distanceClass, direction}` when the cell is NEAR, or
//      MID and closing faster than walking pace; ≤ 1 per 2 s; direction from
//      whichever bottom third is nearest;
//    - indoors, left-vs-right thirds asymmetry → `onLateralOffset {source: shelf}`.
//
//  The map is reduced to nine cell medians once (`DepthGrid`) and every
//  consumer reads the grid, so the pixel loop runs one time per frame.
//

import Accelerate
import CoreVideo
import Foundation

// MARK: - Grid

/// Median relative depth per cell of a 3×3 grid over the upright frame, row 0
/// at the top. `[row][column]`.
public struct DepthGrid: Equatable, Sendable {
  public var cells: [[Double]]
  public var timestamp: Double

  public init(cells: [[Double]], timestamp: Double) {
    precondition(cells.count == 3 && cells.allSatisfy { $0.count == 3 }, "DepthGrid is 3×3")
    self.cells = cells
    self.timestamp = timestamp
  }

  public var centerBottom: Double { cells[2][1] }
  public var leftBottom: Double { cells[2][0] }
  public var rightBottom: Double { cells[2][2] }
  public var leftMiddle: Double { cells[1][0] }
  public var rightMiddle: Double { cells[1][2] }

  /// Relative nearness (0 far … 1 near) of the cell under a normalized upright point (round 6b).
  /// Values are the model's relative inverse depth, clamped; the grid is 3×3 so this is coarse on purpose.
  public func nearness(atNormalizedX x: Double, y: Double) -> Double {
    let col = min(2, max(0, Int(x * 3)))
    let row = min(2, max(0, Int(y * 3)))
    return min(1, max(0, cells[row][col]))
  }

  /// Which bottom third is nearest (largest relative depth).
  public var nearestBottomDirection: Direction {
    if leftBottom > centerBottom && leftBottom > rightBottom { return .left }
    if rightBottom > centerBottom && rightBottom > leftBottom { return .right }
    return .center
  }

  /// Build from a depth buffer already rotated into the upright frame.
  /// `sample(x, y)` returns the relative depth at normalized coordinates.
  /// `samplesPerCell` points per cell keeps this O(1) per frame regardless of
  /// model resolution (518² is 268k pixels; we read 9 × 64).
  public static func reduce(width: Int, height: Int, samplesPerCell: Int = 64,
                            timestamp: Double,
                            sample: (Int, Int) -> Float) -> DepthGrid {
    let side = max(1, Int(Double(samplesPerCell).squareRoot()))
    var cells = Array(repeating: Array(repeating: 0.0, count: 3), count: 3)
    for row in 0..<3 {
      for col in 0..<3 {
        var values: [Float] = []
        values.reserveCapacity(side * side)
        for sy in 0..<side {
          for sx in 0..<side {
            let nx = (Double(col) + (Double(sx) + 0.5) / Double(side)) / 3.0
            let ny = (Double(row) + (Double(sy) + 0.5) / Double(side)) / 3.0
            let px = min(width - 1, max(0, Int(nx * Double(width))))
            let py = min(height - 1, max(0, Int(ny * Double(height))))
            values.append(sample(px, py))
          }
        }
        cells[row][col] = Double(DepthGrid.median(values))
      }
    }
    return DepthGrid(cells: cells, timestamp: timestamp)
  }

  static func median(_ values: [Float]) -> Float {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    if sorted.count % 2 == 0 {
      return (sorted[mid - 1] + sorted[mid]) / 2
    }
    return sorted[mid]
  }

  /// Read a `kCVPixelFormatType_OneComponent32Float` (or 16-bit float) depth
  /// map. Model outputs land in this format from Vision when the model's
  /// output is an image; a multi-array output is converted by the caller.
  public static func from(pixelBuffer: CVPixelBuffer, timestamp: Double,
                          normalize: Bool = true) -> DepthGrid? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
    let width = CVPixelBufferGetWidth(pixelBuffer)
    let height = CVPixelBufferGetHeight(pixelBuffer)
    let stride = CVPixelBufferGetBytesPerRow(pixelBuffer)
    let format = CVPixelBufferGetPixelFormatType(pixelBuffer)

    let reader: (Int, Int) -> Float
    switch format {
    case kCVPixelFormatType_OneComponent32Float, kCVPixelFormatType_DepthFloat32, kCVPixelFormatType_DisparityFloat32:
      reader = { x, y in
        base.advanced(by: y * stride + x * 4).assumingMemoryBound(to: Float32.self).pointee
      }
    case kCVPixelFormatType_OneComponent16Half, kCVPixelFormatType_DepthFloat16, kCVPixelFormatType_DisparityFloat16:
      reader = { x, y in
        let half = base.advanced(by: y * stride + x * 2).assumingMemoryBound(to: UInt16.self).pointee
        return Float(Float16(bitPattern: half))
      }
    case kCVPixelFormatType_OneComponent8:
      reader = { x, y in
        Float(base.advanced(by: y * stride + x).assumingMemoryBound(to: UInt8.self).pointee) / 255
      }
    default:
      return nil
    }

    var grid = reduce(width: width, height: height, timestamp: timestamp, sample: reader)
    if normalize { grid.normalizeInPlace() }
    return grid
  }

  /// Depth Anything outputs relative inverse depth on an arbitrary per-frame
  /// scale. Rescale the nine cells to 0..1 so thresholds are comparable across
  /// frames (1 = nearest cell in this frame).
  public mutating func normalizeInPlace() {
    let flat = cells.flatMap { $0 }
    guard let lo = flat.min(), let hi = flat.max(), hi > lo else { return }
    cells = cells.map { row in row.map { ($0 - lo) / (hi - lo) } }
  }
}

// MARK: - Classification

public struct DistanceThresholds: Equatable, Sendable {
  /// Relative depth at or above which the cell is NEAR (< ~1 m).
  public var near: Double
  /// Relative depth at or above which the cell is MID (1–2.5 m).
  public var mid: Double

  /// Placeholder until the wall-walk calibration in phase 0 overwrites it.
  public static let uncalibrated = DistanceThresholds(near: 0.80, mid: 0.55)

  public init(near: Double, mid: Double) {
    self.near = near
    self.mid = mid
  }

  public func classify(_ rel: Double) -> DistanceClass {
    if rel >= near { return .near }
    if rel >= mid { return .mid }
    return .far
  }
}

public struct ObstacleConfig: Equatable, Sendable {
  public var thresholds: DistanceThresholds = .uncalibrated
  public var closingWindowSeconds: Double = 0.5
  /// Closing rate (relative units per second) above which MID counts as
  /// "approaching faster than walking pace". Calibrated with the thresholds.
  public var walkingPaceClosingRate: Double = 0.15
  public var obstacleCooldownSeconds: Double = 2.0
  public var depthEmitIntervalSeconds: Double = 0.2   // ≤ 5 Hz
  /// Left/right bottom-third asymmetry → lateral offset (metres-ish, unitless
  /// scale chosen so a shelf at arm's length reads ~0.5). Calibrated in phase 0.
  public var shelfAsymmetryToMetres: Double = 1.0

  public init() {}
}

public struct ObstacleOutcome: Equatable {
  public var depth: DepthSummaryPayload?
  public var obstacle: ObstacleAheadPayload?
  public var shelfOffset: LateralOffsetPayload?
  public var distanceClass: DistanceClass

  public init(depth: DepthSummaryPayload?, obstacle: ObstacleAheadPayload?,
              shelfOffset: LateralOffsetPayload?, distanceClass: DistanceClass) {
    self.depth = depth
    self.obstacle = obstacle
    self.shelfOffset = shelfOffset
    self.distanceClass = distanceClass
  }
}

/// Consumes one `DepthGrid` per depth frame.
public struct ObstacleEstimator {
  public var config: ObstacleConfig
  private var history: TimedSamples<Double>
  private var depthLimiter: RateLimiter
  private var obstacleLimiter: RateLimiter
  private var shelfSmoother = ExponentialSmoother(timeConstantSeconds: 1.0)
  private var closingSmoother = ExponentialSmoother(timeConstantSeconds: 0.3)

  public init(config: ObstacleConfig = ObstacleConfig()) {
    self.config = config
    self.history = TimedSamples(windowSeconds: config.closingWindowSeconds * 2)
    self.depthLimiter = RateLimiter(intervalSeconds: config.depthEmitIntervalSeconds)
    self.obstacleLimiter = RateLimiter(intervalSeconds: config.obstacleCooldownSeconds)
  }

  /// `indoor` enables the shelf-asymmetry offset (09 §5.3 last paragraph).
  public mutating func process(_ grid: DepthGrid, indoor: Bool) -> ObstacleOutcome {
    let t = grid.timestamp
    let rel = grid.centerBottom
    history.push(rel, at: t)

    // Closing rate over the window: d(rel)/dt, positive = approaching.
    var closing = 0.0
    if let past = history.sample(secondsAgo: config.closingWindowSeconds, now: t), t > past.t {
      closing = (rel - past.value) / (t - past.t)
    }
    closing = closingSmoother.update(closing, at: t)

    let cls = config.thresholds.classify(rel)

    var depthPayload: DepthSummaryPayload?
    if depthLimiter.allow(at: t) {
      depthPayload = DepthSummaryPayload(centerBottomRel: rel, closingRate: closing, timestamp: t * 1000)
    }

    var obstacle: ObstacleAheadPayload?
    let shouldWarn = cls == .near || (cls == .mid && closing > config.walkingPaceClosingRate)
    if shouldWarn && obstacleLimiter.allow(at: t) {
      obstacle = ObstacleAheadPayload(distanceClass: cls, direction: grid.nearestBottomDirection)
    }

    var shelf: LateralOffsetPayload?
    if indoor {
      // Nearer on the right (larger rel) means the user has drifted right.
      let asymmetry = (grid.rightMiddle + grid.rightBottom) / 2 - (grid.leftMiddle + grid.leftBottom) / 2
      let smoothed = shelfSmoother.update(asymmetry * config.shelfAsymmetryToMetres, at: t)
      shelf = LateralOffsetPayload(offsetM: smoothed, source: .shelf)
    }

    return ObstacleOutcome(depth: depthPayload, obstacle: obstacle, shelfOffset: shelf, distanceClass: cls)
  }

  /// Wall-walk calibration hook (09 §5.3): record the relative depth seen at a
  /// known distance and derive thresholds. `nearRel` at ~1 m, `midRel` at ~2.5 m.
  public mutating func calibrate(nearRel: Double, midRel: Double) {
    guard nearRel > midRel, nearRel <= 1, midRel >= 0 else { return }
    config.thresholds = DistanceThresholds(near: nearRel, mid: midRel)
  }

  public mutating func reset() {
    history.reset()
    depthLimiter.reset()
    obstacleLimiter.reset()
    shelfSmoother.reset()
    closingSmoother.reset()
  }
}
