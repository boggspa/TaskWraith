import XCTest

@testable import TaskWraithBridgeDaemon

/// These run against the test process's own real ancestry, so they exercise
/// proc_bsdinfo rather than a stub. The shape of that chain (swift-testing ->
/// swiftpm -> shell -> ...) is not asserted; only its structural invariants are.
final class ProcessAncestryTests: XCTestCase {
    private var selfPid: Int { Int(getpid()) }

    func testChainToSelfIsASingleLink() throws {
        let links = try XCTUnwrap(
            ProcessAncestry.chain(from: selfPid, to: selfPid, maxDepth: 4)
        )
        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links[0].receipt.pid, selfPid)
        XCTAssertGreaterThan(links[0].receipt.launchTimeMicros, 0)
    }

    func testChainToRealParentJoinsUpAndOrdersBirths() throws {
        let parentPid = try XCTUnwrap(ProcessIdentityReceipt.parentPid(of: selfPid))
        try XCTSkipIf(parentPid <= 1, "The test process was re-parented to launchd.")

        let links = try XCTUnwrap(
            ProcessAncestry.chain(from: selfPid, to: parentPid, maxDepth: 4)
        )
        XCTAssertEqual(links.count, 2)
        XCTAssertEqual(links[0].receipt.pid, selfPid)
        XCTAssertEqual(links[1].receipt.pid, parentPid)
        // The link Electron re-checks: each entry names the next one as parent.
        XCTAssertEqual(links[0].parentPid, links[1].receipt.pid)
        // A parent cannot be born after its child; this is what makes a
        // recycled PID unusable as a forged link.
        XCTAssertLessThanOrEqual(links[1].receipt.launchTimeMicros, links[0].receipt.launchTimeMicros)
    }

    func testLaunchdIsNeverAValidAncestryRoot() {
        // Every process descends from launchd, so accepting it as a root would
        // make the proof meaningless.
        XCTAssertNil(ProcessAncestry.chain(from: selfPid, to: 1, maxDepth: 16))
    }

    func testUnrelatedAncestorIsRefusedRatherThanApproximated() {
        // A PID that is not on this process's parent path yields no chain, even
        // when it is a live process.
        XCTAssertNil(ProcessAncestry.chain(from: selfPid, to: selfPid + 1_000_000, maxDepth: 8))
    }

    func testDepthCapStopsTheWalk() {
        XCTAssertNil(ProcessAncestry.chain(from: selfPid, to: selfPid, maxDepth: 0))
        XCTAssertNil(
            ProcessAncestry.chain(
                from: selfPid,
                to: selfPid,
                maxDepth: ProcessAncestry.maximumDepth + 1
            )
        )
    }

    func testResponseCarriesOnlyTheChainThatWasAskedFor() throws {
        let response = try nativeWindowProcessAncestryResponse(
            pid: selfPid,
            ancestorPid: selfPid,
            maxDepth: 2
        )
        XCTAssertEqual(Array(response.keys), ["chain"])
        let chain = try XCTUnwrap(response["chain"] as? [[String: Any]])
        XCTAssertEqual(chain.count, 1)
        XCTAssertEqual(
            Set(chain[0].keys),
            ["pid", "ppid", "launchTimeMicros", "source", "processStartedAt"]
        )
        XCTAssertEqual(chain[0]["source"] as? String, "procBSDInfo")
        let micros = try XCTUnwrap(chain[0]["launchTimeMicros"] as? Int64)
        XCTAssertEqual(chain[0]["processStartedAt"] as? String, "procBSDInfo:\(micros)")
    }

    func testResponseRejectsInvalidParameters() {
        for (pid, ancestorPid, maxDepth) in [
            (0, selfPid, 4),
            (selfPid, 0, 4),
            (selfPid, selfPid, 0),
            (selfPid, selfPid, ProcessAncestry.maximumDepth + 1)
        ] {
            XCTAssertThrowsError(
                try nativeWindowProcessAncestryResponse(
                    pid: pid,
                    ancestorPid: ancestorPid,
                    maxDepth: maxDepth
                )
            ) { error in
                XCTAssertEqual((error as? JSONRPCError)?.code, JSONRPCErrorCode.invalidParams)
            }
        }
    }

    func testResponseRefusesAnUnrelatedProcess() {
        XCTAssertThrowsError(
            try nativeWindowProcessAncestryResponse(
                pid: selfPid,
                ancestorPid: selfPid + 1_000_000,
                maxDepth: 8
            )
        ) { error in
            XCTAssertEqual((error as? JSONRPCError)?.code, JSONRPCErrorCode.bridgeUnavailable)
        }
    }
}
