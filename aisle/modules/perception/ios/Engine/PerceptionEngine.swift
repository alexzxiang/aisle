//
//  PerceptionEngine.swift
//  Aisle — PerceptionModule engine
//
//  The scheduler that ties the ARKit frame stream to the models and the
//  filters, and the only object the Expo wrapper talks to. It:
//
//    - runs the per-profile schedule (`ModelRegistry`), stage by stage, by frame
//      counter, dropping frames when a model is busy (09 §2);
//    - feeds detector output through the tracker → looming / hazard filters,
//      the signal model through the gate → 5-of-8 → onset, the depth map through
//      the obstacle estimator, the frame through OCR when indoors;
//    - emits every 01 §7 event through one `EventSink`, honouring the rate
//      limits (`onDetections` ≤ 5 Hz, `onPose` 10 Hz, `onPlanes` 1 Hz, …);
//    - keeps `getStats()` to its five frozen fields and records the jsonl debug
//      export D's replayer consumes (09 §10).
//
//  All engine state is touched on `session.frameQueue`; model inference runs on
//  per-stage queues and hops back to `frameQueue` with its result. No Expo
//  import anywhere in this directory.
//

import ARKit
import CoreML
import Foundation
import Vision

// MARK: - Sink

public protocol PerceptionEventSink: AnyObject {
  /// Called on the engine's frame queue. The wrapper forwards to `sendEvent`.
  func perceptionEngine(_ engine: PerceptionEngine, emit event: PerceptionEventName, payload: [String: Any])
  func perceptionEngine(_ engine: PerceptionEngine, log message: String)
}

public enum PerceptionEngineError: Error, CustomStringConvertible {
  case unknownProfile(String)
  case notRunning

  public var description: String {
    switch self {
    case .unknownProfile(let p): return "unknown ModeProfile '\(p)'"
    case .notRunning: return "perception engine is not running"
    }
  }
}

// MARK: - Engine

public final class PerceptionEngine: ARSessionManagerDelegate {
  public weak var sink: PerceptionEventSink?

  public let session = ARSessionManager()
  public let registry: ModelRegistry
  public let signal = SignalDetector()
  public let ocr = OcrReader()
  public let snapshots = SnapshotEncoder()

  public private(set) var profile: ModeProfile = .idle
  public private(set) var schedule: ProfileSchedule = ProfileSchedules.schedule(for: .idle, segmentationEnabled: false)
  public private(set) var isRunning = false

  private var tracker = IoUTracker()
  private var looming = LoomingFilter()
  private var hazards = HazardFilter()
  private var obstacles = ObstacleEstimator()
  private var thermal = ThermalWatcher()

  private var throttles: [PipelineStage: FrameThrottle] = Dictionary(
    uniqueKeysWithValues: PipelineStage.allCases.map { ($0, FrameThrottle()) })
  private var fpsMeters: [PipelineStage: FpsMeter] = Dictionary(
    uniqueKeysWithValues: PipelineStage.allCases.map { ($0, FpsMeter()) })

  private var detectionsLimiter = RateLimiter(intervalSeconds: 0.2)   // ≤ 5 Hz
  private var poseLimiter = RateLimiter(intervalSeconds: 0.1)         // 10 Hz
  private var planePoll = RateLimiter(intervalSeconds: 1.0)           // 1 Hz
  private var lateralArbiter = LateralOffsetArbiter()

  /// Last frame → event latency for the safety events, ms (01 §11 budget).
  private var lastFrameToEventMs: Double = 0

  private let detectorQueue = DispatchQueue(label: "aisle.perception.detector", qos: .userInteractive)
  private let signalQueue = DispatchQueue(label: "aisle.perception.signal", qos: .userInteractive)
  private let depthQueue = DispatchQueue(label: "aisle.perception.depth", qos: .userInitiated)
  private let ocrQueue = DispatchQueue(label: "aisle.perception.ocr", qos: .utility)

  private var debugExport: DebugExportRecorder?

  public init(registry: ModelRegistry = ModelRegistry()) {
    self.registry = registry
    session.delegate = self
  }

  // MARK: Lifecycle (any queue)

  public func start(profileName: String) throws {
    guard let p = ModeProfile(rawValue: profileName) else {
      throw PerceptionEngineError.unknownProfile(profileName)
    }
    session.frameQueue.async { [self] in
      isRunning = true
      applyProfile(p)
    }
  }

  public func setProfile(_ profileName: String) {
    guard let p = ModeProfile(rawValue: profileName) else {
      sink?.perceptionEngine(self, log: "setProfile: unknown profile \(profileName)")
      return
    }
    session.frameQueue.async { [self] in
      applyProfile(p)
    }
  }

  public func stop() {
    session.frameQueue.async { [self] in
      isRunning = false
      session.pause()
      resetFilters(reason: "stop")
      registry.unloadAll()
      profile = .idle
      schedule = ProfileSchedules.schedule(for: .idle, segmentationEnabled: registry.segmentationEnabled)
    }
  }

  public func setCrossingBearing(_ deg: Double?) {
    session.frameQueue.async { [self] in
      let t = session.lastFrameContext?.geometry.timestamp ?? ProcessInfo.processInfo.systemUptime
      signal.setCrossingBearing(deg, at: t)
      if deg == nil {
        // 09 §5: every filter resets on setCrossingBearing(null).
        resetFilters(reason: "disarm")
      }
    }
  }

  public func setCourseReference(bearingDeg: Double?) {
    session.setCourseReference(bearingDeg: bearingDeg)
  }

  public func setBodyOffsetDeg(_ deg: Double) {
    session.setBodyOffsetDeg(deg)
  }

  public func setKnownSigns(_ words: [String]) {
    ocrQueue.async { [self] in
      ocr.setKnownSigns(words)
    }
  }

  public func trackingStateName() -> String {
    session.trackingState.rawValue
  }

  /// Exactly the five 01 §7 fields (09 §6).
  public func stats() -> StatsPayload {
    let t = ProcessInfo.processInfo.systemUptime
    let detector = fpsMeters[.detector]?.fps(at: t) ?? 0
    return StatsPayload(
      detectorFps: detector,
      depthFps: fpsMeters[.depth]?.fps(at: t) ?? 0,
      ocrFps: fpsMeters[.ocr]?.fps(at: t) ?? 0,
      frameToEventMs: lastFrameToEventMs,
      thermalState: thermal.name)
  }

  public func snapshotJPEG(maxWidth: Int, completion: @escaping (Result<SnapshotPayload, Error>) -> Void) {
    snapshots.snapshot(maxWidth: maxWidth, source: { [weak self] in
      guard let self, let ctx = self.session.lastFrameContext else { return nil }
      return SnapshotSource(
        pixelBuffer: ctx.pixelBuffer, orientation: ctx.orientation,
        horizonRow: ctx.geometry.horizonRow, timestampMs: ctx.timestampMs)
    }, completion: completion)
  }

  // MARK: Debug export (09 §10)

  public func startDebugExport(to url: URL) throws {
    let recorder = try DebugExportRecorder(url: url)
    session.frameQueue.async { [self] in
      debugExport = recorder
    }
  }

  public func stopDebugExport() -> URL? {
    var url: URL?
    session.frameQueue.sync { [self] in
      url = debugExport?.url
      debugExport?.close()
      debugExport = nil
    }
    return url
  }

  public func nativeLogLines() -> [String] {
    ["videoFormat=\(session.chosenFormat)"] + registry.loadLog()
  }

  // MARK: Profile (frameQueue)

  private func applyProfile(_ p: ModeProfile) {
    let previous = profile
    profile = p
    schedule = ProfileSchedules.schedule(for: p, segmentationEnabled: registry.segmentationEnabled)
    resetFilters(reason: "profile \(previous.rawValue) → \(p.rawValue)")

    // Lazy load / evict per profile (04 Task 2).
    let required = ProfileSchedules.requiredModels(for: p, segmentationEnabled: registry.segmentationEnabled)
    registry.retainOnly(required)
    for stage in required where stage != .ocr {
      do {
        if let loaded = try registry.load(stage), stage == .signal {
          signal.applyManifest(loaded.manifest)
        }
      } catch {
        sink?.perceptionEngine(self, log: "model load failed: \(error)")
      }
    }

    if schedule.sessionRunning {
      if !session.isRunning { session.run() }
    } else if session.isRunning {
      session.pause()
    }
    sink?.perceptionEngine(self, log: "profile=\(p.rawValue) format=\(session.chosenFormat) models=\(required.map { $0.rawValue }.sorted())")
  }

  private func resetFilters(reason: String) {
    tracker.reset()
    looming.reset()
    hazards.reset()
    obstacles.reset()
    ocr.reset()
    lateralArbiter.reset()
    for stage in PipelineStage.allCases {
      throttles[stage]?.reset()
    }
    signal.reset()
  }

  // MARK: ARSessionManagerDelegate (frameQueue)

  public func sessionManager(_ manager: ARSessionManager, didUpdate context: FrameContext) {
    guard isRunning else { return }
    let t = context.geometry.timestamp
    let effective = schedule.downshifted(
      for: thermal.read(at: t), safetyStage: ProfileSchedules.safetyStage(for: profile))

    if poseLimiter.allow(at: t) {
      emit(.pose, context.pose.dictionary, frameTime: nil)
    }
    if planePoll.allow(at: t) {
      emit(.planes, manager.planesSnapshot().dictionary, frameTime: nil)
    }

    if effective.detectorFps > 0, throttles[.detector]?.shouldRun(frame: context.frameIndex, targetFps: effective.detectorFps) == true {
      runDetector(context)
    }
    if effective.signalFps > 0, signal.isArmed, throttles[.signal]?.shouldRun(frame: context.frameIndex, targetFps: effective.signalFps) == true {
      runSignal(context)
    }
    if effective.depthFps > 0, throttles[.depth]?.shouldRun(frame: context.frameIndex, targetFps: effective.depthFps) == true {
      runDepth(context)
    }
    if effective.ocrFps > 0, throttles[.ocr]?.shouldRun(frame: context.frameIndex, targetFps: effective.ocrFps) == true {
      runOcr(context)
    }
  }

  public func sessionManager(_ manager: ARSessionManager, trackingStateChanged state: TrackingStateName) {
    emit(.trackingState, TrackingStatePayload(state: state).dictionary, frameTime: nil)
  }

  public func sessionManager(_ manager: ARSessionManager, lateralOffset payload: LateralOffsetPayload) {
    if let chosen = lateralArbiter.offer(payload, at: manager.lastFrameContext?.geometry.timestamp ?? 0,
                                         tracking: manager.trackingState) {
      emit(.lateralOffset, chosen.dictionary, frameTime: nil)
    }
  }

  public func sessionManager(_ manager: ARSessionManager, planes payload: PlanesPayload) {
    emit(.planes, payload.dictionary, frameTime: nil)
  }

  public func sessionManagerWasInterrupted(_ manager: ARSessionManager) {
    sink?.perceptionEngine(self, log: "session interrupted")
  }

  public func sessionManagerInterruptionEnded(_ manager: ARSessionManager) {
    // 09 §2: reset all temporal filters, re-arm the signal gate if one was set.
    resetFilters(reason: "interruption ended")
    signal.rearm(at: ProcessInfo.processInfo.systemUptime)
    sink?.perceptionEngine(self, log: "session resumed; filters reset")
  }

  public func sessionManager(_ manager: ARSessionManager, didFail error: Error) {
    sink?.perceptionEngine(self, log: "ARSession failed: \(error)")
    emit(.trackingState, TrackingStatePayload(state: .notAvailable).dictionary, frameTime: nil)
  }

  // MARK: Stages

  private func runDetector(_ context: FrameContext) {
    guard let model = registry.model(for: .detector) else { return }
    throttles[.detector]?.markBusy()
    let frameTime = context.geometry.timestamp
    let indoor = profile == .indoorNav || profile == .itemPickup
    detectorQueue.async { [self] in
      let raw = VisionRunner.detect(
        model: model, pixelBuffer: context.pixelBuffer, orientation: context.orientation,
        roi: nil, labelMap: { CocoLabels.detectionClass(for: $0) })
      session.frameQueue.async { [self] in
        throttles[.detector]?.markIdle()
        fpsMeters[.detector]?.tick(at: frameTime)
        var tracked = tracker.update(raw, at: frameTime)
        if indoor {
          tracked = hazards.applyCartHeuristic(tracked)
          if let hazard = hazards.evaluate(tracked, at: frameTime) {
            emit(.hazard, hazard.dictionary, frameTime: frameTime)
          }
        } else if let approaching = looming.evaluate(
          tracks: tracker.tracks, yawRateDegPerSec: context.geometry.yawRateDegPerSec, at: frameTime) {
          emit(.vehicleApproaching, approaching.dictionary, frameTime: frameTime)
        }
        if detectionsLimiter.allow(at: frameTime) {
          emitArray(.detections, tracked.map { $0.dictionary }, frameTime: nil)
        }
      }
    }
  }

  private func runSignal(_ context: FrameContext) {
    guard let model = registry.model(for: .signal) else { return }
    throttles[.signal]?.markBusy()
    let frameTime = context.geometry.timestamp
    // 09 §3: a square crop of the native centre band around the horizon row so
    // a distant head keeps its pixels. Normalized, top-left origin, upright.
    let roi = VisionRunner.centerBandROI(horizonRow: context.geometry.horizonRow)
    signalQueue.async { [self] in
      let raw = VisionRunner.detect(
        model: model, pixelBuffer: context.pixelBuffer, orientation: context.orientation,
        roi: roi, labelMap: { DetectionClass(rawValue: $0) })
      session.frameQueue.async { [self] in
        throttles[.signal]?.markIdle()
        fpsMeters[.signal]?.tick(at: frameTime)
        // Signal boxes do not need track ids for the vote; give them a stable
        // negative id so DebugPanel can tell them from COCO tracks.
        let detections = raw.enumerated().map { index, d in
          DetectionPayload(cls: d.cls, box: d.box, score: d.score, trackId: -(index + 1))
        }
        let outcome = signal.process(detections: detections, geometry: context.geometry)
        if let reading = outcome.reading {
          emit(.signalState, reading.payload.dictionary, frameTime: reading.changed ? frameTime : nil)
        }
      }
    }
  }

  private func runDepth(_ context: FrameContext) {
    guard let model = registry.model(for: .depth) else { return }
    throttles[.depth]?.markBusy()
    let frameTime = context.geometry.timestamp
    let indoor = profile == .indoorNav || profile == .itemPickup
    depthQueue.async { [self] in
      let grid = VisionRunner.depthGrid(
        model: model, pixelBuffer: context.pixelBuffer, orientation: context.orientation, timestamp: frameTime)
      session.frameQueue.async { [self] in
        throttles[.depth]?.markIdle()
        fpsMeters[.depth]?.tick(at: frameTime)
        guard let grid else { return }
        let outcome = obstacles.process(grid, indoor: indoor)
        if let depth = outcome.depth {
          emit(.depth, depth.dictionary, frameTime: nil)
        }
        if let obstacle = outcome.obstacle {
          emit(.obstacleAhead, obstacle.dictionary, frameTime: frameTime)
        }
        if let shelf = outcome.shelfOffset,
           let chosen = lateralArbiter.offer(shelf, at: frameTime, tracking: session.trackingState) {
          emit(.lateralOffset, chosen.dictionary, frameTime: nil)
        }
      }
    }
  }

  private func runOcr(_ context: FrameContext) {
    let frameTime = context.geometry.timestamp
    if let skip = ocr.shouldSkip(
      yawRateDegPerSec: context.geometry.yawRateDegPerSec,
      trackingLimitedByMotion: session.limitedByMotion, at: frameTime) {
      _ = skip
      return
    }
    throttles[.ocr]?.markBusy()
    ocrQueue.async { [self] in
      let result = ocr.recognize(
        pixelBuffer: context.pixelBuffer, orientation: context.orientation,
        timestampMs: context.timestampMs, now: frameTime)
      session.frameQueue.async { [self] in
        throttles[.ocr]?.markIdle()
        fpsMeters[.ocr]?.tick(at: frameTime)
        if !result.reads.isEmpty {
          emitArray(.ocrText, result.reads.map { $0.dictionary }, frameTime: nil)
        }
        if let offset = result.lateralOffset,
           let chosen = lateralArbiter.offer(offset, at: frameTime, tracking: session.trackingState) {
          emit(.lateralOffset, chosen.dictionary, frameTime: nil)
        }
      }
    }
  }

  // MARK: Emit

  private func emit(_ event: PerceptionEventName, _ payload: [String: Any], frameTime: Double?) {
    if let frameTime {
      lastFrameToEventMs = max(0, (ProcessInfo.processInfo.systemUptime - frameTime) * 1000)
    }
    debugExport?.record(event: event, payload: payload)
    sink?.perceptionEngine(self, emit: event, payload: payload)
  }

  /// `onOcrText` and `onDetections` carry arrays; the wrapper unwraps `items`.
  private func emitArray(_ event: PerceptionEventName, _ items: [[String: Any]], frameTime: Double?) {
    emit(event, ["items": items], frameTime: frameTime)
  }
}

// MARK: - Lateral offset precedence

/// 04 Task 6: `pose` when tracking is NORMAL; else `shelf`; `ocr_box` only while
/// a sign is in view. Emits ≤ 5 Hz overall so three producers do not triple the
/// budget.
struct LateralOffsetArbiter {
  private var limiter = RateLimiter(intervalSeconds: 0.2)
  private var lastOcrAt: Double?
  private var lastShelf: LateralOffsetPayload?
  private var lastOcr: LateralOffsetPayload?

  mutating func offer(_ payload: LateralOffsetPayload, at t: Double, tracking: TrackingStateName) -> LateralOffsetPayload? {
    switch payload.source {
    case .ocrBox:
      lastOcr = payload
      lastOcrAt = t
    case .shelf:
      lastShelf = payload
    case .pose, .curb, .none:
      break
    }

    let chosen: LateralOffsetPayload
    if payload.source == .pose || payload.source == .curb {
      if tracking == .normal || payload.source == .curb {
        chosen = payload
      } else if let shelf = lastShelf {
        chosen = shelf
      } else if let ocr = lastOcr, let at = lastOcrAt, t - at < 1.0 {
        chosen = ocr
      } else {
        chosen = LateralOffsetPayload(offsetM: 0, source: .none)
      }
    } else if payload.source == .none {
      if let shelf = lastShelf {
        chosen = shelf
      } else if let ocr = lastOcr, let at = lastOcrAt, t - at < 1.0 {
        chosen = ocr
      } else {
        chosen = payload
      }
    } else {
      // shelf / ocr_box only stand in when pose is unavailable.
      guard tracking != .normal else { return nil }
      chosen = payload.source == .shelf ? payload : (lastShelf ?? payload)
    }
    guard limiter.allow(at: t) else { return nil }
    return chosen
  }

  mutating func reset() {
    limiter.reset()
    lastOcrAt = nil
    lastShelf = nil
    lastOcr = nil
  }
}

// MARK: - Vision plumbing

/// The only place a CoreML request is built. Boxes come back normalized to the
/// upright frame with a top-left origin.
enum VisionRunner {
  /// Through the one shared mapping in `NormalizedBox.fromVision`.
  static func upright(_ visionBox: CGRect, roi: CGRect?) -> NormalizedBox {
    let r = roi.map { (x: Double($0.minX), y: Double($0.minY), w: Double($0.width), h: Double($0.height)) }
    return NormalizedBox.fromVision(
      minX: Double(visionBox.minX), minY: Double(visionBox.minY),
      width: Double(visionBox.width), height: Double(visionBox.height), roi: r)
  }

  /// Square centre-band crop around the horizon, in Vision's bottom-left ROI
  /// space, full width of the upright (portrait) frame.
  static func centerBandROI(horizonRow: Double?, aspect: Double = 4.0 / 3.0) -> CGRect {
    // Portrait frame: height/width = aspect. A square of side = width spans
    // 1/aspect of the height.
    let sideNormalizedHeight = 1.0 / aspect
    let centerTop = horizonRow ?? 0.40
    var top = centerTop - sideNormalizedHeight / 2
    top = max(0, min(top, 1 - sideNormalizedHeight))
    let bottomLeftY = 1 - (top + sideNormalizedHeight)
    return CGRect(x: 0, y: bottomLeftY, width: 1, height: sideNormalizedHeight)
  }

  static func detect(model: LoadedModel, pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                     roi: CGRect?, labelMap: (String) -> DetectionClass?) -> [RawDetection] {
    let request = VNCoreMLRequest(model: model.vnModel)
    request.imageCropAndScaleOption = roi == nil ? .scaleFit : .scaleFill
    if let roi { request.regionOfInterest = roi }
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return []
    }
    guard let observations = request.results as? [VNRecognizedObjectObservation] else { return [] }
    return observations.compactMap { obs in
      guard let top = obs.labels.first, let cls = labelMap(top.identifier) else { return nil }
      return RawDetection(cls: cls, box: upright(obs.boundingBox, roi: roi), score: Double(top.confidence))
    }
  }

  /// Depth Anything: an image output arrives as `VNPixelBufferObservation`; a
  /// multi-array output as `VNCoreMLFeatureValueObservation`. Handle both.
  static func depthGrid(model: LoadedModel, pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                        timestamp: Double) -> DepthGrid? {
    let request = VNCoreMLRequest(model: model.vnModel)
    request.imageCropAndScaleOption = .scaleFill
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    if let pixel = request.results?.first as? VNPixelBufferObservation {
      return DepthGrid.from(pixelBuffer: pixel.pixelBuffer, timestamp: timestamp)
    }
    if let feature = request.results?.first as? VNCoreMLFeatureValueObservation,
       let array = feature.featureValue.multiArrayValue {
      return depthGrid(from: array, timestamp: timestamp)
    }
    return nil
  }

  /// Multi-array of shape [1, H, W] / [H, W] / [1, 1, H, W].
  static func depthGrid(from array: MLMultiArray, timestamp: Double) -> DepthGrid? {
    let shape = array.shape.map { $0.intValue }
    guard shape.count >= 2 else { return nil }
    let height = shape[shape.count - 2]
    let width = shape[shape.count - 1]
    let strides = array.strides.map { $0.intValue }
    let rowStride = strides[strides.count - 2]
    let colStride = strides[strides.count - 1]
    guard width > 0, height > 0 else { return nil }

    var grid: DepthGrid?
    switch array.dataType {
    case .float32:
      let ptr = array.dataPointer.assumingMemoryBound(to: Float32.self)
      grid = DepthGrid.reduce(width: width, height: height, timestamp: timestamp) { x, y in
        ptr[y * rowStride + x * colStride]
      }
    case .float16:
      let ptr = array.dataPointer.assumingMemoryBound(to: UInt16.self)
      grid = DepthGrid.reduce(width: width, height: height, timestamp: timestamp) { x, y in
        Float(Float16(bitPattern: ptr[y * rowStride + x * colStride]))
      }
    case .double:
      let ptr = array.dataPointer.assumingMemoryBound(to: Double.self)
      grid = DepthGrid.reduce(width: width, height: height, timestamp: timestamp) { x, y in
        Float(ptr[y * rowStride + x * colStride])
      }
    default:
      return nil
    }
    grid?.normalizeInPlace()
    return grid
  }
}

// MARK: - Debug export

/// Appends `{"t","event","payload"}` lines (05 Part 1 shape). `t` is ms from
/// the first recorded event so D's replayer re-bases it to `Date.now()`.
public final class DebugExportRecorder {
  public let url: URL
  private let handle: FileHandle
  private var startedAt: Double?
  private let encoder = JSONEncoder()

  public init(url: URL) throws {
    self.url = url
    FileManager.default.createFile(atPath: url.path, contents: nil)
    self.handle = try FileHandle(forWritingTo: url)
    encoder.outputFormatting = [.sortedKeys]
  }

  public func record(event: PerceptionEventName, payload: [String: Any]) {
    let now = ProcessInfo.processInfo.systemUptime * 1000
    if startedAt == nil { startedAt = now }
    let line = DebugExportLine(
      t: now - (startedAt ?? now), event: event.rawValue,
      payload: payload.mapValues { JSONValue.from($0) })
    guard var data = try? encoder.encode(line) else { return }
    data.append(0x0A)
    handle.write(data)
  }

  public func close() {
    try? handle.close()
  }
}
