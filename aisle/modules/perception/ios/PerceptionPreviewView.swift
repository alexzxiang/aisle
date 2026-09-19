//
//  PerceptionPreviewView.swift
//  Aisle — PerceptionModule (Expo Modules API wrapper)
//
//  A live camera preview that BORROWS the engine's ARSession (09 §1: one camera
//  owner, no second capture session). An `ARSCNView` whose `session` is
//  `PerceptionEngine.arSession` renders the camera background and nothing else:
//  empty scene, lighting updates off, no SceneKit content, no gestures.
//
//  Guarantees, in order of importance:
//
//    1. Attaching never changes the session's configuration, delegate or
//       delegate queue. The engine keeps ownership; the view only reads. The
//       delegate is checked after the attach and restored if ARKit touched it.
//    2. The view never runs or pauses the session. Before `start()` it is black;
//       when the engine's profile pauses the session (IDLE: `sessionRunning ==
//       false`) the preview freezes on the last frame and resumes with the next
//       non-IDLE profile. Both are the documented behaviour, not bugs.
//    3. Detaching (deinit) hands the ARSCNView a throw-away session so the
//       engine's session is never released or paused by a dying view.
//
//  Like PerceptionModule.swift this file imports ExpoModulesCore and cannot be
//  typechecked outside the prebuilt workspace, so it is kept minimal.
//

import ARKit
import ExpoModulesCore
import SceneKit
import UIKit

final class PerceptionPreviewView: ExpoView {
  /// Fired once per attach: `{ attached: true, running: Bool }`. `running` is
  /// whether the borrowed session already had a frame; `false` means the view
  /// stays black until the engine's `start()`.
  let onReady = EventDispatcher()

  private let sceneView: ARSCNView
  private weak var attachedSession: ARSession?

  /// Horizontal flip (selfie-style). Default off: the rear camera is not mirrored.
  var mirror: Bool = false {
    didSet {
      if mirror != oldValue { applyMirror() }
    }
  }

  required init(appContext: AppContext? = nil) {
    sceneView = ARSCNView(frame: .zero)
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    isAccessibilityElement = false

    sceneView.scene = SCNScene()                    // camera background only; no content
    sceneView.automaticallyUpdatesLighting = false
    sceneView.autoenablesDefaultLighting = false
    sceneView.rendersCameraGrain = false
    sceneView.rendersMotionBlur = false
    sceneView.antialiasingMode = .none
    sceneView.preferredFramesPerSecond = 30           // 09 §2: the session never runs faster
    // Round 6c: the view is usually attached BEFORE the engine runs the session (CoreML compiles
    // for ~4 s on a fresh install). An ARSCNView attached to a not-yet-running session never
    // started its render loop (isPlaying stayed false, the box stayed black). Render continuously
    // and pull `currentFrame` every tick, whatever the session's state was at attach time.
    sceneView.rendersContinuously = true
    sceneView.isPlaying = true
    sceneView.isUserInteractionEnabled = false
    sceneView.isAccessibilityElement = false
    sceneView.backgroundColor = .black
    addSubview(sceneView)
  }

  deinit {
    // Detach without touching the engine's session (guarantee 3).
    if attachedSession != nil {
      sceneView.session = ARSession()
    }
  }

  // MARK: Layout (frame is undefined under a non-identity transform; use bounds + center)

  override func layoutSubviews() {
    super.layoutSubviews()
    sceneView.bounds = CGRect(origin: .zero, size: bounds.size)
    sceneView.center = CGPoint(x: bounds.midX, y: bounds.midY)
    if bounds.size != lastLoggedSize {
      lastLoggedSize = bounds.size
      NSLog("[Perception] preview: layout %.0fx%.0f attached=%d window=%d",
            bounds.width, bounds.height, attachedSession != nil ? 1 : 0, window != nil ? 1 : 0)
    }
  }

  private var lastLoggedSize: CGSize = .zero

  /// Diagnostic (round 6c "black box"): three seconds after attaching, say whether frames reach the view.
  private func scheduleHealthLog() {
    for delay in [3.0, 10.0, 20.0, 40.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self else { return }
        let frame = self.sceneView.session.currentFrame
        let same = self.attachedSession === self.sceneView.session ? 1 : 0
        NSLog("[Perception] preview: health t+%.0fs frame=%d sameSession=%d size=%.0fx%.0f hidden=%d alpha=%.2f window=%d paused=%d tracking=%@",
              delay, frame != nil ? 1 : 0, same, self.sceneView.bounds.width, self.sceneView.bounds.height,
              self.isHidden ? 1 : 0, Double(self.alpha), self.window != nil ? 1 : 0, self.sceneView.isPlaying ? 0 : 1,
              frame.map { "\($0.camera.trackingState)" } ?? "none")
      }
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { attachIfNeeded() }
  }

  // MARK: Session

  /// Fallback attach through the module registry. The primary path is the
  /// module's `OnViewDidUpdateProps`, which runs after the first props update.
  private func attachIfNeeded() {
    guard attachedSession == nil,
          let module = appContext?.moduleRegistry.get(moduleWithName: "Perception") as? PerceptionModule
    else { return }
    attach(session: module.engine.arSession)
  }

  /// Idempotent. Main thread (view lifecycle / prop setters are @MainActor).
  func attach(session: ARSession) {
    if attachedSession === session { return }
    let delegateBefore = session.delegate
    let queueBefore = session.delegateQueue
    sceneView.session = session
    // Guarantee 1: the engine stays the delegate whatever ARSCNView did.
    if session.delegate !== delegateBefore {
      session.delegate = delegateBefore
      NSLog("[Perception] preview: ARSCNView replaced the session delegate; restored")
    }
    if session.delegateQueue !== queueBefore {
      session.delegateQueue = queueBefore
      NSLog("[Perception] preview: ARSCNView replaced the delegate queue; restored")
    }
    attachedSession = session
    sceneView.isPlaying = true
    NSLog("[Perception] preview: attached running=%d delegateKept=%d", session.currentFrame != nil ? 1 : 0, session.delegate === delegateBefore ? 1 : 0)
    onReady(["attached": true, "running": session.currentFrame != nil])
    scheduleHealthLog()
    kickWhenSessionRuns(session)
  }

  /// A session attached before it ran: once frames flow, re-bind so the view picks the feed up.
  private func kickWhenSessionRuns(_ session: ARSession) {
    var attempts = 0
    func poll() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
        guard let self, self.attachedSession === session else { return }
        attempts += 1
        if session.currentFrame != nil {
          if !self.sceneView.isPlaying {
            self.sceneView.session = session
            self.sceneView.isPlaying = true
            NSLog("[Perception] preview: session started after attach; render loop kicked")
          }
          return
        }
        if attempts < 120 { poll() }   // up to a minute: a cold CoreML compile can take that long
      }
    }
    poll()
  }

  private func applyMirror() {
    sceneView.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
  }
}
