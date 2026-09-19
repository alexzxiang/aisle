//
//  HandTracker.swift
//  Perception
//
//  Round 7 (TEAM-PLAN v2, Stream A): the user's own hand, on-device, at the
//  frame rate. `VNDetectHumanHandPoseRequest` returns 21 landmarks per hand;
//  the engine emits the index fingertip, the wrist and a box around the hand as
//  `onHandPose` in the upright, top-left-origin normalized frame the rest of the
//  pipeline uses. The JS hand guide steers with these against the target's box
//  — "Left." / "Higher." / "Reach forward." / "Grab it." — instead of asking a
//  language model where the hand is every two seconds.
//
//  Own arm vs. a person: COCO calls the user's outstretched arm "person", which
//  fed the indoor hazard ("Person ahead") and scene memory. `ownArmBox` says
//  which person box is the user's own arm (it contains the tracked hand and
//  reaches the bottom edge of the frame); the engine relabels it `hand`.
//
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Vision

public struct HandPosePayload: PerceptionPayload, Equatable {
  /// Normalized upright coordinates, origin top-left.
  public var tipX: Double
  public var tipY: Double
  public var wristX: Double
  public var wristY: Double
  public var box: NormalizedBox
  public var confidence: Double
  public var timestamp: Double

  public init(tipX: Double, tipY: Double, wristX: Double, wristY: Double, box: NormalizedBox, confidence: Double, timestamp: Double) {
    self.tipX = tipX
    self.tipY = tipY
    self.wristX = wristX
    self.wristY = wristY
    self.box = box
    self.confidence = confidence
    self.timestamp = timestamp
  }

  public var dictionary: [String: Any] {
    ["tipX": tipX, "tipY": tipY, "wristX": wristX, "wristY": wristY, "box": box.array, "confidence": confidence, "timestamp": timestamp]
  }
}

public final class HandTracker {
  /// Landmarks below this are not trusted for a direction.
  public var minConfidence: Float = 0.3

  public init() {}

  /// Synchronous; the engine calls it off the frame queue. Returns the most confident hand, if any.
  public func detect(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, timestampMs: Double) -> HandPosePayload? {
    let request = VNDetectHumanHandPoseRequest()
    request.maximumHandCount = 2
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let hands = request.results, !hands.isEmpty else { return nil }
    var best: HandPosePayload?
    for hand in hands {
      guard let points = try? hand.recognizedPoints(.all) else { continue }
      guard let tip = points[.indexTip], let wrist = points[.wrist],
            tip.confidence >= minConfidence, wrist.confidence >= minConfidence else { continue }
      // Vision: normalized, origin bottom-left → upright top-left.
      var minX = 1.0, minY = 1.0, maxX = 0.0, maxY = 0.0
      var sum: Float = 0
      var n: Float = 0
      for (_, p) in points where p.confidence >= minConfidence {
        let x = Double(p.location.x)
        let y = 1 - Double(p.location.y)
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        sum += p.confidence
        n += 1
      }
      guard n > 0 else { continue }
      let payload = HandPosePayload(
        tipX: Double(tip.location.x), tipY: 1 - Double(tip.location.y),
        wristX: Double(wrist.location.x), wristY: 1 - Double(wrist.location.y),
        box: NormalizedBox(x: minX, y: minY, w: max(0.01, maxX - minX), h: max(0.01, maxY - minY)),
        confidence: Double(sum / n), timestamp: timestampMs)
      if best == nil || payload.confidence > best!.confidence { best = payload }
    }
    return best
  }

  /// The person box that is really the user's own arm: it contains the hand and reaches the
  /// bottom edge of the frame (an arm entering the picture from the body). Nil when none does.
  public static func ownArmIndex(in detections: [DetectionPayload], hand: HandPosePayload?) -> Int? {
    guard let hand else { return nil }
    for (i, d) in detections.enumerated() where d.cls == .person {
      let containsTip = d.box.x <= hand.tipX && hand.tipX <= d.box.x + d.box.w && d.box.y <= hand.tipY && hand.tipY <= d.box.y + d.box.h
      let containsWrist = d.box.x <= hand.wristX && hand.wristX <= d.box.x + d.box.w && d.box.y <= hand.wristY && hand.wristY <= d.box.y + d.box.h
      let reachesBottom = d.box.bottom >= 0.85
      if (containsTip || containsWrist) && reachesBottom { return i }
    }
    return nil
  }
}
