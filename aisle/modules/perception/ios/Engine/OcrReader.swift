//
//  OcrReader.swift
//  Aisle — PerceptionModule engine
//
//  Apple Vision text recognition on the upper band of the upright frame
//  (09 §5.5): `VNRecognizeTextRequest`, `.fast`, language correction OFF
//  ("c001" must not become "cool"), `regionOfInterest` = upper 40 %,
//  `minimumTextHeight ≈ 0.02`, `customWords` = the store map's sign vocabulary
//  from `setKnownSigns`.
//
//  What "normalization" means here, and only here: the BOX. Vision returns
//  bounding boxes in a bottom-left-origin normalized space of the *region of
//  interest*; `NormalizedBox.fromVision` maps them to top-left-origin
//  coordinates of the full upright frame so the JS side sees one box
//  convention everywhere. The TEXT is
//  emitted exactly as Vision returned it — uppercasing, punctuation, whitespace
//  and the digit-confusion map live once in JS (`src/indoor/ocrMatcher.ts`) so a
//  replayed fixture and a live frame normalize identically.
//
//  Blur gate: skip the OCR frame when the gyro yaw rate over the exposure
//  window exceeds the phase-0 threshold, or when tracking is LIMITED with
//  reason `excessiveMotion`.
//

import CoreImage
import CoreVideo
import Foundation
import Vision

public struct OcrConfig: Equatable, Sendable {
  /// Upper band of the upright frame, as a fraction of frame height from the top.
  public var upperBandFraction: Double = 0.40
  public var minimumTextHeight: Float = 0.02
  /// Yaw rate above which the frame is too blurred to read (deg/s). Phase-0
  /// number; GLIMPSE-style motion energy would be the upgrade.
  public var blurYawRateDegPerSec: Double = 45
  /// Emit ≤ 3 Hz (01 §7).
  public var emitIntervalSeconds: Double = 1.0 / 3.0
  /// Vision confidence floor per candidate; reads below it are dropped before
  /// they cross the bridge.
  public var minConfidence: Float = 0.3

  public init() {}
}

public enum OcrSkipReason: String, Equatable, Sendable {
  case blur
  case trackingLimited
  case rateLimited
  case busy
}

/// Owns the Vision request and the emit budget. Runs on the caller's queue;
/// the engine dispatches it off the frame thread.
public final class OcrReader {
  public var config: OcrConfig
  private let request: VNRecognizeTextRequest
  private var limiter: RateLimiter
  private var busy = false
  private var lateralSmoother = ExponentialSmoother(timeConstantSeconds: 1.0)
  private(set) public var knownSigns: [String] = []

  public init(config: OcrConfig = OcrConfig()) {
    self.config = config
    self.limiter = RateLimiter(intervalSeconds: config.emitIntervalSeconds)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    request.minimumTextHeight = config.minimumTextHeight
    // Vision's ROI is bottom-left origin in the *oriented* image; the upper
    // band of an upright frame is y ∈ [1 − band, 1].
    request.regionOfInterest = CGRect(
      x: 0, y: 1 - config.upperBandFraction, width: 1, height: config.upperBandFraction)
    self.request = request
  }

  /// `setKnownSigns` (01 §7): the OCR `customWords` list has no other source.
  public func setKnownSigns(_ words: [String]) {
    let cleaned = words.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    knownSigns = Array(Set(cleaned)).sorted()
    request.customWords = knownSigns
  }

  /// The gate before any pixels are touched. Returns nil when the frame may run.
  public func shouldSkip(yawRateDegPerSec: Double, trackingLimitedByMotion: Bool, at t: Double) -> OcrSkipReason? {
    if busy { return .busy }
    if abs(yawRateDegPerSec) > config.blurYawRateDegPerSec { return .blur }
    if trackingLimitedByMotion { return .trackingLimited }
    if !limiter.wouldAllow(at: t) { return .rateLimited }
    return nil
  }

  public struct Result: Equatable {
    public var reads: [OcrReadPayload]
    /// Sign-box horizontal offset from centre, smoothed 1 s
    /// (`onLateralOffset {source: 'ocr_box'}`), from the largest read.
    public var lateralOffset: LateralOffsetPayload?

    public init(reads: [OcrReadPayload], lateralOffset: LateralOffsetPayload?) {
      self.reads = reads
      self.lateralOffset = lateralOffset
    }
  }

  /// Run recognition on a sensor-orientation pixel buffer. `orientation` is the
  /// EXIF orientation that makes it upright (`.right` for a portrait-held phone,
  /// 09 §2). `timestampMs` is the `Date.now()`-comparable stamp for the payloads.
  public func recognize(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                        timestampMs: Double, now t: Double) -> Result {
    guard limiter.allow(at: t) else { return Result(reads: [], lateralOffset: nil) }
    busy = true
    defer { busy = false }

    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return Result(reads: [], lateralOffset: nil)
    }
    let observations = request.results ?? []
    let reads = OcrReader.payloads(from: observations, config: config, timestampMs: timestampMs)
    let offset = lateralOffset(from: reads, at: t)
    return Result(reads: reads, lateralOffset: offset)
  }

  /// Pure conversion, testable with synthetic observations' geometry.
  public static func payloads(from observations: [VNRecognizedTextObservation],
                              config: OcrConfig, timestampMs: Double) -> [OcrReadPayload] {
    observations.compactMap { obs in
      guard let candidate = obs.topCandidates(1).first, candidate.confidence >= config.minConfidence else {
        return nil
      }
      let box = OcrReader.normalizeBox(obs.boundingBox, upperBandFraction: config.upperBandFraction)
      return OcrReadPayload(
        text: candidate.string, box: box, confidence: Double(candidate.confidence), timestamp: timestampMs)
    }
  }

  /// Vision box (bottom-left origin, relative to the ROI) → upright frame box
  /// (top-left origin, full frame), through the one shared mapping.
  public static func normalizeBox(_ visionBox: CGRect, upperBandFraction: Double) -> NormalizedBox {
    NormalizedBox.fromVision(
      minX: Double(visionBox.minX), minY: Double(visionBox.minY),
      width: Double(visionBox.width), height: Double(visionBox.height),
      roi: (x: 0, y: 1 - upperBandFraction, w: 1, h: upperBandFraction))
  }

  /// Largest read's centre offset from the frame centre column, in a pseudo-
  /// metre scale (frame width ≈ aisle width at reading distance is the phase-0
  /// assumption; the smoothed value feeds `crossTrackM` in JS with the
  /// precedence `pose` > `shelf` > `ocr_box`, 04 Task 6).
  private func lateralOffset(from reads: [OcrReadPayload], at t: Double) -> LateralOffsetPayload? {
    guard let largest = reads.max(by: { $0.box.area < $1.box.area }) else { return nil }
    // The user is right of the sign when the sign sits left of centre.
    let raw = (0.5 - largest.box.centerX) * 2.0
    let smoothed = lateralSmoother.update(raw, at: t)
    return LateralOffsetPayload(offsetM: smoothed, source: .ocrBox)
  }

  public func reset() {
    limiter.reset()
    lateralSmoother.reset()
    busy = false
  }
}
