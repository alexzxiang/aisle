//
//  Snapshot.swift
//  Aisle — PerceptionModule engine
//
//  `snapshotJPEG(maxWidth)` (09 §7): the ONLY way pixels leave the module. The
//  privacy line in the pitch depends on that staying true.
//
//    - Takes the most recent `capturedImage`, rotates it upright, scales the
//      long edge to `maxWidth` (512 → 512×384 thumbnail for the default Claude
//      call, 640 → 640×480 when text must be read, 1024 only for the curb crop),
//      JPEG quality 0.8, orientation baked into the pixels (no EXIF reliance).
//    - Never blocks the frame loop: encodes on a utility queue; ≤ 2 snapshots in
//      flight; a third call returns the latest completed snapshot.
//    - `curb_crop` variant (1024): crops the horizon strip around the frame
//      centre before scaling so a distant signal head keeps its pixels.
//

import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum SnapshotError: Error, CustomStringConvertible {
  case noFrame
  case invalidWidth(Int)
  case encodeFailed

  public var description: String {
    switch self {
    case .noFrame: return "no camera frame available yet"
    case .invalidWidth(let w): return "snapshot width must be 512, 640, 768 or 1024, got \(w)"
    case .encodeFailed: return "JPEG encoding failed"
    }
  }
}

/// A retained copy of the latest frame's pixel buffer plus what the encoder
/// needs to make it upright.
public struct SnapshotSource {
  public var pixelBuffer: CVPixelBuffer
  public var orientation: CGImagePropertyOrientation
  /// Normalized horizon row in the upright frame, for the curb crop.
  public var horizonRow: Double?
  public var timestampMs: Double

  public init(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation,
              horizonRow: Double?, timestampMs: Double) {
    self.pixelBuffer = pixelBuffer
    self.orientation = orientation
    self.horizonRow = horizonRow
    self.timestampMs = timestampMs
  }
}

public final class SnapshotEncoder {
  /// 768 is the awareness / guided-task size: a 576×768 portrait frame is what
  /// Claude needs to tell eggs from a milk carton; 384×512 was not (round 6).
  public static let allowedWidths: Set<Int> = [512, 640, 768, 1024]
  public static let jpegQuality: Double = 0.8
  public static let curbCropWidth = 1024
  /// Curb crop keeps this fraction of the frame height around the horizon row.
  public static let curbCropHeightFraction = 0.35
  public static let maxInFlight = 2

  private let context: CIContext
  private let queue = DispatchQueue(label: "aisle.perception.snapshot", qos: .utility)
  private let lock = NSLock()
  private var inFlight = 0
  private var seq = 0
  private var latest: SnapshotPayload?

  public init(context: CIContext = CIContext(options: [.useSoftwareRenderer: false])) {
    self.context = context
  }

  public var latestCompleted: SnapshotPayload? {
    lock.lock(); defer { lock.unlock() }
    return latest
  }

  /// Asynchronous entry point used by the wrapper. `source()` is called on the
  /// utility queue so the caller never copies a frame on the ARKit thread.
  public func snapshot(maxWidth: Int, source: @escaping () -> SnapshotSource?,
                       completion: @escaping (Result<SnapshotPayload, Error>) -> Void) {
    guard SnapshotEncoder.allowedWidths.contains(maxWidth) else {
      completion(.failure(SnapshotError.invalidWidth(maxWidth)))
      return
    }

    lock.lock()
    if inFlight >= SnapshotEncoder.maxInFlight {
      let cached = latest
      lock.unlock()
      if let cached {
        completion(.success(cached))
      } else {
        completion(.failure(SnapshotError.noFrame))
      }
      return
    }
    inFlight += 1
    lock.unlock()

    queue.async { [self] in
      defer {
        lock.lock()
        inFlight -= 1
        lock.unlock()
      }
      guard let src = source() else {
        completion(.failure(SnapshotError.noFrame))
        return
      }
      let result = encode(source: src, maxWidth: maxWidth)
      if case .success(let payload) = result {
        lock.lock()
        latest = payload
        lock.unlock()
      }
      completion(result)
    }
  }

  /// Synchronous core, testable with a synthetic pixel buffer.
  public func encode(source: SnapshotSource, maxWidth: Int) -> Result<SnapshotPayload, Error> {
    var image = CIImage(cvPixelBuffer: source.pixelBuffer).oriented(source.orientation)
    let extent = image.extent

    if maxWidth == SnapshotEncoder.curbCropWidth {
      image = SnapshotEncoder.curbCrop(image, horizonRow: source.horizonRow)
    }

    let scaled = SnapshotEncoder.scaleToLongEdge(image, maxWidth: maxWidth)
    let outExtent = scaled.extent.integral
    guard outExtent.width > 0, outExtent.height > 0 else {
      return .failure(SnapshotError.encodeFailed)
    }

    guard let cgImage = context.createCGImage(scaled, from: outExtent) else {
      return .failure(SnapshotError.encodeFailed)
    }
    guard let data = SnapshotEncoder.jpegData(cgImage, quality: SnapshotEncoder.jpegQuality) else {
      return .failure(SnapshotError.encodeFailed)
    }

    lock.lock()
    seq += 1
    let thisSeq = seq
    lock.unlock()

    _ = extent
    return .success(SnapshotPayload(
      base64: data.base64EncodedString(),
      width: Int(outExtent.width), height: Int(outExtent.height),
      seq: thisSeq, timestamp: source.timestampMs))
  }

  /// Scale so the LONG edge equals `maxWidth` (a portrait frame is
  /// `maxWidth` tall). 512 → 384×512 portrait / 512×384 landscape: the token
  /// budgets in 04 Task 8 assume the long edge.
  static func scaleToLongEdge(_ image: CIImage, maxWidth: Int) -> CIImage {
    let extent = image.extent
    let longEdge = max(extent.width, extent.height)
    guard longEdge > 0 else { return image }
    let scale = CGFloat(maxWidth) / longEdge
    guard scale < 1 else { return image }
    return image
      .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      .transformed(by: CGAffineTransform(translationX: -image.extent.minX * scale,
                                         y: -image.extent.minY * scale))
  }

  /// Keep a horizontal strip around the horizon row, full width, so a distant
  /// signal head is not downscaled away. Core Image's origin is bottom-left.
  static func curbCrop(_ image: CIImage, horizonRow: Double?) -> CIImage {
    let extent = image.extent
    let row = horizonRow ?? 0.40
    let stripHeight = extent.height * CGFloat(SnapshotEncoder.curbCropHeightFraction)
    // horizonRow is top-origin; convert to Core Image's bottom-origin.
    let centerY = extent.minY + extent.height * CGFloat(1 - row)
    var minY = centerY - stripHeight / 2
    minY = max(extent.minY, min(minY, extent.maxY - stripHeight))
    let rect = CGRect(x: extent.minX, y: minY, width: extent.width, height: stripHeight)
    return image.cropped(to: rect)
      .transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
  }

  static func jpegData(_ image: CGImage, quality: Double) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else {
      return nil
    }
    let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(dest, image, options as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return data as Data
  }

  /// Expected output size for a 4:3 sensor at a given `maxWidth`, for tests and
  /// for the JS side's `image.width/height` sanity check.
  public static func expectedSize(maxWidth: Int, sensorAspect: Double = 4.0 / 3.0) -> (width: Int, height: Int) {
    (maxWidth, Int((Double(maxWidth) / sensorAspect).rounded()))
  }
}
