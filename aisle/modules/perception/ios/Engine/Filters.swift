//
//  Filters.swift
//  Aisle — PerceptionModule engine
//
//  The temporal machinery every pipeline shares: fixed-capacity ring buffers,
//  the N-of-M vote (09 §5.1 step 3), time-windowed sample buffers for the
//  looming and closing-rate filters, rate limiters for the 01 §7 event budgets,
//  hysteresis, and a small exponential smoother.
//
//  All pure Swift, all synchronous, all cheap. `09-PERCEPTION-MODULE.md` §5
//  requires every filter to reset on profile change, session interruption and
//  `setCrossingBearing(nil)`, so each type exposes `reset()` and the engine
//  calls it in one place.
//

import Foundation

// MARK: - Ring buffer

/// Fixed-capacity FIFO. Overwrites the oldest entry when full.
public struct RingBuffer<Element> {
  public let capacity: Int
  private var storage: [Element] = []
  private var head = 0

  public init(capacity: Int) {
    precondition(capacity > 0, "RingBuffer capacity must be positive")
    self.capacity = capacity
    storage.reserveCapacity(capacity)
  }

  public mutating func push(_ element: Element) {
    if storage.count < capacity {
      storage.append(element)
    } else {
      storage[head] = element
      head = (head + 1) % capacity
    }
  }

  public var count: Int { storage.count }
  public var isEmpty: Bool { storage.isEmpty }
  public var isFull: Bool { storage.count == capacity }

  /// Oldest → newest.
  public var elements: [Element] {
    guard storage.count == capacity else { return storage }
    return Array(storage[head...] + storage[..<head])
  }

  public var newest: Element? { elements.last }
  public var oldest: Element? { elements.first }

  public mutating func reset() {
    storage.removeAll(keepingCapacity: true)
    head = 0
  }
}

// MARK: - N-of-M vote

/// 09 §5.1 step 3: per-frame classes go into a ring of `m`; a state is emitted
/// only when at least `n` of the last `m` agree, otherwise UNKNOWN. This also
/// absorbs LED PWM flicker on the rolling shutter, which is the reason the
/// window is frames and not seconds.
public struct NOfMVoter<Value: Hashable> {
  public let n: Int
  public let m: Int
  private var ring: RingBuffer<Value?>

  public init(n: Int, m: Int) {
    precondition(n > 0 && n <= m, "N-of-M requires 0 < n <= m")
    self.n = n
    self.m = m
    self.ring = RingBuffer(capacity: m)
  }

  /// A frame with no qualifying detection pushes `nil` — an abstention, which
  /// still ages the window. Silence has to be able to win.
  public mutating func push(_ value: Value?) {
    ring.push(value)
  }

  public var sampleCount: Int { ring.count }

  /// The value with at least `n` votes in the window, and its vote count.
  /// `nil` when nothing clears the bar.
  public func winner() -> (value: Value, votes: Int)? {
    var tally: [Value: Int] = [:]
    for case let .some(v) in ring.elements {
      tally[v, default: 0] += 1
    }
    guard let best = tally.max(by: { lhs, rhs in lhs.value < rhs.value }) else { return nil }
    return best.value >= n ? (best.key, best.value) : nil
  }

  /// Votes for a specific value in the current window (diagnostics).
  public func votes(for value: Value) -> Int {
    ring.elements.reduce(0) { $0 + (($1 == value) ? 1 : 0) }
  }

  public mutating func reset() {
    ring.reset()
  }
}

// MARK: - Time-windowed samples

/// A (timestamp, value) buffer that answers "what was this `dt` seconds ago?".
/// Used by the looming filter's 0.5 s area-growth window (09 §5.2) and by the
/// depth closing rate (09 §5.3). Timestamps are seconds.
public struct TimedSamples<Value> {
  public let windowSeconds: Double
  private var samples: [(t: Double, value: Value)] = []

  public init(windowSeconds: Double) {
    self.windowSeconds = windowSeconds
  }

  public mutating func push(_ value: Value, at t: Double) {
    samples.append((t, value))
    let cutoff = t - windowSeconds
    // Keep one sample older than the cutoff so `oldest` can span the full
    // window instead of only what arrived inside it.
    var dropBefore = 0
    for (index, sample) in samples.enumerated() {
      if sample.t < cutoff { dropBefore = index } else { break }
    }
    if dropBefore > 0 { samples.removeFirst(dropBefore) }
  }

  public var count: Int { samples.count }
  public var newest: (t: Double, value: Value)? { samples.last }
  public var oldest: (t: Double, value: Value)? { samples.first }

  /// The sample at or before `t - dt`, i.e. "the state `dt` seconds ago".
  public func sample(secondsAgo dt: Double, now: Double) -> (t: Double, value: Value)? {
    let target = now - dt
    var result: (t: Double, value: Value)?
    for sample in samples where sample.t <= target { result = sample }
    return result ?? samples.first
  }

  /// Seconds between the oldest and newest retained sample.
  public var span: Double {
    guard let first = samples.first, let last = samples.last else { return 0 }
    return last.t - first.t
  }

  public mutating func reset() {
    samples.removeAll(keepingCapacity: true)
  }
}

// MARK: - Rate limiters

/// "≤ 1 event per `intervalSeconds`" (01 §7 rate limits). Monotonic in the
/// caller's clock; no timers, no queues — a suppressed event is dropped, never
/// deferred, because stale beats slow.
public struct RateLimiter {
  public let intervalSeconds: Double
  private var lastFiredAt: Double?

  public init(intervalSeconds: Double) {
    self.intervalSeconds = intervalSeconds
  }

  /// Returns true and arms the limiter when the caller may emit.
  public mutating func allow(at t: Double) -> Bool {
    if let last = lastFiredAt, t - last < intervalSeconds { return false }
    lastFiredAt = t
    return true
  }

  public func wouldAllow(at t: Double) -> Bool {
    guard let last = lastFiredAt else { return true }
    return t - last >= intervalSeconds
  }

  public mutating func reset() {
    lastFiredAt = nil
  }
}

/// Per-key variant: the vehicle filter's "the same track has not fired in the
/// last 4 s" (09 §5.2) needs one clock per `trackId`.
public struct KeyedRateLimiter<Key: Hashable> {
  public let intervalSeconds: Double
  private var lastFiredAt: [Key: Double] = [:]

  public init(intervalSeconds: Double) {
    self.intervalSeconds = intervalSeconds
  }

  public mutating func allow(_ key: Key, at t: Double) -> Bool {
    if let last = lastFiredAt[key], t - last < intervalSeconds { return false }
    lastFiredAt[key] = t
    return true
  }

  /// Forget keys not seen for `intervalSeconds * 4` so a long session does not
  /// grow the table without bound.
  public mutating func prune(before t: Double) {
    let cutoff = t - intervalSeconds * 4
    lastFiredAt = lastFiredAt.filter { $0.value >= cutoff }
  }

  public mutating func reset() {
    lastFiredAt.removeAll(keepingCapacity: true)
  }
}

/// "On change, plus a heartbeat every `heartbeatSeconds` while a state holds"
/// (01 §7 `onSignalState`). Returns true when the caller should emit.
public struct ChangeOrHeartbeat<Value: Equatable> {
  public let heartbeatSeconds: Double
  private var lastValue: Value?
  private var lastEmittedAt: Double?

  public init(heartbeatSeconds: Double) {
    self.heartbeatSeconds = heartbeatSeconds
  }

  public mutating func shouldEmit(_ value: Value, at t: Double) -> Bool {
    defer {
      lastValue = value
      // Only move the heartbeat clock when we actually said yes.
    }
    if lastValue != value {
      lastEmittedAt = t
      return true
    }
    if let last = lastEmittedAt, t - last >= heartbeatSeconds {
      lastEmittedAt = t
      return true
    }
    if lastEmittedAt == nil {
      lastEmittedAt = t
      return true
    }
    return false
  }

  public mutating func reset() {
    lastValue = nil
    lastEmittedAt = nil
  }
}

// MARK: - Hysteresis

/// A boolean condition that must hold for `onSeconds` to latch true and for
/// `offSeconds` to latch false. 01 §2 uses the same idea for the COURSE buzz;
/// here it keeps the depth classifier from chattering on the NEAR boundary.
public struct Hysteresis {
  public let onSeconds: Double
  public let offSeconds: Double
  private var state = false
  private var pendingSince: Double?

  public init(onSeconds: Double, offSeconds: Double) {
    self.onSeconds = onSeconds
    self.offSeconds = offSeconds
  }

  public var isOn: Bool { state }

  public mutating func update(condition: Bool, at t: Double) -> Bool {
    if condition == state {
      pendingSince = nil
      return state
    }
    let needed = condition ? onSeconds : offSeconds
    guard let since = pendingSince else {
      pendingSince = t
      return state
    }
    if t - since >= needed {
      state = condition
      pendingSince = nil
    }
    return state
  }

  public mutating func reset() {
    state = false
    pendingSince = nil
  }
}

// MARK: - Smoothing

/// Exponential moving average with a time constant in seconds, so it behaves
/// the same whether samples arrive at 5 Hz or 10 Hz. 09 §5.5 / §5.6 ask for
/// "smoothed over 1 s"; this is that smoother.
public struct ExponentialSmoother {
  public let timeConstantSeconds: Double
  private var value: Double?
  private var lastT: Double?

  public init(timeConstantSeconds: Double) {
    precondition(timeConstantSeconds > 0, "time constant must be positive")
    self.timeConstantSeconds = timeConstantSeconds
  }

  public var current: Double? { value }

  public mutating func update(_ sample: Double, at t: Double) -> Double {
    guard let previous = value, let previousT = lastT, t > previousT else {
      value = sample
      lastT = t
      return sample
    }
    let dt = t - previousT
    let alpha = 1 - exp(-dt / timeConstantSeconds)
    let next = previous + alpha * (sample - previous)
    value = next
    lastT = t
    return next
  }

  public mutating func reset() {
    value = nil
    lastT = nil
  }
}

// MARK: - Angles

/// Angle helpers shared by the signal gate and the drift line. Degrees, always.
public enum Angles {
  /// Wrap to (−180, 180].
  public static func wrapSigned(_ deg: Double) -> Double {
    var d = deg.truncatingRemainder(dividingBy: 360)
    if d > 180 { d -= 360 }
    if d <= -180 { d += 360 }
    return d
  }

  /// Wrap to [0, 360).
  public static func wrapUnsigned(_ deg: Double) -> Double {
    let d = deg.truncatingRemainder(dividingBy: 360)
    return d < 0 ? d + 360 : d
  }

  /// Smallest absolute separation between two bearings, 0…180.
  public static func separation(_ a: Double, _ b: Double) -> Double {
    abs(wrapSigned(a - b))
  }

  public static func toRadians(_ deg: Double) -> Double { deg * .pi / 180 }
  public static func toDegrees(_ rad: Double) -> Double { rad * 180 / .pi }
}

// MARK: - FPS meter

/// Rolling frames-per-second over a 2 s window, for `getStats()`.
public struct FpsMeter {
  private var stamps = TimedSamples<Int>(windowSeconds: 2.0)
  private var counter = 0

  public init() {}

  public mutating func tick(at t: Double) {
    counter += 1
    stamps.push(counter, at: t)
  }

  public func fps(at t: Double) -> Double {
    guard stamps.count >= 2, let oldest = stamps.oldest, let newest = stamps.newest else { return 0 }
    // Drop anything that has aged out of the window entirely.
    if t - newest.t > stamps.windowSeconds { return 0 }
    let span = newest.t - oldest.t
    guard span > 0 else { return 0 }
    return Double(newest.value - oldest.value) / span
  }

  public mutating func reset() {
    stamps.reset()
    counter = 0
  }
}
