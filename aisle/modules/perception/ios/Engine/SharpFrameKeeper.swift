//
//  SharpFrameKeeper.swift
//  Perception
//
//  Round 6: "sharpest of the last second", not "latest". Stills go to Claude
//  while the user is turning slowly to show the app the room — exactly when
//  frames are blurred. Retaining several ARFrames stalls ARKit's camera pool,
//  so this keeps at most ONE private copy: each frame gets a cheap sharpness
//  score on its luma plane (gradient energy on a coarse grid, ~40k samples,
//  ~0.1 ms) and the copy is replaced only when a clearly sharper frame arrives
//  or the kept one is older than `maxAgeSeconds`. Copies are rate-limited so a
//  steadily improving pan does not memcpy at 30 fps.
//
//  Falls back gracefully: on a copy failure the caller uses the live frame.
//
import CoreVideo
import Foundation
import ImageIO

public struct KeptFrame {
  public var pixelBuffer: CVPixelBuffer
  public var orientation: CGImagePropertyOrientation
  public var horizonRow: Double?
  public var timestampMs: Double
  public var sharpness: Double
  public var keptAt: TimeInterval
}

public final class SharpFrameKeeper {
  /// A frame older than this is replaced by the next one regardless of sharpness.
  public var maxAgeSeconds: TimeInterval = 1.0
  /// A candidate must beat the kept frame by this factor to replace it early.
  public var improvementFactor: Double = 1.15
  /// Minimum spacing between early replacements (memcpy budget).
  public var minCopyInterval: TimeInterval = 0.15
  /// Every Nth frame is scored (30 fps → 15 fps at 2).
  public var scoreEvery: Int = 2

  private let lock = NSLock()
  private var kept: KeptFrame?
  private var lastCopyAt: TimeInterval = 0
  private var counter = 0

  public init() {}

  public var best: KeptFrame? {
    lock.lock(); defer { lock.unlock() }
    return kept
  }

  public func reset() {
    lock.lock(); defer { lock.unlock() }
    kept = nil
  }

  /// Called on the frame queue with ARKit's live buffer; copies only when it decides to keep it.
  public func offer(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
                    horizonRow: Double?, timestampMs: Double, now: TimeInterval) {
    counter &+= 1
    guard counter % max(1, scoreEvery) == 0 else { return }
    let score = SharpFrameKeeper.sharpness(of: pixelBuffer)

    lock.lock()
    let current = kept
    lock.unlock()

    let stale = current.map { now - $0.keptAt > maxAgeSeconds } ?? true
    let better = current.map { score > $0.sharpness * improvementFactor } ?? true
    let spaced = now - lastCopyAt >= minCopyInterval
    guard stale || (better && spaced) else { return }
    guard let copy = SharpFrameKeeper.copy(pixelBuffer) else { return }

    lock.lock()
    kept = KeptFrame(pixelBuffer: copy, orientation: orientation, horizonRow: horizonRow,
                     timestampMs: timestampMs, sharpness: score, keptAt: now)
    lastCopyAt = now
    lock.unlock()
  }

  /// Mean absolute horizontal + vertical luma gradient on a coarse grid of plane 0.
  /// Works for the 420f/420v buffers ARKit delivers (plane 0 is Y) and for BGRA (first byte).
  public static func sharpness(of buffer: CVPixelBuffer, step: Int = 8) -> Double {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let planar = CVPixelBufferIsPlanar(buffer)
    guard let base = planar ? CVPixelBufferGetBaseAddressOfPlane(buffer, 0) : CVPixelBufferGetBaseAddress(buffer) else { return 0 }
    let width = planar ? CVPixelBufferGetWidthOfPlane(buffer, 0) : CVPixelBufferGetWidth(buffer)
    let height = planar ? CVPixelBufferGetHeightOfPlane(buffer, 0) : CVPixelBufferGetHeight(buffer)
    let stride = planar ? CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) : CVPixelBufferGetBytesPerRow(buffer)
    let bytesPerPixel = planar ? 1 : max(1, stride / max(1, width))
    guard width > step * 2, height > step * 2 else { return 0 }
    let p = base.assumingMemoryBound(to: UInt8.self)
    var sum = 0
    var n = 0
    var y = step
    while y < height - step {
      let row = y * stride
      let rowDown = (y + step) * stride
      var x = step
      while x < width - step {
        let i = row + x * bytesPerPixel
        let v = Int(p[i])
        let dx = abs(v - Int(p[i + step * bytesPerPixel]))
        let dy = abs(v - Int(p[rowDown + x * bytesPerPixel]))
        sum += dx + dy
        n += 1
        x += step
      }
      y += step
    }
    return n > 0 ? Double(sum) / Double(n) : 0
  }

  /// A private copy with the same format, planes and dimensions.
  static func copy(_ src: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(src)
    let height = CVPixelBufferGetHeight(src)
    let format = CVPixelBufferGetPixelFormatType(src)
    var dstOpt: CVPixelBuffer?
    let attrs: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, attrs as CFDictionary, &dstOpt) == kCVReturnSuccess,
          let dst = dstOpt else { return nil }
    CVPixelBufferLockBaseAddress(src, .readOnly)
    CVPixelBufferLockBaseAddress(dst, [])
    defer {
      CVPixelBufferUnlockBaseAddress(dst, [])
      CVPixelBufferUnlockBaseAddress(src, .readOnly)
    }
    if CVPixelBufferIsPlanar(src) {
      let planes = CVPixelBufferGetPlaneCount(src)
      for plane in 0..<planes {
        guard let s = CVPixelBufferGetBaseAddressOfPlane(src, plane),
              let d = CVPixelBufferGetBaseAddressOfPlane(dst, plane) else { return nil }
        let rows = CVPixelBufferGetHeightOfPlane(src, plane)
        let sStride = CVPixelBufferGetBytesPerRowOfPlane(src, plane)
        let dStride = CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
        let bytes = min(sStride, dStride)
        for r in 0..<rows {
          memcpy(d + r * dStride, s + r * sStride, bytes)
        }
      }
    } else {
      guard let s = CVPixelBufferGetBaseAddress(src), let d = CVPixelBufferGetBaseAddress(dst) else { return nil }
      let rows = CVPixelBufferGetHeight(src)
      let sStride = CVPixelBufferGetBytesPerRow(src)
      let dStride = CVPixelBufferGetBytesPerRow(dst)
      let bytes = min(sStride, dStride)
      for r in 0..<rows {
        memcpy(d + r * dStride, s + r * sStride, bytes)
      }
    }
    return dst
  }
}
