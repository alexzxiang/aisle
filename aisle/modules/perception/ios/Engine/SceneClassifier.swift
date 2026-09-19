//
//  SceneClassifier.swift
//  Perception
//
//  Round 6: "where am I", on-device and immediate. Apple's `VNClassifyImageRequest`
//  ships with every iPhone (no model file) and answers with ~1,300 labels —
//  `kitchen`, `living_room`, `refrigerator`, `couch`, `door`, `staircase`,
//  `sidewalk`, `crosswalk`, `traffic_light`, `supermarket` … — in about 50 ms on
//  the Neural Engine. The engine runs it at the profile's `sceneFps` (2 fps
//  indoors / outdoors, 1 while approaching a crossing, 0 mid-crossing) and emits
//  the top labels as `onSceneClass`. JS (`src/core/situate.ts`) turns them into
//  the place hypothesis ("You seem to be in a kitchen. Is that right?") without
//  waiting for the network; Claude's `situate` call then only refines the words.
//
//  Never spoken directly: labels are hints with confidences, not facts. JS
//  applies hysteresis (two agreeing readings) before it says anything.
//
import CoreVideo
import Foundation
import ImageIO
import Vision

public struct SceneLabel: Codable, Equatable, Sendable {
  public var id: String
  public var confidence: Double
  public init(id: String, confidence: Double) {
    self.id = id
    self.confidence = confidence
  }
  public var dictionary: [String: Any] { ["id": id, "confidence": confidence] }
}

public struct SceneClassPayload: PerceptionPayload, Equatable {
  public var labels: [SceneLabel]
  public var timestamp: Double

  public init(labels: [SceneLabel], timestamp: Double) {
    self.labels = labels
    self.timestamp = timestamp
  }

  public var dictionary: [String: Any] {
    ["labels": labels.map { $0.dictionary }, "timestamp": timestamp]
  }
}

public final class SceneClassifier {
  /// Labels below this are noise for a place decision.
  public var minConfidence: Double = 0.05
  /// How many labels travel to JS: enough for the room and its furniture.
  public var topK: Int = 8

  public init() {}

  /// Synchronous; the engine calls it off the frame queue like OCR.
  public func classify(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                       timestampMs: Double) -> SceneClassPayload? {
    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let observations = request.results else { return nil }
    let labels = observations
      .filter { Double($0.confidence) >= minConfidence }
      .prefix(topK)
      .map { SceneLabel(id: $0.identifier, confidence: Double($0.confidence)) }
    guard !labels.isEmpty else { return nil }
    return SceneClassPayload(labels: Array(labels), timestamp: timestampMs)
  }
}
