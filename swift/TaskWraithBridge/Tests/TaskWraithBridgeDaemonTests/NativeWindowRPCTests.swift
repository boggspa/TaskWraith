import CoreGraphics
import Darwin
import Foundation
import XCTest

@testable import TaskWraithBridgeDaemon

final class NativeWindowRPCTests: XCTestCase {
  func testTargetComesFromExactLeaseMetadata() throws {
    let identity = try XCTUnwrap(ProcessIdentityReceipt.resolve(pid: Int(getpid())))
    let lease = makeLease(
      identity: identity,
      bounds: AttachedWindowBounds(x: 100.25, y: -20.5, width: 640.5, height: 480.25)
    )

    let target = try deriveNativeWindowTarget(from: lease)

    XCTAssertEqual(target.pid, getpid())
    XCTAssertEqual(target.windowID, 99)
    XCTAssertEqual(target.bundleID, "com.example.Target")
    XCTAssertEqual(target.processLaunchTimeMicros, identity.launchTimeMicros)
    XCTAssertEqual(
      target.expectedBounds,
      WindowAccessibilityRect(
        CGRect(x: 100.25, y: -20.5, width: 640.5, height: 480.25)
      )
    )
  }

  func testTargetDerivationRejectsInexactOrIncompleteMetadata() throws {
    let identity = try XCTUnwrap(ProcessIdentityReceipt.resolve(pid: Int(getpid())))
    let inexact = makeLease(identity: identity, identityQuality: .bestEffort)
    let missingIdentity = makeLease(identity: nil)
    let invalidBounds = makeLease(
      identity: identity,
      bounds: AttachedWindowBounds(x: 0, y: 0, width: .infinity, height: 480)
    )

    for lease in [inexact, missingIdentity, invalidBounds] {
      XCTAssertThrowsError(try deriveNativeWindowTarget(from: lease)) { error in
        XCTAssertEqual(
          (error as? JSONRPCError)?.code,
          JSONRPCErrorCode.attachmentDenied
        )
      }
    }
  }

  func testProtectedHostPIDsAreRequiredAndIncludeDaemon() throws {
    let protected = try nativeWindowProtectedPIDs([42, 42])

    XCTAssertEqual(protected, [42, ProcessInfo.processInfo.processIdentifier])
    XCTAssertThrowsError(try nativeWindowProtectedPIDs([]))
    XCTAssertThrowsError(try nativeWindowProtectedPIDs([0]))
  }

  func testObservedElementParamsRequireScopedAccessAndIgnoreCallerTarget() throws {
    let parsed = try decodeNativeWindowParams(
      [
        "handleID": "handle-1",
        "scopeID": "scope-1",
        "chatID": "chat-1",
        "consentEpoch": 4,
        "generation": 7,
        "observationId": "observation-1",
        "inputEpoch": 11,
        "ref": "node-2",
        "target": [
          "pid": 999,
          "windowID": 888,
        ],
      ],
      as: NativeWindowObservedElementParams.self,
      method: "nativeWindow.inspect"
    )

    XCTAssertEqual(parsed.access.handleID, "handle-1")
    XCTAssertEqual(parsed.access.scope.scopeID, "scope-1")
    XCTAssertEqual(parsed.access.scope.chatID, "chat-1")
    XCTAssertEqual(parsed.access.scope.consentEpoch, 4)
    XCTAssertEqual(parsed.access.generation, 7)
    XCTAssertEqual(parsed.observationID, "observation-1")
    XCTAssertEqual(parsed.inputEpoch, 11)
    XCTAssertEqual(parsed.ref, "node-2")

    XCTAssertThrowsError(
      try decodeNativeWindowParams(
        [
          "handleID": "handle-1",
          "observationId": "observation-1",
          "inputEpoch": 11,
          "ref": "node-2",
        ],
        as: NativeWindowObservedElementParams.self,
        method: "nativeWindow.inspect"
      )
    )
  }

  func testObservationResponseUsesCanvasWireNamesAndRelativeBounds() throws {
    let identity = try XCTUnwrap(ProcessIdentityReceipt.resolve(pid: Int(getpid())))
    let target = try deriveNativeWindowTarget(from: makeLease(identity: identity))
    let root = WindowAccessibilityNode(
      ref: "root",
      parentRef: nil,
      childRefs: ["button"],
      role: "AXWindow",
      subrole: nil,
      title: "Example",
      label: nil,
      identifier: nil,
      placeholder: nil,
      value: nil,
      frame: target.expectedBounds,
      enabled: true,
      focused: true,
      secure: false,
      actions: []
    )
    let button = WindowAccessibilityNode(
      ref: "button",
      parentRef: "root",
      childRefs: [],
      role: "AXButton",
      subrole: nil,
      title: nil,
      label: "Submit",
      identifier: "submit",
      placeholder: nil,
      value: nil,
      frame: WindowAccessibilityRect(
        CGRect(x: 112.5, y: 28, width: 80, height: 24)
      ),
      enabled: true,
      focused: false,
      secure: false,
      actions: ["AXPress"]
    )
    let snapshot = WindowAccessibilitySnapshot(
      snapshotID: "snapshot-1",
      target: target,
      createdAt: Date(timeIntervalSince1970: 1_000),
      inputEpoch: 17,
      rootRef: root.ref,
      nodes: [root, button],
      truncated: false
    )
    let observation = WindowAccessibilityObservation(
      observationID: "observation-1",
      inputEpoch: snapshot.inputEpoch,
      snapshot: snapshot,
      actionVerification: WindowAccessibilityPostActionVerification(
        actionID: "action-previous",
        verified: .changed
      )
    )

    let response = try nativeWindowObservationResponse(observation, title: "Fallback")
    let tree = try XCTUnwrap(response["tree"] as? [String: Any])
    let rootJSON = try XCTUnwrap(tree["root"] as? [String: Any])
    let children = try XCTUnwrap(rootJSON["children"] as? [[String: Any]])
    let child = try XCTUnwrap(children.first)
    let bbox = try XCTUnwrap(child["bbox"] as? [Double])
    let verification = try XCTUnwrap(
      response["actionVerification"] as? [String: Any]
    )

    XCTAssertEqual(response["observationId"] as? String, "observation-1")
    XCTAssertNil(response["observationID"])
    XCTAssertEqual(response["inputEpoch"] as? UInt64, 17)
    XCTAssertEqual(tree["nodeCount"] as? Int, 2)
    XCTAssertEqual(tree["title"] as? String, "Example")
    XCTAssertEqual(child["ref"] as? String, "button")
    XCTAssertEqual(child["name"] as? String, "Submit")
    XCTAssertEqual(bbox, [12.5, 48, 80, 24])
    XCTAssertEqual(verification["actionId"] as? String, "action-previous")
    XCTAssertNil(verification["actionID"])
    XCTAssertEqual(verification["verified"] as? String, "changed")
  }

  func testActionResponseAndFailureMappingPreserveSafeExecutionState() throws {
    let attempt = WindowAccessibilityActionAttempt(
      observationID: "observation-1",
      inputEpoch: 3,
      actionID: "action-1",
      result: WindowAccessibilityNativeActionResult(
        ok: false,
        found: true,
        executed: false,
        refusalReason: "user_active",
        message: "User input is active.",
        failureCode: .userActive,
        executionState: .notExecuted
      )
    )

    let response = try nativeWindowActionResponse(attempt)
    XCTAssertEqual(response["observationId"] as? String, "observation-1")
    XCTAssertEqual(response["actionId"] as? String, "action-1")
    XCTAssertNil(response["observationID"])
    XCTAssertNil(response["actionID"])

    let error = mapNativeWindowAccessibilityFailure(
      WindowAccessibilityFailure(
        code: .axFailure,
        message: "AX mutation had an indeterminate outcome.",
        executionState: .unknown,
        details: [
          "operation": "AXPress",
          "secret": "must-not-cross-the-wire",
        ]
      )
    )
    XCTAssertEqual(error.code, JSONRPCErrorCode.bridgeUnavailable)
    XCTAssertEqual(error.data?["kind"], "nativeWindowFailure")
    XCTAssertEqual(error.data?["errorCode"], "ax_failure")
    XCTAssertEqual(error.data?["executionState"], "unknown")
    XCTAssertEqual(error.data?["operation"], "AXPress")
    XCTAssertNil(error.data?["secret"])
  }

  func testCaptureSafetyValidatorRequiresIdenticalPostCaptureReceipt() throws {
    let identity = try XCTUnwrap(ProcessIdentityReceipt.resolve(pid: Int(getpid())))
    let target = try deriveNativeWindowTarget(from: makeLease(identity: identity))
    let before = WindowAccessibilityCaptureSafetyReceipt(
      safe: true,
      target: target,
      checkedAt: Date(timeIntervalSince1970: 1_000),
      nodesExamined: 3,
      inputEpoch: 17,
      validationFingerprint: "before"
    )
    let same = WindowAccessibilityCaptureSafetyReceipt(
      safe: true,
      target: target,
      checkedAt: Date(timeIntervalSince1970: 1_001),
      nodesExamined: 3,
      inputEpoch: 17,
      validationFingerprint: "before"
    )
    let changed = WindowAccessibilityCaptureSafetyReceipt(
      safe: true,
      target: target,
      checkedAt: Date(timeIntervalSince1970: 1_001),
      nodesExamined: 4,
      inputEpoch: 17,
      validationFingerprint: "after"
    )
    let inputChanged = WindowAccessibilityCaptureSafetyReceipt(
      safe: true,
      target: target,
      checkedAt: Date(timeIntervalSince1970: 1_001),
      nodesExamined: 3,
      inputEpoch: 18,
      validationFingerprint: "before"
    )

    XCTAssertEqual(
      try validateNativeWindowCaptureSafety(beforeCapture: before, afterCapture: same),
      same
    )
    XCTAssertThrowsError(
      try validateNativeWindowCaptureSafety(beforeCapture: before, afterCapture: changed)
    ) { error in
      XCTAssertEqual((error as? WindowAccessibilityFailure)?.code, .elementChanged)
    }
    XCTAssertThrowsError(
      try validateNativeWindowCaptureSafety(beforeCapture: before, afterCapture: inputChanged)
    ) { error in
      XCTAssertEqual((error as? WindowAccessibilityFailure)?.code, .staleInputEpoch)
    }

    let encoded = try encodedJSONObjectDictionary(before)
    XCTAssertEqual(encoded["inputEpoch"] as? UInt64, 17)
    XCTAssertNil(encoded["validationFingerprint"])
  }

  func testProcessIdentityDispatcherReturnsOnlyLiveProcBSDReceipt() throws {
    let localDispatcher = JSONRPCDispatcher()
    registerNativeWindowProcessIdentityRPC(on: localDispatcher)
    let expected = try XCTUnwrap(ProcessIdentityReceipt.resolve(pid: Int(getpid())))

    let response = try resultPayload(
      localDispatcher.handleLine(
        """
        {"jsonrpc":"2.0","id":1,"method":"nativeWindow.processIdentity","params":{"pid":\(getpid())}}
        """
      )
    )

    XCTAssertEqual(
      Set(response.keys),
      Set(["pid", "launchTimeMicros", "source", "processStartedAt"])
    )
    XCTAssertEqual(response["pid"] as? Int, Int(getpid()))
    XCTAssertEqual(response["launchTimeMicros"] as? Int64, expected.launchTimeMicros)
    XCTAssertEqual(response["source"] as? String, "procBSDInfo")
    XCTAssertEqual(response["processStartedAt"] as? String, expected.processStartedAt)
  }

  func testProcessIdentityDispatcherFailsClosedForInvalidAndDeadPID() throws {
    let localDispatcher = JSONRPCDispatcher()
    registerNativeWindowProcessIdentityRPC(on: localDispatcher)

    for request in [
      #"{"jsonrpc":"2.0","id":1,"method":"nativeWindow.processIdentity","params":{"pid":0}}"#,
      #"{"jsonrpc":"2.0","id":2,"method":"nativeWindow.processIdentity","params":{"pid":-1}}"#,
      #"{"jsonrpc":"2.0","id":3,"method":"nativeWindow.processIdentity","params":{"pid":"1"}}"#,
      #"{"jsonrpc":"2.0","id":4,"method":"nativeWindow.processIdentity","params":{}}"#,
      #"{"jsonrpc":"2.0","id":5,"method":"nativeWindow.processIdentity","params":{"pid":1,"extra":true}}"#,
    ] {
      let error = try rpcErrorPayload(localDispatcher.handleLine(request))
      XCTAssertEqual(error["code"] as? Int, JSONRPCErrorCode.invalidParams)
    }

    let deadError = try rpcErrorPayload(
      localDispatcher.handleLine(
        #"{"jsonrpc":"2.0","id":6,"method":"nativeWindow.processIdentity","params":{"pid":2147483647}}"#
      )
    )
    XCTAssertEqual(deadError["code"] as? Int, JSONRPCErrorCode.bridgeUnavailable)
    XCTAssertNil(deadError["data"])
  }

  private func makeLease(
    identity: ProcessIdentityReceipt?,
    identityQuality: AttachedWindowIdentityQuality = .exact,
    bounds: AttachedWindowBounds = AttachedWindowBounds(
      x: 100,
      y: -20,
      width: 640,
      height: 480
    )
  ) -> AttachedWindowLease {
    AttachedWindowLease(
      handleID: "handle-1",
      scope: AttachedWindowScope(
        scopeID: "scope-1",
        chatID: "chat-1",
        consentEpoch: 4
      ),
      generation: 7,
      meta: AttachedWindowMeta(
        windowID: 99,
        title: "Example",
        bundleID: "com.example.Target",
        applicationName: "Example",
        pid: Int(getpid()),
        identityQuality: identityQuality,
        processIdentity: identity,
        pgid: ProcessIdentityReceipt.currentProcessGroupID(pid: Int(getpid())),
        bounds: bounds
      ),
      protectedOwners: ResolvedProtectedWindowOwners(processes: [], windowIDs: []),
      filter: nil,
      createdAt: Date(timeIntervalSince1970: 1_000)
    )
  }

  private func resultPayload(_ line: String?) throws -> [String: Any] {
    let line = try XCTUnwrap(line)
    let data = try XCTUnwrap(line.data(using: .utf8))
    let object = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    return try XCTUnwrap(object["result"] as? [String: Any])
  }

  private func rpcErrorPayload(_ line: String?) throws -> [String: Any] {
    let line = try XCTUnwrap(line)
    let data = try XCTUnwrap(line.data(using: .utf8))
    let object = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: data) as? [String: Any]
    )
    return try XCTUnwrap(object["error"] as? [String: Any])
  }
}
