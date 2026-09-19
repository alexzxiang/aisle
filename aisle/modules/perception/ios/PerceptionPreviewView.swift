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
    onReady(["attached": true, "running": session.currentFrame != nil])
  }

  private func applyMirror() {
    sceneView.transform = mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
  }
}
