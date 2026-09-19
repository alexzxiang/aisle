Pod::Spec.new do |s|
  s.name           = 'Perception'
  s.version        = '0.1.0'
  s.summary        = 'Aisle PerceptionModule: the single camera owner (ARKit world tracking, Vision OCR, CoreML) that emits rate-limited Tier 0 events.'
  s.description    = <<-DESC
    Headless ARKit session on ARWorldTrackingConfiguration (.gravityAndHeading), the COCO
    detector, the pedestrian-signal model, Depth Anything V2 small and Apple Vision OCR,
    with every temporal filter in Swift. Pixels leave only through snapshotJPEG(maxWidth).
    Spec: 09-PERCEPTION-MODULE.md. Events and methods: 01-SHARED-CONTRACTS.md §7.
  DESC
  s.author         = 'Aisle (SteelHacks XIII) — Agent C'
  s.homepage       = 'https://github.com/steelhacks/aisle'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.frameworks = 'ARKit', 'Vision', 'CoreML', 'CoreImage', 'Accelerate', 'CoreVideo', 'ImageIO'

  # The Expo wrapper plus the pure-Swift engine under Engine/.
  s.source_files = '**/*.{h,m,mm,swift}'

  # Model packages (04 Task 2 / 09 §8 step 4). Committed under <app>/models/ by
  # Agent C after D's handoff PR; absent files are skipped so a checkout without
  # weights still builds (the engine reports the missing model and degrades).
  # Xcode compiles each .mlpackage to .mlmodelc when it is a resource of the pod.
  models_dir = File.expand_path('../../../models', __dir__)
  model_globs = Dir.glob(File.join(models_dir, '*.{mlpackage,mlmodelc}')) + Dir.glob(File.join(models_dir, '*.json'))
  s.resources = model_globs unless model_globs.empty?

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
end
