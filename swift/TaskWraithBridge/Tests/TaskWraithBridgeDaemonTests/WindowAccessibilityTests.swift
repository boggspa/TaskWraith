import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import XCTest

@testable import TaskWraithBridgeDaemon

final class WindowAccessibilityTests: XCTestCase {
  func testSystemBackendUsesCanonicalProcBSDStartMicros() {
    let pid = Int32(getpid())
    var info = proc_bsdinfo()
    let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    let written = proc_pidinfo(
      pid_t(pid),
      PROC_PIDTBSDINFO,
      0,
      &info,
      expectedSize
    )
    XCTAssertEqual(written, expectedSize)
    let expected =
      Int64(info.pbi_start_tvsec) * 1_000_000
      + Int64(info.pbi_start_tvusec)

    XCTAssertEqual(
      SystemWindowAccessibilityBackend.processStartTimeMicros(pid: pid),
      expected
    )
    XCTAssertNil(SystemWindowAccessibilityBackend.processStartTimeMicros(pid: -1))
  }

  func testPermissionStatusDoesNotPromptAndUserPromptRequiresRecheck() {
    let harness = Harness()
    harness.backend.trusted = false

    let status = harness.adapter.status()
    let requested = harness.adapter.requestUserPrompt()

    XCTAssertEqual(
      status,
      WindowAccessibilityPermissionState(
        trusted: false,
        promptRequested: false,
        recheckRequired: false
      )
    )
    XCTAssertEqual(
      requested,
      WindowAccessibilityPermissionState(
        trusted: false,
        promptRequested: true,
        recheckRequired: true
      )
    )
    XCTAssertEqual(harness.backend.promptChecks, [false, true])
  }

  func testDriverSurfaceAdoptsObservesInspectsActsVerifiesAndReleases() throws {
    let harness = Harness()
    _ = harness.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    _ = harness.addNode(
      id: "field",
      role: kAXTextFieldRole as String,
      identifier: "search",
      value: "",
      settable: [kAXValueAttribute as String]
    )

    let adoption = try harness.adapter.adopt(target: harness.target)
    XCTAssertEqual(adoption.target, harness.target)
    XCTAssertEqual(adoption.viewport, WindowAccessibilityRect(harness.bounds))

    let observation = try harness.adapter.observe(target: harness.target)
    XCTAssertEqual(observation.inputEpoch, 42)
    XCTAssertNil(observation.actionVerification)
    let ref = try XCTUnwrap(
      observation.snapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    let inspection = try harness.adapter.inspect(
      target: harness.target,
      observationID: observation.observationID,
      inputEpoch: observation.inputEpoch,
      ref: ref
    )
    XCTAssertEqual(inspection.node.identifier, "submit")

    let attempt = try harness.adapter.click(
      target: harness.target,
      observationID: observation.observationID,
      inputEpoch: observation.inputEpoch,
      ref: ref
    )
    XCTAssertFalse(attempt.actionID.isEmpty)
    XCTAssertTrue(attempt.result.ok)
    XCTAssertTrue(attempt.result.executed)

    let after = try harness.adapter.observe(target: harness.target)
    XCTAssertEqual(after.actionVerification?.actionID, attempt.actionID)
    XCTAssertEqual(after.actionVerification?.verified, .unchanged)
    let fieldRef = try XCTUnwrap(
      after.snapshot.nodes.first(where: { $0.identifier == "search" })?.ref
    )
    let fill = try harness.adapter.fill(
      target: harness.target,
      observationID: after.observationID,
      inputEpoch: after.inputEpoch,
      ref: fieldRef,
      value: "query"
    )
    XCTAssertTrue(fill.result.executed)
    let afterFill = try harness.adapter.observe(target: harness.target)
    XCTAssertEqual(afterFill.actionVerification?.actionID, fill.actionID)
    XCTAssertEqual(afterFill.actionVerification?.verified, .changed)

    var captureExecutions = 0
    let capture = try performNativeWindowCapture(
      adapter: harness.adapter,
      target: harness.target,
      captureExecutor: {
        captureExecutions += 1
        return CapturedWindowFrame(pngData: Data([0x89]), width: 1, height: 1)
      },
      revalidateLease: {}
    )
    XCTAssertEqual(captureExecutions, 1)
    XCTAssertTrue(capture.safety.safe)
    XCTAssertEqual(capture.safety.inputEpoch, afterFill.inputEpoch)
    XCTAssertEqual(capture.frame.pngData, Data([0x89]))

    XCTAssertTrue(harness.adapter.release(target: harness.target).released)
  }

  func testDriverSurfaceReturnsStaleInputRefusalAndVerifiesNextObservation() throws {
    let harness = Harness()
    _ = harness.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let observation = try harness.adapter.observe(target: harness.target)
    let ref = try XCTUnwrap(
      observation.snapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    harness.backend.inputEpoch = observation.inputEpoch + 1

    let attempt = try harness.adapter.click(
      target: harness.target,
      observationID: observation.observationID,
      inputEpoch: observation.inputEpoch,
      ref: ref
    )

    XCTAssertFalse(attempt.result.executed)
    XCTAssertEqual(attempt.result.refusalReason, "stale_input_epoch")
    let next = try harness.adapter.observe(target: harness.target)
    XCTAssertEqual(next.actionVerification?.actionID, attempt.actionID)
    XCTAssertEqual(next.actionVerification?.verified, .unchanged)
  }

  func testSnapshotAndQueryAreBoundedToTheExactWindowAndRedactSecureValues() throws {
    let harness = Harness()
    let ordinary = harness.addNode(
      id: "ordinary",
      role: kAXTextFieldRole as String,
      identifier: "search",
      value: "visible"
    )
    let secure = harness.addNode(
      id: "secure",
      role: kAXTextFieldRole as String,
      subrole: kAXSecureTextFieldSubrole as String,
      identifier: "password",
      value: "must-not-be-read"
    )

    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let result = try harness.adapter.query(
      target: harness.target,
      query: WindowAccessibilityQuery(identifier: "search")
    )

    XCTAssertEqual(snapshot.nodes.count, 3)
    XCTAssertEqual(snapshot.nodes.first(where: { $0.identifier == "search" })?.value, "visible")
    XCTAssertNil(snapshot.nodes.first(where: { $0.identifier == "password" })?.value)
    XCTAssertFalse(harness.backend.displayValueReads.contains(secure.id))
    XCTAssertTrue(harness.backend.displayValueReads.contains(ordinary.id))
    XCTAssertEqual(result.matches.map(\.identifier), ["search"])
    XCTAssertEqual(result.target, harness.target)
  }

  func testCaptureSafetyConservativelyRefusesAnySecureFieldWithoutReadingIt() {
    let harness = Harness()
    let secure = harness.addNode(
      id: "secure",
      role: kAXTextFieldRole as String,
      subrole: kAXSecureTextFieldSubrole as String,
      identifier: "password",
      value: "must-not-be-read"
    )

    let failure = captureFailure {
      try harness.adapter.requireCaptureSafe(target: harness.target)
    }

    XCTAssertEqual(failure?.code, .secureField)
    XCTAssertEqual(failure?.executionState, .notExecuted)
    XCTAssertFalse(harness.backend.displayValueReads.contains(secure.id))
  }

  func testCaptureSafetyFailsClosedWhenPermissionOrTraversalIsIndeterminate() {
    let untrusted = Harness()
    untrusted.backend.trusted = false
    XCTAssertEqual(
      captureFailure {
        try untrusted.adapter.requireCaptureSafe(target: untrusted.target)
      }?.code,
      .accessibilityPermissionMissing
    )

    var configuration = WindowAccessibilityConfiguration()
    configuration.maxNodes = 1
    let truncated = Harness(configuration: configuration)
    _ = truncated.addNode(id: "child", role: kAXButtonRole as String)
    XCTAssertEqual(
      captureFailure {
        try truncated.adapter.requireCaptureSafe(target: truncated.target)
      }?.code,
      .secureFieldStatusUnknown
    )
  }

  func testCaptureRefusesUntilThePostActionObservationCompletes() throws {
    let harness = Harness()
    _ = harness.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let observation = try harness.adapter.observe(target: harness.target)
    let ref = try XCTUnwrap(
      observation.snapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    _ = try harness.adapter.click(
      target: harness.target,
      observationID: observation.observationID,
      inputEpoch: observation.inputEpoch,
      ref: ref
    )

    var captureExecutions = 0
    let failure = captureFailure {
      try performNativeWindowCapture(
        adapter: harness.adapter,
        target: harness.target,
        captureExecutor: {
          captureExecutions += 1
          return CapturedWindowFrame(pngData: Data([0x01]), width: 1, height: 1)
        },
        revalidateLease: {}
      )
    }

    XCTAssertEqual(failure?.code, .invalidRequest)
    XCTAssertEqual(captureExecutions, 0)
  }

  func testNativeCaptureDiscardsFrameWhenPostCaptureSafetyChanges() {
    let harness = Harness()
    var captureExecutions = 0

    let failure = captureFailure {
      try performNativeWindowCapture(
        adapter: harness.adapter,
        target: harness.target,
        captureExecutor: {
          captureExecutions += 1
          _ = harness.addNode(
            id: "secure-after-capture",
            role: kAXTextFieldRole as String,
            subrole: kAXSecureTextFieldSubrole as String,
            identifier: "password"
          )
          return CapturedWindowFrame(pngData: Data([0x02]), width: 1, height: 1)
        },
        revalidateLease: {}
      )
    }

    XCTAssertEqual(failure?.code, .secureField)
    XCTAssertEqual(captureExecutions, 1)
  }

  func testNativeCaptureDiscardsFrameWhenPhysicalInputEpochChanges() {
    let harness = Harness()
    var captureExecutions = 0

    let failure = captureFailure {
      try performNativeWindowCapture(
        adapter: harness.adapter,
        target: harness.target,
        captureExecutor: {
          captureExecutions += 1
          harness.backend.inputEpoch = 43
          return CapturedWindowFrame(pngData: Data([0x03]), width: 1, height: 1)
        },
        revalidateLease: {}
      )
    }

    XCTAssertEqual(failure?.code, .staleInputEpoch)
    XCTAssertEqual(captureExecutions, 1)
  }

  func testOutOfWindowDescendantFailsBeforeValueReadForSnapshotAndCapture() {
    let snapshotHarness = Harness()
    let snapshotForeign = snapshotHarness.addOutOfWindowChild(
      id: "foreign-snapshot",
      role: kAXTextFieldRole as String,
      value: "must-not-be-read"
    )
    XCTAssertEqual(
      captureFailure {
        try snapshotHarness.adapter.snapshot(target: snapshotHarness.target)
      }?.code,
      .elementOutsideWindow
    )
    XCTAssertFalse(snapshotHarness.backend.displayValueReads.contains(snapshotForeign.id))

    let captureHarness = Harness()
    let captureForeign = captureHarness.addOutOfWindowChild(
      id: "foreign-capture",
      role: kAXTextFieldRole as String,
      value: "must-not-be-read"
    )
    XCTAssertEqual(
      captureFailure {
        try captureHarness.adapter.capture(target: captureHarness.target)
      }?.code,
      .elementOutsideWindow
    )
    XCTAssertFalse(captureHarness.backend.displayValueReads.contains(captureForeign.id))
  }

  func testCyclesAndNodeBoundsCannotPublishDanglingSnapshotReferences() throws {
    let cycleHarness = Harness()
    cycleHarness.backend.windows[0].children.append(cycleHarness.backend.windows[0])
    let cycleSnapshot = try cycleHarness.adapter.snapshot(target: cycleHarness.target)
    XCTAssertTrue(cycleSnapshot.truncated)
    XCTAssertTrue(cycleSnapshot.nodes.allSatisfy { node in
      node.childRefs.allSatisfy { childRef in
        cycleSnapshot.nodes.contains(where: { $0.ref == childRef })
      }
    })
    XCTAssertEqual(
      captureFailure {
        try cycleHarness.adapter.capture(target: cycleHarness.target)
      }?.code,
      .secureFieldStatusUnknown
    )

    var configuration = WindowAccessibilityConfiguration()
    configuration.maxNodes = 1
    let boundedHarness = Harness(configuration: configuration)
    _ = boundedHarness.addNode(id: "child", role: kAXButtonRole as String)
    let boundedObservation = try boundedHarness.adapter.observe(target: boundedHarness.target)
    let tree = try nativeWindowCanvasTree(
      observation: boundedObservation,
      fallbackTitle: "Target"
    )
    let root = try XCTUnwrap(tree["root"] as? [String: Any])
    XCTAssertNil(root["children"])
    XCTAssertEqual(tree["nodeCount"] as? Int, 1)
  }

  func testCustomEditableLocalizedFieldIsRedactedAndRefusesCaptureAndActions() throws {
    let harness = Harness()
    let custom = harness.addNode(
      id: "localized-custom",
      role: "AXCustomEditable",
      identifier: "recherche",
      value: "ne-pas-lire",
      actions: [kAXPressAction as String],
      settable: [kAXValueAttribute as String]
    )
    custom.strings[kAXDescriptionAttribute as String] = "mot de passe"
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "recherche" })?.ref
    )
    let node = try XCTUnwrap(snapshot.nodes.first(where: { $0.ref == ref }) )

    XCTAssertTrue(node.secure)
    XCTAssertNil(node.value)
    XCTAssertFalse(harness.backend.displayValueReads.contains(custom.id))
    XCTAssertEqual(
      captureFailure {
        try harness.adapter.capture(target: harness.target)
      }?.code,
      .secureFieldStatusUnknown
    )
    XCTAssertEqual(
      captureFailure {
        try harness.adapter.press(
          target: harness.target,
          snapshotID: snapshot.snapshotID,
          ref: ref
        )
      }?.code,
      .secureFieldStatusUnknown
    )
    XCTAssertEqual(
      captureFailure {
        try harness.adapter.fill(
          target: harness.target,
          snapshotID: snapshot.snapshotID,
          ref: ref,
          value: "nope"
        )
      }?.code,
      .secureFieldStatusUnknown
    )
    XCTAssertTrue(harness.backend.performedActions.isEmpty)
    XCTAssertTrue(harness.backend.setValues.isEmpty)

    var captureExecutions = 0
    _ = captureFailure {
      try performNativeWindowCapture(
        adapter: harness.adapter,
        target: harness.target,
        captureExecutor: {
          captureExecutions += 1
          return CapturedWindowFrame(pngData: Data([0x04]), width: 1, height: 1)
        },
        revalidateLease: {}
      )
    }
    XCTAssertEqual(captureExecutions, 0)
  }

  func testStandardLocalizedTextFieldRemainsUsableWithoutEnglishSafetyCopy() throws {
    let harness = Harness()
    let field = harness.addNode(
      id: "localized-standard",
      role: kAXTextFieldRole as String,
      identifier: "recherche",
      value: "bonjour",
      settable: [kAXValueAttribute as String]
    )
    field.strings[kAXDescriptionAttribute as String] = "recherche"
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "recherche" })?.ref
    )

    XCTAssertFalse(snapshot.nodes.first(where: { $0.ref == ref })?.secure ?? true)
    let receipt = try harness.adapter.fill(
      target: harness.target,
      snapshotID: snapshot.snapshotID,
      ref: ref,
      value: "salut"
    )
    XCTAssertTrue(receipt.executed)
    XCTAssertEqual(field.displayValue, "salut")
  }

  func testCustomEditableEnglishSearchLabelIsNotTreatedAsProofOfSafety() throws {
    let harness = Harness()
    let custom = harness.addNode(
      id: "custom-search",
      role: "AXCustomEditable",
      identifier: "search",
      value: "must-not-read",
      actions: [kAXPressAction as String],
      settable: [kAXValueAttribute as String]
    )
    custom.strings[kAXDescriptionAttribute as String] = "Search"
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "search" })?.ref
    )

    XCTAssertTrue(snapshot.nodes.first(where: { $0.ref == ref })?.secure ?? false)
    XCTAssertNil(snapshot.nodes.first(where: { $0.ref == ref })?.value)
    XCTAssertEqual(
      captureFailure {
        try harness.adapter.press(
          target: harness.target,
          snapshotID: snapshot.snapshotID,
          ref: ref
        )
      }?.code,
      .secureFieldStatusUnknown
    )
    XCTAssertFalse(harness.backend.displayValueReads.contains(custom.id))
    XCTAssertTrue(harness.backend.performedActions.isEmpty)
  }

  func testSystemPhysicalInputCoverageIncludesPointerDragAndTabletEvents() {
    let eventTypes = SystemWindowAccessibilityBackend.physicalEventTypes
    for eventType in [
      CGEventType.mouseMoved,
      .leftMouseDragged,
      .rightMouseDragged,
      .otherMouseDragged,
      .tabletPointer,
      .tabletProximity,
    ] {
      XCTAssertTrue(eventTypes.contains(eventType))
    }
    XCTAssertEqual(SystemWindowAccessibilityBackend.anyInputEventType.rawValue, UInt32.max)
  }

  func testPressRefusesRecentPhysicalInputThenUsesAXPressWhenIdle() throws {
    let harness = Harness()
    let button = harness.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )

    harness.backend.physicalInputIdle = 0.25
    let refusal = captureFailure {
      try harness.adapter.press(
        target: harness.target,
        snapshotID: snapshot.snapshotID,
        ref: ref
      )
    }
    XCTAssertEqual(refusal?.code, .userActive)
    XCTAssertEqual(refusal?.executionState, .notExecuted)
    XCTAssertTrue(harness.backend.performedActions.isEmpty)

    harness.backend.physicalInputIdle = 10
    let receipt = try harness.adapter.press(
      target: harness.target,
      snapshotID: snapshot.snapshotID,
      ref: ref
    )
    XCTAssertTrue(receipt.executed)
    XCTAssertEqual(receipt.verification, .unconfirmed)
    XCTAssertEqual(harness.backend.performedActions, ["\(button.id):AXPress"])
  }

  func testActuationFailsClosedWhenPhysicalPresenceCannotBeRead() throws {
    let harness = Harness()
    _ = harness.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    harness.backend.physicalInputIdle = nil

    let failure = captureFailure {
      try harness.adapter.press(
        target: harness.target,
        snapshotID: snapshot.snapshotID,
        ref: ref
      )
    }

    XCTAssertEqual(failure?.code, .userPresenceUnavailable)
    XCTAssertTrue(harness.backend.performedActions.isEmpty)
  }

  func testFillUsesSettableAXValueAndSecureFillNeverReadsOrWritesValue() throws {
    let harness = Harness()
    let ordinary = harness.addNode(
      id: "ordinary",
      role: kAXTextFieldRole as String,
      identifier: "search",
      value: "",
      settable: [kAXValueAttribute as String]
    )
    let secure = harness.addNode(
      id: "secure",
      role: kAXTextFieldRole as String,
      subrole: kAXSecureTextFieldSubrole as String,
      identifier: "password",
      value: "must-not-be-read",
      settable: [kAXValueAttribute as String]
    )
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ordinaryRef = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "search" })?.ref
    )
    let secureRef = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "password" })?.ref
    )

    let receipt = try harness.adapter.fill(
      target: harness.target,
      snapshotID: snapshot.snapshotID,
      ref: ordinaryRef,
      value: "query"
    )
    XCTAssertEqual(receipt.verification, .confirmed)
    XCTAssertEqual(ordinary.displayValue, "query")

    harness.backend.displayValueReads.removeAll()
    let refusal = captureFailure {
      try harness.adapter.fill(
        target: harness.target,
        snapshotID: snapshot.snapshotID,
        ref: secureRef,
        value: "do-not-write"
      )
    }
    XCTAssertEqual(refusal?.code, .secureField)
    XCTAssertEqual(secure.displayValue, "must-not-be-read")
    XCTAssertFalse(harness.backend.displayValueReads.contains(secure.id))
    XCTAssertEqual(harness.backend.setValues.map(\.nodeID), [ordinary.id])
  }

  func testSecureElementCannotPressEvenWhenAXPressIsAdvertised() throws {
    let harness = Harness()
    _ = harness.addNode(
      id: "secure-press",
      role: kAXTextFieldRole as String,
      subrole: kAXSecureTextFieldSubrole as String,
      identifier: "password",
      actions: [kAXPressAction as String]
    )
    let snapshot = try harness.adapter.snapshot(target: harness.target)
    let ref = try XCTUnwrap(
      snapshot.nodes.first(where: { $0.identifier == "password" })?.ref
    )

    XCTAssertEqual(
      captureFailure {
        try harness.adapter.press(
          target: harness.target,
          snapshotID: snapshot.snapshotID,
          ref: ref
        )
      }?.code,
      .secureField
    )
    let click = try harness.adapter.click(
      target: harness.target,
      observationID: snapshot.snapshotID,
      inputEpoch: snapshot.inputEpoch,
      ref: ref
    )
    XCTAssertFalse(click.result.executed)
    XCTAssertEqual(click.result.refusalReason, "secret_field")
    XCTAssertTrue(harness.backend.performedActions.isEmpty)
  }

  func testExactProcessIdentityProtectedHostAndGeometryAmbiguityFailClosed() {
    let recycled = Harness()
    recycled.backend.process = WindowAccessibilityProcessRecord(
      pid: recycled.target.pid,
      bundleID: recycled.target.bundleID,
      launchTimeMicros: recycled.target.processLaunchTimeMicros + 1,
      isActive: true,
      isTerminated: false
    )
    XCTAssertEqual(
      captureFailure {
        try recycled.adapter.snapshot(target: recycled.target)
      }?.code,
      .processIdentityMismatch
    )

    var configuration = WindowAccessibilityConfiguration()
    configuration.protectedHostPIDs = [444]
    let protected = Harness(configuration: configuration)
    XCTAssertEqual(
      captureFailure {
        try protected.adapter.snapshot(target: protected.target)
      }?.code,
      .selfTargetRefused
    )

    let ambiguous = Harness()
    ambiguous.backend.windows.append(
      FakeAXNode(
        id: "second-window",
        pid: ambiguous.target.pid,
        role: kAXWindowRole as String,
        frame: ambiguous.bounds
      )
    )
    XCTAssertEqual(
      captureFailure {
        try ambiguous.adapter.snapshot(target: ambiguous.target)
      }?.code,
      .ambiguousWindow
    )
  }

  func testChangedElementAndMutationBoundaryFailureHaveHonestExecutionStates() throws {
    let changed = Harness()
    let changedButton = changed.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let changedSnapshot = try changed.adapter.snapshot(target: changed.target)
    let changedRef = try XCTUnwrap(
      changedSnapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    changedButton.strings[kAXTitleAttribute as String] = "new title"
    let changedFailure = captureFailure {
      try changed.adapter.press(
        target: changed.target,
        snapshotID: changedSnapshot.snapshotID,
        ref: changedRef
      )
    }
    XCTAssertEqual(changedFailure?.code, .elementChanged)
    XCTAssertEqual(changedFailure?.executionState, .notExecuted)

    let uncertain = Harness()
    _ = uncertain.addNode(
      id: "button",
      role: kAXButtonRole as String,
      identifier: "submit",
      actions: [kAXPressAction as String]
    )
    let uncertainSnapshot = try uncertain.adapter.snapshot(target: uncertain.target)
    let uncertainRef = try XCTUnwrap(
      uncertainSnapshot.nodes.first(where: { $0.identifier == "submit" })?.ref
    )
    uncertain.backend.performError = WindowAccessibilityBackendError(
      operation: "AXUIElementPerformAction(AXPress)",
      code: -25204
    )
    let uncertainFailure = captureFailure {
      try uncertain.adapter.press(
        target: uncertain.target,
        snapshotID: uncertainSnapshot.snapshotID,
        ref: uncertainRef
      )
    }
    XCTAssertEqual(uncertainFailure?.code, .axFailure)
    XCTAssertEqual(uncertainFailure?.executionState, .unknown)
  }
}

private func captureFailure<T>(_ body: () throws -> T) -> WindowAccessibilityFailure? {
  do {
    _ = try body()
    XCTFail("Expected WindowAccessibilityFailure")
    return nil
  } catch let failure as WindowAccessibilityFailure {
    return failure
  } catch {
    XCTFail("Unexpected error: \(error)")
    return nil
  }
}

private final class Harness {
  let backend: FakeWindowAccessibilityBackend
  let adapter: WindowAccessibilityAdapter
  let target: WindowAccessibilityTargetIdentity
  let bounds = CGRect(x: 40, y: 80, width: 900, height: 700)
  private var foreignWindows: [FakeAXNode] = []

  init(configuration: WindowAccessibilityConfiguration = WindowAccessibilityConfiguration()) {
    let pid: Int32 = 444
    let launchTimeMicros: Int64 = 1_721_234_567_890_123
    let application = FakeAXNode(
      id: "application",
      pid: pid,
      role: kAXApplicationRole as String
    )
    let window = FakeAXNode(
      id: "window",
      pid: pid,
      role: kAXWindowRole as String,
      frame: bounds
    )
    backend = FakeWindowAccessibilityBackend(
      process: WindowAccessibilityProcessRecord(
        pid: pid,
        bundleID: "com.example.Target",
        launchTimeMicros: launchTimeMicros,
        isActive: true,
        isTerminated: false
      ),
      windowRecord: WindowAccessibilityWindowRecord(
        windowID: 77,
        ownerPID: pid,
        title: "Target",
        bounds: bounds,
        isOnscreen: true
      ),
      application: application,
      windows: [window],
      focusedWindow: window
    )
    target = WindowAccessibilityTargetIdentity(
      pid: pid,
      windowID: 77,
      bundleID: "com.example.Target",
      processLaunchTimeMicros: launchTimeMicros,
      expectedBounds: WindowAccessibilityRect(bounds)
    )
    adapter = WindowAccessibilityAdapter(
      backend: backend,
      configuration: configuration,
      now: { Date(timeIntervalSince1970: 2_000_000_000) },
      uuid: { UUID() }
    )
  }

  @discardableResult
  func addNode(
    id: String,
    role: String,
    subrole: String? = nil,
    identifier: String? = nil,
    value: String? = nil,
    actions: [String] = [],
    settable: Set<String> = []
  ) -> FakeAXNode {
    let node = FakeAXNode(
      id: id,
      pid: target.pid,
      role: role,
      subrole: subrole,
      identifier: identifier,
      displayValue: value,
      frame: CGRect(x: 60, y: 120, width: 240, height: 30),
      actions: actions,
      settable: settable
    )
    node.window = backend.windows[0]
    backend.windows[0].children.append(node)
    return node
  }

  @discardableResult
  func addOutOfWindowChild(
    id: String,
    role: String,
    value: String? = nil
  ) -> FakeAXNode {
    let foreignWindow = FakeAXNode(
      id: "foreign-window-\(id)",
      pid: target.pid,
      role: kAXWindowRole as String,
      frame: CGRect(x: 1_200, y: 80, width: 500, height: 400)
    )
    let node = FakeAXNode(
      id: id,
      pid: target.pid,
      role: role,
      displayValue: value,
      frame: CGRect(x: 1_220, y: 100, width: 240, height: 30)
    )
    foreignWindows.append(foreignWindow)
    node.window = foreignWindow
    backend.windows[0].children.append(node)
    return node
  }
}

private final class FakeAXNode: NSObject {
  let id: String
  let pid: Int32
  var strings: [String: String]
  var bools: [String: Bool]
  var displayValue: String?
  var point: CGPoint?
  var size: CGSize?
  var children: [FakeAXNode]
  weak var window: FakeAXNode?
  var actions: [String]
  var settable: Set<String>

  init(
    id: String,
    pid: Int32,
    role: String,
    subrole: String? = nil,
    identifier: String? = nil,
    displayValue: String? = nil,
    frame: CGRect? = nil,
    actions: [String] = [],
    settable: Set<String> = [],
    children: [FakeAXNode] = []
  ) {
    self.id = id
    self.pid = pid
    strings = [kAXRoleAttribute as String: role]
    if let subrole {
      strings[kAXSubroleAttribute as String] = subrole
    }
    if let identifier {
      strings[kAXIdentifierAttribute as String] = identifier
    }
    bools = [
      kAXEnabledAttribute as String: true,
      kAXFocusedAttribute as String: false,
      kAXMinimizedAttribute as String: false,
    ]
    self.displayValue = displayValue
    point = frame?.origin
    size = frame?.size
    self.actions = actions
    self.settable = settable
    self.children = children
  }
}

private final class FakeWindowAccessibilityBackend: WindowAccessibilityBackend {
  struct SetValue: Equatable {
    let nodeID: String
    let attribute: String
    let value: String
  }

  var trusted = true
  var physicalInputIdle: TimeInterval? = 10
  var inputEpoch: UInt64? = 42
  var process: WindowAccessibilityProcessRecord
  var windowRecordValue: WindowAccessibilityWindowRecord
  let application: FakeAXNode
  var windows: [FakeAXNode]
  var focusedWindow: FakeAXNode?
  var promptChecks: [Bool] = []
  var displayValueReads: [String] = []
  var performedActions: [String] = []
  var setValues: [SetValue] = []
  var performError: Error?

  init(
    process: WindowAccessibilityProcessRecord,
    windowRecord: WindowAccessibilityWindowRecord,
    application: FakeAXNode,
    windows: [FakeAXNode],
    focusedWindow: FakeAXNode?
  ) {
    self.process = process
    windowRecordValue = windowRecord
    self.application = application
    self.windows = windows
    self.focusedWindow = focusedWindow
  }

  func isProcessTrusted(prompt: Bool) -> Bool {
    promptChecks.append(prompt)
    return trusted
  }

  func secondsSincePhysicalInput() -> TimeInterval? {
    physicalInputIdle
  }

  func physicalInputEpoch() -> UInt64? {
    inputEpoch
  }

  func processRecord(pid: Int32) -> WindowAccessibilityProcessRecord? {
    pid == process.pid ? process : nil
  }

  func windowRecord(windowID: UInt32) -> WindowAccessibilityWindowRecord? {
    windowID == windowRecordValue.windowID ? windowRecordValue : nil
  }

  func applicationElement(pid: Int32) throws -> WindowAccessibilityElement {
    guard pid == application.pid else {
      throw WindowAccessibilityBackendError(operation: "applicationElement", code: -1)
    }
    return wrap(application)
  }

  func pid(of element: WindowAccessibilityElement) throws -> Int32 {
    node(element).pid
  }

  func stringAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> String? {
    node(element).strings[name]
  }

  func displayValueAttribute(of element: WindowAccessibilityElement) throws -> String? {
    let valueNode = node(element)
    displayValueReads.append(valueNode.id)
    return valueNode.displayValue
  }

  func boolAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> Bool? {
    node(element).bools[name]
  }

  func numberAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> Int64? {
    nil
  }

  func pointAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> CGPoint? {
    name == (kAXPositionAttribute as String) ? node(element).point : nil
  }

  func sizeAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> CGSize? {
    name == (kAXSizeAttribute as String) ? node(element).size : nil
  }

  func elementAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> WindowAccessibilityElement? {
    let source = node(element)
    if name == (kAXFocusedWindowAttribute as String), source === application {
      return focusedWindow.map(wrap)
    }
    if name == (kAXWindowAttribute as String) {
      return source.window.map(wrap)
    }
    return nil
  }

  func elementArrayAttribute(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> [WindowAccessibilityElement] {
    let source = node(element)
    if name == (kAXWindowsAttribute as String), source === application {
      return windows.map(wrap)
    }
    if name == (kAXChildrenAttribute as String) {
      return source.children.map(wrap)
    }
    return []
  }

  func actionNames(of element: WindowAccessibilityElement) throws -> [String] {
    node(element).actions
  }

  func isAttributeSettable(
    _ name: String,
    of element: WindowAccessibilityElement
  ) throws -> Bool {
    node(element).settable.contains(name)
  }

  func performAction(_ name: String, on element: WindowAccessibilityElement) throws {
    if let performError {
      throw performError
    }
    performedActions.append("\(node(element).id):\(name)")
  }

  func setStringAttribute(
    _ name: String,
    value: String,
    on element: WindowAccessibilityElement
  ) throws {
    let valueNode = node(element)
    valueNode.displayValue = value
    setValues.append(SetValue(nodeID: valueNode.id, attribute: name, value: value))
  }

  func elementsEqual(
    _ lhs: WindowAccessibilityElement,
    _ rhs: WindowAccessibilityElement
  ) -> Bool {
    lhs.rawValue === rhs.rawValue
  }

  private func node(_ element: WindowAccessibilityElement) -> FakeAXNode {
    element.rawValue as! FakeAXNode
  }

  private func wrap(_ node: FakeAXNode) -> WindowAccessibilityElement {
    WindowAccessibilityElement(node)
  }
}
