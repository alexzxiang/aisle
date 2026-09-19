//
//  ModelRegistry.swift
//  Aisle — PerceptionModule engine
//
//  Owns the four CoreML models and the per-profile schedule (09 §3). Three
//  responsibilities and nothing else:
//
//    1. Load `.mlmodelc` / `.mlpackage` from the app bundle **by name**, lazily,
//       compute units `.all`, and record which unit the model actually landed on
//       (a model that falls to the CPU is a phase-0 bug, 04 Task 2).
//    2. Answer "should stage X run on frame N?" from the profile's fps target
//       against the 30 Hz ARKit frame clock — this schedule *is* the thermal
//       schedule (09 §3).
//    3. Halve every rate at `.serious` thermal state and keep only the profile's
//       safety model at `.critical` (09 §9).
//
//  Labels and per-class thresholds are read from the manifest that ships beside
//  each model (`models/ped-signal-v1.json`, 10 §6) and never hard-coded: a
//  swapped label index is the silent failure that turns HAND into WALK.
//

import CoreML
import Foundation
import Vision

// MARK: - Stages

/// The frame consumers that the profile schedule throttles independently.
public enum PipelineStage: String, CaseIterable, Sendable {
  case detector      // COCO YOLO-nano
  case signal        // ped-signal-v1
  case depth         // Depth Anything V2 small
  case ocr           // Apple Vision text recognition (system, not a file)
  case segmentation  // optional walkable-surface model
  case scene         // Apple Vision scene classification (system, not a file) — round 6, "where am I" on-device
  case hand          // Apple Vision hand pose (system, not a file) — round 7, steers the user's hand on-device
}

// MARK: - Schedule

/// Target frames per second per stage, per profile (01 §7 / 09 §3 table).
public struct ProfileSchedule: Equatable, Sendable {
  public var detectorFps: Double
  public var signalFps: Double
  public var depthFps: Double
  public var ocrFps: Double
  public var segmentationFps: Double
  /// Scene classification: ~50 ms on the Neural Engine; 2 fps is plenty for a place that changes when you walk.
  public var sceneFps: Double
  /// Hand pose: only where a hand is being steered (indoor, pickup); 0 elsewhere.
  public var handFps: Double
  /// IDLE pauses the ARSession entirely (09 §9).
  public var sessionRunning: Bool

  public init(detectorFps: Double, signalFps: Double, depthFps: Double,
              ocrFps: Double, segmentationFps: Double, sceneFps: Double = 0, handFps: Double = 0, sessionRunning: Bool = true) {
    self.detectorFps = detectorFps
    self.signalFps = signalFps
    self.depthFps = depthFps
    self.ocrFps = ocrFps
    self.segmentationFps = segmentationFps
    self.sceneFps = sceneFps
    self.handFps = handFps
    self.sessionRunning = sessionRunning
  }

  public func fps(for stage: PipelineStage) -> Double {
    switch stage {
    case .detector: return detectorFps
    case .signal: return signalFps
    case .depth: return depthFps
    case .ocr: return ocrFps
    case .segmentation: return segmentationFps
    case .scene: return sceneFps
    case .hand: return handFps
    }
  }

  /// `.serious` halves every rate; the profile's safety model survives
  /// `.critical` alone (09 §9).
  public func downshifted(for thermal: ProcessInfo.ThermalState,
                          safetyStage: PipelineStage) -> ProfileSchedule {
    switch thermal {
    case .nominal, .fair:
      return self
    case .serious:
      return ProfileSchedule(
        detectorFps: detectorFps / 2, signalFps: signalFps / 2, depthFps: depthFps / 2,
        ocrFps: ocrFps / 2, segmentationFps: segmentationFps / 2, sceneFps: min(sceneFps, 1), handFps: handFps / 2,
        sessionRunning: sessionRunning)
    case .critical:
      var only = ProfileSchedule(
        detectorFps: 0, signalFps: 0, depthFps: 0, ocrFps: 0, segmentationFps: 0, sceneFps: 0, handFps: 0,
        sessionRunning: sessionRunning)
      let kept = max(5, fps(for: safetyStage) / 2)
      switch safetyStage {
      case .detector: only.detectorFps = kept
      case .signal: only.signalFps = kept
      case .depth: only.depthFps = kept
      case .ocr: only.ocrFps = kept
      case .segmentation: only.segmentationFps = kept
      case .scene: only.sceneFps = kept
      case .hand: only.handFps = kept
      }
      return only
    @unknown default:
      return self
    }
  }
}

/// The 09 §3 table, verbatim. `AT_CURB` shares APPROACH_CROSSING and
/// `TRANSITION` shares OUTDOOR_NAV; JS does that mapping (01 §7) so this table
/// has exactly the six `ModeProfile` rows.
public enum ProfileSchedules {
  /// Segmentation is optional and off until the CoreML export is verified
  /// ([verify] in 09 §3 / R27 in 08). `ModelRegistry.segmentationEnabled`
  /// turns it on without touching this table.
  public static func schedule(for profile: ModeProfile, segmentationEnabled: Bool) -> ProfileSchedule {
    let seg = segmentationEnabled
    switch profile {
    case .idle:
      return ProfileSchedule(detectorFps: 0, signalFps: 0, depthFps: 0, ocrFps: 0,
                             segmentationFps: 0, sessionRunning: false)
    case .outdoorNav:
      return ProfileSchedule(detectorFps: 15, signalFps: 0, depthFps: 10, ocrFps: 0,
                             segmentationFps: seg ? 10 : 0, sceneFps: 2)
    case .approachCrossing:
      return ProfileSchedule(detectorFps: 15, signalFps: 15, depthFps: 10, ocrFps: 0,
                             segmentationFps: 0, sceneFps: 1)
    case .crossing:
      return ProfileSchedule(detectorFps: 15, signalFps: 15, depthFps: 10, ocrFps: 0,
                             segmentationFps: seg ? 5 : 0, sceneFps: 0)
    case .indoorNav:
      return ProfileSchedule(detectorFps: 15, signalFps: 0, depthFps: 10, ocrFps: 3,
                             segmentationFps: 0, sceneFps: 2, handFps: 8)
    case .itemPickup:
      return ProfileSchedule(detectorFps: 5, signalFps: 0, depthFps: 5, ocrFps: 0,
                             segmentationFps: 0, sceneFps: 1, handFps: 10)
    case .aware:
      return ProfileSchedule(detectorFps: 8, signalFps: 0, depthFps: 4, ocrFps: 1,
                             segmentationFps: 0, sceneFps: 2, handFps: 4)
    }
  }

  /// The one model that survives `.critical` thermal state per profile: the
  /// signal head where a crossing is in play, vehicles everywhere else outdoors,
  /// depth indoors (the obstacle reflex).
  public static func safetyStage(for profile: ModeProfile) -> PipelineStage {
    switch profile {
    case .approachCrossing, .crossing: return .signal
    case .outdoorNav: return .detector
    case .indoorNav, .itemPickup: return .depth
    case .idle, .aware: return .detector
    }
  }

  /// Models a profile needs loaded; everything else is unloaded (04 Task 2:
  /// `INDOOR_NAV` never holds the signal model).
  public static func requiredModels(for profile: ModeProfile, segmentationEnabled: Bool) -> Set<PipelineStage> {
    let s = schedule(for: profile, segmentationEnabled: segmentationEnabled)
    return Set(PipelineStage.allCases.filter { s.fps(for: $0) > 0 })
  }
}

// MARK: - Frame throttle

/// Turns an fps target into a decision on the 30 Hz ARKit frame clock by frame
/// counter, not by wall time: 09 §2 says schedule by frame counter and never
/// queue a frame. `busy` is the drop rule — if a model is still running, the
/// frame is skipped, never buffered.
public struct FrameThrottle {
  public let sourceFps: Double
  private var lastRunFrame: Int?
  private var busy = false

  public init(sourceFps: Double = 30) {
    self.sourceFps = sourceFps
  }

  public var isBusy: Bool { busy }

  /// Every how-many-th frame the stage runs. `0 fps` → never.
  public static func stride(targetFps: Double, sourceFps: Double) -> Int? {
    guard targetFps > 0, sourceFps > 0 else { return nil }
    if targetFps >= sourceFps { return 1 }
    return max(1, Int((sourceFps / targetFps).rounded()))
  }

  public mutating func shouldRun(frame: Int, targetFps: Double) -> Bool {
    if busy { return false }
    guard let stride = FrameThrottle.stride(targetFps: targetFps, sourceFps: sourceFps) else {
      return false
    }
    if let last = lastRunFrame, frame - last < stride { return false }
    lastRunFrame = frame
    return true
  }

  public mutating func markBusy() { busy = true }
  public mutating func markIdle() { busy = false }

  public mutating func reset() {
    lastRunFrame = nil
    busy = false
  }
}

// MARK: - Manifest

/// `models/<name>.json` (10 §6). Only the fields the module reads; unknown
/// fields are ignored so D can add metrics without a native change.
public struct ModelManifest: Codable, Equatable {
  public struct Input: Codable, Equatable {
    public var width: Int
    public var height: Int
    public var letterbox: Bool?
    public var colour: String?
    public var scale: String?
  }

  public var name: String
  public var arch: String?
  public var input: Input?
  /// Label order is the contract: index 0 is the first entry (10 §6).
  public var labels: [String]
  /// Per-class confidence floors; the module may raise these from device
  /// measurements, never lower them (10 §6).
  public var confThreshold: [String: Double]?

  public init(name: String, arch: String? = nil, input: Input? = nil,
              labels: [String], confThreshold: [String: Double]? = nil) {
    self.name = name
    self.arch = arch
    self.input = input
    self.labels = labels
    self.confThreshold = confThreshold
  }

  public func threshold(for label: String, default fallback: Double) -> Double {
    confThreshold?[label] ?? fallback
  }
}

// MARK: - Loaded model

public struct LoadedModel {
  public let name: String
  public let model: MLModel
  public let vnModel: VNCoreMLModel
  public let manifest: ModelManifest?
  /// What `MLModel` reported after load; a `cpuOnly` here is a phase-0 bug.
  public let computeUnits: MLComputeUnits
  public let loadedAt: Date

  public init(name: String, model: MLModel, vnModel: VNCoreMLModel,
              manifest: ModelManifest?, computeUnits: MLComputeUnits, loadedAt: Date = Date()) {
    self.name = name
    self.model = model
    self.vnModel = vnModel
    self.manifest = manifest
    self.computeUnits = computeUnits
    self.loadedAt = loadedAt
  }
}

public enum ModelRegistryError: Error, CustomStringConvertible {
  case notFound(name: String)
  case compileFailed(name: String, underlying: Error)
  case loadFailed(name: String, underlying: Error)

  public var description: String {
    switch self {
    case .notFound(let name):
      return "model '\(name)' is not in the app bundle (expected \(name).mlmodelc or \(name).mlpackage)"
    case .compileFailed(let name, let underlying):
      return "model '\(name)' failed to compile: \(underlying)"
    case .loadFailed(let name, let underlying):
      return "model '\(name)' failed to load: \(underlying)"
    }
  }
}

// MARK: - Registry

/// File names are fixed by 04 Task 2 / 09 §3. The registry looks each one up in
/// the bundle and caches the loaded model until a profile change evicts it.
public final class ModelRegistry {
  public static let cocoModelName = "coco-yolo-nano"
  public static let cocoFallbackModelName = "coco-yolo-nano-416"
  /// Round 9: the Open Images V7 nano detector, optional (a bundle without it runs COCO alone).
  public static let openImagesModelName = "oiv7-yolo-nano"
  public static let signalModelName = "ped-signal-v1"
  public static let depthModelName = "depth-anything-v2-small"
  public static let segmentationModelName = "walkable-seg"

  /// Off until the CoreML export is verified on the demo phone (09 §3 [verify]).
  public var segmentationEnabled = false

  private let bundle: Bundle
  private var loaded: [PipelineStage: LoadedModel] = [:]
  private var failed: Set<PipelineStage> = []
  private var extraDetector: LoadedModel?
  private var extraDetectorFailed = false
  private var lastLoadLog: [String] = []

  public init(bundle: Bundle = Bundle.main) {
    self.bundle = bundle
  }

  public func modelName(for stage: PipelineStage) -> String? {
    switch stage {
    case .detector: return ModelRegistry.cocoModelName
    case .signal: return ModelRegistry.signalModelName
    case .depth: return ModelRegistry.depthModelName
    case .segmentation: return ModelRegistry.segmentationModelName
    case .ocr: return nil // Apple Vision is a system request, not a file
    case .scene: return nil // Apple Vision scene classification: system, not a file
    case .hand: return nil  // Apple Vision hand pose: system, not a file
    }
  }

  public func model(for stage: PipelineStage) -> LoadedModel? {
    loaded[stage]
  }

  /// Did this stage's model fail to load? The caller degrades instead of
  /// retrying every frame (a missing depth model means heading + dead reckoning
  /// only — R27 in 08).
  public func hasFailed(_ stage: PipelineStage) -> Bool {
    failed.contains(stage)
  }

  /// Lazily load the stage's model. Idempotent; a previous failure is sticky
  /// until `resetFailures()` so the hot path never re-attempts a missing file.
  @discardableResult
  public func load(_ stage: PipelineStage) throws -> LoadedModel? {
    if let existing = loaded[stage] { return existing }
    if failed.contains(stage) { return nil }
    guard let name = modelName(for: stage) else { return nil }

    do {
      let loadedModel = try loadModel(named: name)
      loaded[stage] = loadedModel
      lastLoadLog.append(
        "\(name): units=\(ModelRegistry.describe(loadedModel.computeUnits)) "
          + "labels=\(loadedModel.manifest?.labels.count ?? 0)")
      return loadedModel
    } catch {
      failed.insert(stage)
      lastLoadLog.append("\(name): FAILED \(error)")
      throw error
    }
  }

  /// The second detector (Open Images), once `loadOpenImagesDetector()` succeeded.
  public func openImagesDetector() -> LoadedModel? {
    extraDetector
  }

  /// Round 9: load the Open Images detector for the indoor profiles. Optional: a missing or
  /// broken package is logged once and the engine runs COCO alone.
  @discardableResult
  public func loadOpenImagesDetector() -> LoadedModel? {
    if let extraDetector { return extraDetector }
    if extraDetectorFailed { return nil }
    do {
      let model = try loadModel(named: ModelRegistry.openImagesModelName)
      extraDetector = model
      lastLoadLog.append("\(ModelRegistry.openImagesModelName): units=\(ModelRegistry.describe(model.computeUnits)) labels=\(model.manifest?.labels.count ?? 0)")
      return model
    } catch {
      extraDetectorFailed = true
      lastLoadLog.append("\(ModelRegistry.openImagesModelName): not loaded (optional) \(error)")
      return nil
    }
  }

  /// Unload what the profile does not use (04 Task 2). The model file stays in
  /// the bundle; only the in-memory `MLModel` is dropped.
  public func retainOnly(_ stages: Set<PipelineStage>) {
    for stage in loaded.keys where !stages.contains(stage) {
      loaded.removeValue(forKey: stage)
    }
    if !stages.contains(.detector) { extraDetector = nil }
  }

  public func unloadAll() {
    loaded.removeAll()
    extraDetector = nil
  }

  public func resetFailures() {
    failed.removeAll()
  }

  /// One line per model load attempt, for the native log and the debug export
  /// (09 §6: per-model detail never widens `getStats()`).
  public func loadLog() -> [String] {
    lastLoadLog
  }

  /// Which declared models are actually in the bundle, reported before anything
  /// tries to use them.
  ///
  /// Weights are git-ignored and exported per machine, so a checkout builds and
  /// installs perfectly with no detector inside. Loading is lazy and a missing
  /// file only ever shows up as silence — `onDetections` never fires, the
  /// "Sees:" strip stays empty and every cloud question is asked with zero
  /// on-device facts — which reads as "the camera is bad at recognising things"
  /// rather than "there is no model". This states it once, at start.
  ///
  /// `signal` and `segmentation` are expected to be absent today (the
  /// pedestrian-signal model is untrained, segmentation is optional), so
  /// `missingRequired` names only the two that make the app blind.
  public func presence() -> (lines: [String], missingRequired: [String]) {
    var parts: [String] = []
    var missing: [String] = []
    for stage in PipelineStage.allCases {
      guard let name = modelName(for: stage) else { continue }
      let found = (try? modelURL(named: name)) != nil
      parts.append("\(stage.rawValue)=\(found ? "present" : "MISSING")")
      if !found && ModelRegistry.requiredStages.contains(stage) { missing.append(name) }
    }
    return (["models: " + parts.joined(separator: " ")], missing)
  }

  /// Without these the app cannot see objects or judge distance at all.
  static let requiredStages: Set<PipelineStage> = [.detector, .depth]

  // MARK: Loading

  private func loadModel(named name: String) throws -> LoadedModel {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .all

    let url = try modelURL(named: name)
    let compiledURL: URL
    if url.pathExtension == "mlmodelc" {
      compiledURL = url
    } else {
      do {
        compiledURL = try MLModel.compileModel(at: url)
      } catch {
        throw ModelRegistryError.compileFailed(name: name, underlying: error)
      }
    }

    do {
      let model = try MLModel(contentsOf: compiledURL, configuration: configuration)
      let vnModel = try VNCoreMLModel(for: model)
      return LoadedModel(
        name: name, model: model, vnModel: vnModel, manifest: manifest(named: name),
        computeUnits: configuration.computeUnits)
    } catch {
      throw ModelRegistryError.loadFailed(name: name, underlying: error)
    }
  }

  /// Xcode compiles a bundled `.mlpackage` to `.mlmodelc`; a pod resource copied
  /// verbatim stays a `.mlpackage`. Try both, in that order.
  private func modelURL(named name: String) throws -> URL {
    if let compiled = bundle.url(forResource: name, withExtension: "mlmodelc") {
      return compiled
    }
    if let packaged = bundle.url(forResource: name, withExtension: "mlpackage") {
      return packaged
    }
    if let nested = bundle.url(forResource: name, withExtension: "mlmodelc", subdirectory: "models") {
      return nested
    }
    if let nested = bundle.url(forResource: name, withExtension: "mlpackage", subdirectory: "models") {
      return nested
    }
    throw ModelRegistryError.notFound(name: name)
  }

  private func manifest(named name: String) -> ModelManifest? {
    let candidates = [
      bundle.url(forResource: name, withExtension: "json"),
      bundle.url(forResource: name, withExtension: "json", subdirectory: "models"),
    ]
    for case let url? in candidates {
      guard let data = try? Data(contentsOf: url) else { continue }
      if let decoded = try? JSONDecoder().decode(ModelManifest.self, from: data) {
        return decoded
      }
    }
    return nil
  }

  public static func describe(_ units: MLComputeUnits) -> String {
    switch units {
    case .cpuOnly: return "cpuOnly"
    case .cpuAndGPU: return "cpuAndGPU"
    case .all: return "all"
    case .cpuAndNeuralEngine: return "cpuAndNeuralEngine"
    @unknown default: return "unknown"
    }
  }
}

// MARK: - Thermal watcher

/// Reads `ProcessInfo.thermalState` at most once a second (09 §9) and reports
/// the string `getStats()` carries.
public struct ThermalWatcher {
  private var cached: ProcessInfo.ThermalState = .nominal
  private var lastReadAt: Double?

  public init() {}

  @discardableResult
  public mutating func read(at t: Double, processInfo: ProcessInfo = .processInfo) -> ProcessInfo.ThermalState {
    if let last = lastReadAt, t - last < 1.0 { return cached }
    lastReadAt = t
    cached = processInfo.thermalState
    return cached
  }

  public var state: ProcessInfo.ThermalState { cached }

  public var name: String { ThermalWatcher.describe(cached) }

  public static func describe(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  public mutating func reset() {
    cached = .nominal
    lastReadAt = nil
  }
}
