import Testing

@testable import TaskWraithKit
@testable import TaskWraithUI

@Suite("Paired Host and bridge boundary")
struct PairedHostBridgeBoundaryTests {
  @Test("only exact Host v2 frames enter the authoritative replica")
  func hostAuthorityLane() {
    let methods = [
      PairedHostProjectionMethods.welcome,
      PairedHostProjectionMethods.snapshot,
      PairedHostProjectionMethods.deltas,
      PairedHostProjectionMethods.health,
      PairedHostProjectionMethods.state,
    ]
    for method in methods {
      #expect(PairedHostBridgeBoundary.lane(forServerMethod: method) == .hostAuthority)
    }
  }

  @Test("transcript, media, live-output, and compatibility frames stay on the extension lane")
  func bridgeExtensionLane() {
    for method in [
      "bridge.broadcastRemoteProjectionSnapshot",
      "bridge.broadcastRemoteProjection",
      "bridge.runEvent",
      "bridge.broadcastWorkspaceList",
      "bridge.broadcastProviderModels",
    ] {
      #expect(PairedHostBridgeBoundary.lane(forServerMethod: method) == .bridgeExtension)
    }
  }

  @Test("non-bridge application methods fail closed")
  func unsupportedLane() {
    #expect(PairedHostBridgeBoundary.lane(forServerMethod: "host.snapshot") == .unsupported)
    #expect(PairedHostBridgeBoundary.lane(forServerMethod: "") == .unsupported)
  }
}
