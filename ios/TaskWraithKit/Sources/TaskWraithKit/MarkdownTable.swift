import Foundation

public enum MarkdownTableAlignment: String, Equatable, Sendable {
    case leading
    case center
    case trailing
}

public struct MarkdownTable: Equatable, Sendable {
    public let headers: [String]
    public let alignments: [MarkdownTableAlignment]
    public let rows: [[String]]

    public var columnCount: Int { headers.count }

    public init(
        headers: [String],
        alignments: [MarkdownTableAlignment],
        rows: [[String]]
    ) {
        self.headers = headers
        self.alignments = alignments
        self.rows = rows
    }

    public static func parse(lines: [String]) -> MarkdownTable? {
        let normalized = lines
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard normalized.count >= 2 else { return nil }

        let headerCells = splitRowCells(normalized[0])
        let separatorCells = splitRowCells(normalized[1])
        guard headerCells.count >= 2, separatorCells.count >= 2 else { return nil }

        var parsedAlignments: [MarkdownTableAlignment] = []
        parsedAlignments.reserveCapacity(separatorCells.count)
        for cell in separatorCells {
            guard let alignment = parseAlignmentCell(cell) else { return nil }
            parsedAlignments.append(alignment)
        }

        let bodyRows = normalized.dropFirst(2).map { splitRowCells($0) }
        let columnCount = max(
            headerCells.count,
            parsedAlignments.count,
            bodyRows.map(\.count).max() ?? 0
        )
        guard columnCount >= 2 else { return nil }

        return MarkdownTable(
            headers: pad(headerCells, to: columnCount),
            alignments: pad(parsedAlignments, to: columnCount, with: .leading),
            rows: bodyRows.map { pad($0, to: columnCount) }
        )
    }

    public static func isPotentialRow(_ line: String) -> Bool {
        splitRowCells(line).count >= 2
    }

    public static func splitRowCells(_ line: String) -> [String] {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return [] }

        let characters = Array(trimmed)
        var cells: [String] = []
        var current = ""
        var index = characters.first == "|" ? 1 : 0
        var activeCodeFenceLength: Int?

        while index < characters.count {
            let character = characters[index]
            if character == "\\" {
                if index + 1 < characters.count, characters[index + 1] == "|" {
                    current.append(characters[index + 1])
                    index += 2
                } else {
                    current.append(character)
                    index += 1
                }
                continue
            }

            if character == "`" {
                let runLength = backtickRunLength(in: characters, from: index)
                if activeCodeFenceLength == nil {
                    activeCodeFenceLength = runLength
                } else if activeCodeFenceLength == runLength {
                    activeCodeFenceLength = nil
                }
                current.append(String(repeating: "`", count: runLength))
                index += runLength
                continue
            }

            if character == "|" && activeCodeFenceLength == nil {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                index += 1
                continue
            }

            current.append(character)
            index += 1
        }

        cells.append(current.trimmingCharacters(in: .whitespaces))
        if characters.last == "|", cells.last == "" {
            cells.removeLast()
        }
        return cells
    }

    private static func parseAlignmentCell(_ cell: String) -> MarkdownTableAlignment? {
        let trimmed = cell.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }

        let leadingColon = trimmed.first == ":"
        let trailingColon = trimmed.last == ":"
        let dashRangeStart = leadingColon ? trimmed.index(after: trimmed.startIndex) : trimmed.startIndex
        let dashRangeEnd = trailingColon ? trimmed.index(before: trimmed.endIndex) : trimmed.endIndex
        guard dashRangeStart < dashRangeEnd else { return nil }

        let dashes = trimmed[dashRangeStart..<dashRangeEnd]
        guard dashes.count >= 3, dashes.allSatisfy({ $0 == "-" }) else { return nil }

        if leadingColon && trailingColon { return .center }
        if trailingColon { return .trailing }
        return .leading
    }

    private static func backtickRunLength(in characters: [Character], from index: Int) -> Int {
        var count = 0
        var cursor = index
        while cursor < characters.count, characters[cursor] == "`" {
            count += 1
            cursor += 1
        }
        return count
    }

    private static func pad(_ cells: [String], to count: Int) -> [String] {
        guard cells.count < count else { return Array(cells.prefix(count)) }
        return cells + Array(repeating: "", count: count - cells.count)
    }

    private static func pad(
        _ alignments: [MarkdownTableAlignment],
        to count: Int,
        with fallback: MarkdownTableAlignment
    ) -> [MarkdownTableAlignment] {
        guard alignments.count < count else { return Array(alignments.prefix(count)) }
        return alignments + Array(repeating: fallback, count: count - alignments.count)
    }
}
