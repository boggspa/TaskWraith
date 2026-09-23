import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Relay transport recovery")
struct RelayTransportRecoveryTests {
    private func makeClient() throws -> RelayTransportClient {
        try RelayTransportClient(identitySeed: Data(repeating: 7, count: 32))
    }

    @Test("a dropped socket releases establishment waiters immediately")
    func dropReleasesEstablishmentWaiter() async throws {
        let client = try makeClient()
        let wait = Task { try await client.waitForEstablished(timeoutMs: 5_000) }
        for _ in 0..<100 {
            if await client.establishedWaiterCount > 0 { break }
            await Task.yield()
        }
        #expect(await client.establishedWaiterCount == 1)

        await client.dropConnection()
        do {
            try await wait.value
            Issue.record("a dropped socket completed establishment")
        } catch TransportError.hostUnavailable {
            // The next relay door can be tried without waiting out this dial's budget.
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(await client.establishedWaiterCount == 0)
    }

    @Test("cancelling one establishment wait does not cancel another")
    func cancellationIsPerWaiter() async throws {
        let client = try makeClient()
        let first = Task { try await client.waitForEstablished(timeoutMs: 5_000) }
        let second = Task { try await client.waitForEstablished(timeoutMs: 5_000) }
        for _ in 0..<100 {
            if await client.establishedWaiterCount == 2 { break }
            await Task.yield()
        }
        #expect(await client.establishedWaiterCount == 2)

        first.cancel()
        do {
            try await first.value
            Issue.record("cancelled establishment wait completed")
        } catch is CancellationError {
            // Expected.
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(await client.establishedWaiterCount == 1)
        await client.close()
        _ = await second.result
    }

    @Test("authentication failures release the dial with their original cause")
    func authenticationFailureReleasesWaiter() async throws {
        let client = try makeClient()
        let wait = Task { try await client.waitForEstablished(timeoutMs: 5_000) }
        for _ in 0..<100 {
            if await client.establishedWaiterCount > 0 { break }
            await Task.yield()
        }
        #expect(await client.establishedWaiterCount == 1)

        await client.reportSessionError(E2eeSession.SessionError.macIdentityMismatch)
        do {
            try await wait.value
            Issue.record("an authentication failure completed establishment")
        } catch E2eeSession.SessionError.macIdentityMismatch {
            // The candidate walk sees the precise pairing error, not a timeout.
        } catch {
            Issue.record("unexpected error: \(error)")
        }
        #expect(await client.establishedWaiterCount == 0)

        // Receiving the error before the dial begins waiting is equivalent.
        do {
            try await client.waitForEstablished(timeoutMs: 5_000)
            Issue.record("a failed handshake allowed a new establishment wait")
        } catch E2eeSession.SessionError.macIdentityMismatch {
            // Expected.
        } catch {
            Issue.record("unexpected error: \(error)")
        }

        await client.dropConnection()
        let retry = Task { try await client.waitForEstablished(timeoutMs: 5_000) }
        for _ in 0..<100 {
            if await client.establishedWaiterCount > 0 { break }
            await Task.yield()
        }
        #expect(await client.establishedWaiterCount == 1)
        await client.close()
        _ = await retry.result
    }

    @Test("a late frame from a replaced socket cannot advance the new connection")
    func staleSocketFrameIsIgnored() async throws {
        let client = try makeClient()
        let staleTask = URLSession.shared.webSocketTask(
            with: URL(string: "wss://reconnect.invalid/v1/session/stale")!)
        // No task is resumed and no network operation occurs. This directly
        // simulates a receive() completion after its socket was retired.
        let before = await client.receivedFrameCount
        await client.processReceivedMessage(.string("{}"), from: staleTask)
        #expect(await client.receivedFrameCount == before)
        staleTask.cancel(with: .goingAway, reason: nil)
    }
}
