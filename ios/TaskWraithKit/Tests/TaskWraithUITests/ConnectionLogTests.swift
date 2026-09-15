import Foundation
import Testing

@testable import TaskWraithUI

@Suite("Connection log")
struct ConnectionLogTests {
    @Test("the ring keeps only the newest entries")
    func ringEvictsOldest() {
        var log = ConnectionLog(capacity: 3)
        for i in 0..<5 { log.append("k\(i)") }
        #expect(log.entries.map(\.kind) == ["k2", "k3", "k4"])
        #expect(log.entries.map(\.id) == [2, 3, 4], "ids stay monotonic across eviction")
    }

    @Test("export is one line per entry, oldest first, with a millisecond stamp")
    func exportFormat() {
        var log = ConnectionLog()
        let t0 = Date(timeIntervalSince1970: 1_757_900_000.123)
        log.append("wake", "foreground phase=connected → probeHealth", at: t0)
        log.append("established", at: t0.addingTimeInterval(1.5))
        let lines = log.exportText().split(separator: "\n").map(String.init)
        #expect(lines.count == 2)
        #expect(lines[0].hasSuffix(" wake foreground phase=connected → probeHealth"))
        #expect(lines[1].hasSuffix(" established"), "an empty detail adds no trailing space")
        #expect(lines[0].prefix(12).filter { $0 == ":" }.count == 2)
        #expect(lines[0].prefix(12).hasSuffix(".123"))
    }

    @Test("clear empties the ring")
    func clearEmpties() {
        var log = ConnectionLog()
        log.append("x")
        log.clear()
        #expect(log.entries.isEmpty)
        #expect(log.exportText().isEmpty)
    }
}
