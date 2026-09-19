//
//  PerceptionModule.swift
//  Aisle — PerceptionModule (Expo Modules API wrapper)
//
//  The ONLY file under modules/perception that imports ExpoModulesCore. It wires
//  the JS-facing surface in 01 §7 / 09 §6 to `PerceptionEngine` and does nothing
//  else: no filtering, no geometry, no pixels. Keep it thin and obviously
//  correct — it cannot be typechecked outside an Expo prebuild, and the engine
//  under Engine/ can (`xcrun -sdk iphoneos swiftc -typecheck …`).
//
//  Every event name comes from `PerceptionEventName.allCases`, so the wrapper,
//  the engine and `../index.ts` agree by construction.
//

import ExpoModulesCore
import Foundation

public class PerceptionModule: Module, PerceptionEventSink {
  private lazy var engine: PerceptionEngine = {
    let e = PerceptionEngine()
    e.sink = self
    return e
  }()

  public func definition() -> ModuleDefinition {
    Name("Perception")

    Events(PerceptionEventName.allCases.map { $0.rawValue })

    // MARK: Lifecycle

    AsyncFunction("start") { (profile: String) throws in
      try self.engine.start(profileName: profile)
    }

    Function("setProfile") { (profile: String) in
      self.engine.setProfile(profile)
    }

    Function("stop") {
      self.engine.stop()
    }

    // MARK: Context the native filters need (null clears)

    Function("setCrossingBearing") { (bearingDeg: Double?) in
      self.engine.setCrossingBearing(bearingDeg)
    }

    Function("setCourseReference") { (bearingDeg: Double?) in
      self.engine.setCourseReference(bearingDeg: bearingDeg)
    }

    Function("setBodyOffsetDeg") { (offsetDeg: Double) in
      self.engine.setBodyOffsetDeg(offsetDeg)
    }

    Function("setKnownSigns") { (words: [String]) in
      self.engine.setKnownSigns(words)
    }

    // MARK: Pixels leave the module here and nowhere else (09 §7)

    AsyncFunction("snapshotJPEG") { (maxWidth: Int, promise: Promise) in
      self.engine.snapshotJPEG(maxWidth: maxWidth) { result in
        switch result {
        case .success(let snapshot):
          promise.resolve(snapshot.dictionary)
        case .failure(let error):
          promise.reject("E_SNAPSHOT", String(describing: error))
        }
      }
    }

    // MARK: Sync reads

    Function("getTrackingState") { () -> String in
      self.engine.trackingStateName()
    }

    Function("getStats") { () -> [String: Any] in
      self.engine.stats().dictionary
    }

    // MARK: Debug export (09 §10) — the fixture recorder D's replayer consumes

    AsyncFunction("startDebugExport") { (path: String) throws in
      try self.engine.startDebugExport(to: URL(fileURLWithPath: path))
    }

    AsyncFunction("stopDebugExport") { () -> String? in
      self.engine.stopDebugExport()?.path
    }

    Function("nativeLog") { () -> [String] in
      self.engine.nativeLogLines()
    }

    OnDestroy {
      self.engine.stop()
    }
  }

  // MARK: PerceptionEventSink

  public func perceptionEngine(_ engine: PerceptionEngine, emit event: PerceptionEventName, payload: [String: Any]) {
    sendEvent(event.rawValue, payload)
  }

  public func perceptionEngine(_ engine: PerceptionEngine, log message: String) {
    // Native log only; never the JS hot path. Xcode console + the debug export.
    NSLog("[Perception] %@", message)
  }
}
