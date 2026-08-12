// The paired E2EE session carries two deliberately different application
// lanes. Host v2 owns compact lifecycle state, governed commands, and durable
// receipts. The existing bridge remains the extension/resource lane for full
// transcript bodies, media, live output, native mobile features, and backwards
// compatible projections that HostSnapshot intentionally does not contain.

import Foundation
import TaskWraithKit

enum PairedHostBridgeLane: Equatable {
  case hostAuthority
  case bridgeExtension
  case unsupported
}

enum PairedHostBridgeBoundary {
  private static let hostAuthorityMethods: Set<String> = [
    PairedHostProjectionMethods.welcome,
    PairedHostProjectionMethods.snapshot,
    PairedHostProjectionMethods.deltas,
    PairedHostProjectionMethods.health,
    PairedHostProjectionMethods.state,
  ]

  static func lane(forServerMethod method: String) -> PairedHostBridgeLane {
    if hostAuthorityMethods.contains(method) { return .hostAuthority }
    if method.hasPrefix("bridge.") { return .bridgeExtension }
    return .unsupported
  }
}
