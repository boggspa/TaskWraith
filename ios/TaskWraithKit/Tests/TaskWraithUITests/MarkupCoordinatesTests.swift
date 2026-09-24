import Foundation
import TaskWraithKit
import Testing

@Suite("Full-size media assembler")
struct FullSizeMediaAssemblerTests {

    @Test("a complete bounded download finishes with the exact bytes")
    func completeDownload() throws {
        var assembler = FullSizeMediaAssembler()
        let first = Data(repeating: 1, count: 100)
        let second = Data(repeating: 2, count: 50)
        try assembler.append(chunk: first, totalBytes: 150)
        #expect(assembler.needsMore)
        try assembler.append(chunk: second, totalBytes: 150)
        #expect(assembler.isComplete)
        let finished = try assembler.finish()
        #expect(finished.count == 150)
        #expect(finished.prefix(100).allSatisfy { $0 == 1 })
        #expect(finished.suffix(50).allSatisfy { $0 == 2 })
    }

    @Test("an empty first chunk is a failure, not a completed image")
    func emptyChunkIsFailure() {
        var assembler = FullSizeMediaAssembler()
        #expect(throws: FullSizeMediaFetchError.truncated(received: 0, expected: 40)) {
            try assembler.append(chunk: Data(), totalBytes: 40)
        }
        #expect(throws: FullSizeMediaFetchError.empty) {
            _ = try assembler.finish()
        }
    }

    @Test("an empty chunk before the declared total is truncated, not success")
    func emptyMidStreamIsTruncated() throws {
        var assembler = FullSizeMediaAssembler()
        try assembler.append(chunk: Data(repeating: 7, count: 10), totalBytes: 40)
        #expect(throws: FullSizeMediaFetchError.truncated(received: 10, expected: 40)) {
            try assembler.append(chunk: Data(), totalBytes: 40)
        }
        #expect(throws: FullSizeMediaFetchError.truncated(received: 10, expected: 40)) {
            _ = try assembler.finish()
        }
    }

    @Test("finishing before any chunk is empty, not success")
    func finishWithoutChunksIsEmpty() {
        let assembler = FullSizeMediaAssembler()
        #expect(throws: FullSizeMediaFetchError.empty) {
            _ = try assembler.finish()
        }
    }

    @Test("partial assembly without a terminal empty chunk is truncated")
    func partialFinishIsTruncated() throws {
        var assembler = FullSizeMediaAssembler()
        try assembler.append(chunk: Data(repeating: 3, count: 8), totalBytes: 20)
        #expect(assembler.needsMore)
        #expect(throws: FullSizeMediaFetchError.truncated(received: 8, expected: 20)) {
            _ = try assembler.finish()
        }
    }

    @Test("declared total above the maximum is rejected before allocation")
    func declaredTotalAboveMaximum() {
        var assembler = FullSizeMediaAssembler()
        let tooBig = FullSizeMediaAssembler.maxBytes + 1
        #expect(
            throws: FullSizeMediaFetchError.exceedsMaximum(
                received: tooBig, maximum: FullSizeMediaAssembler.maxBytes)
        ) {
            try assembler.append(chunk: Data([1]), totalBytes: tooBig)
        }
    }

    @Test("zero or negative total is invalid")
    func invalidTotals() {
        var assembler = FullSizeMediaAssembler()
        #expect(throws: FullSizeMediaFetchError.invalidTotal(0)) {
            try assembler.append(chunk: Data([1]), totalBytes: 0)
        }
        #expect(throws: FullSizeMediaFetchError.invalidTotal(-4)) {
            try assembler.append(chunk: Data([1]), totalBytes: -4)
        }
    }

    @Test("a later chunk that disagrees on totalBytes is inconsistent")
    func inconsistentTotals() throws {
        var assembler = FullSizeMediaAssembler()
        try assembler.append(chunk: Data(repeating: 1, count: 4), totalBytes: 10)
        #expect(throws: FullSizeMediaFetchError.inconsistentTotal(previous: 10, next: 12)) {
            try assembler.append(chunk: Data(repeating: 1, count: 4), totalBytes: 12)
        }
    }

    @Test("bytes past the declared total are inconsistent")
    func overflowDeclaredTotal() throws {
        var assembler = FullSizeMediaAssembler()
        try assembler.append(chunk: Data(repeating: 1, count: 6), totalBytes: 10)
        #expect(throws: FullSizeMediaFetchError.inconsistentTotal(previous: 10, next: 12)) {
            try assembler.append(chunk: Data(repeating: 1, count: 6), totalBytes: 10)
        }
    }
}

@Suite("MarkupCoordinates")
struct MarkupCoordinatesTests {

    @Test("programmatic init clamps to 0...1")
    func coordinateNormalization() {
        let clamped = NormalizedCoordinate(x: -0.5, y: 1.5)
        #expect(clamped.x == 0.0)
        #expect(clamped.y == 1.0)
        let mid = NormalizedCoordinate(x: 0.5, y: 0.5)
        #expect(mid.x == 0.5)
        #expect(mid.y == 0.5)
    }

    @Test("Codable decoding uses the clamping init, not synthesized stored properties")
    func decodingClampsOutOfRangeCoordinates() throws {
        let data = Data(#"{"x":1.5,"y":-0.2}"#.utf8)
        let decoded = try JSONDecoder().decode(NormalizedCoordinate.self, from: data)
        #expect(decoded.x == 1.0)
        #expect(decoded.y == 0.0)
    }

    @Test("non-finite coordinates are rejected on decode")
    func decodingRejectsNonFiniteCoordinates() throws {
        struct Box: Codable {
            let x: Double
            let y: Double
        }
        let encoder = JSONEncoder()
        encoder.nonConformingFloatEncodingStrategy = .convertToString(
            positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
        let decoder = JSONDecoder()
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(
            positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
        let nanData = try encoder.encode(Box(x: .nan, y: 0.2))
        #expect(throws: DecodingError.self) {
            _ = try decoder.decode(NormalizedCoordinate.self, from: nanData)
        }
    }

    @Test("color components are clamped on init and decode")
    func colorClamping() throws {
        let color = MarkupColor(r: 2, g: -1, b: 0.5, a: 3)
        #expect(color.r == 1)
        #expect(color.g == 0)
        #expect(color.b == 0.5)
        #expect(color.a == 1)
        let decoded = try JSONDecoder().decode(
            MarkupColor.self, from: Data(#"{"r":2,"g":-1,"b":0.5,"a":3}"#.utf8))
        #expect(decoded == color)
    }

    @Test("thickness outside (0.25, 64] is rejected on decode")
    func thicknessValidation() {
        let tooThin = Data(
            #"{"type":"arrow","start":{"x":0,"y":0},"end":{"x":1,"y":1},"color":{"r":1,"g":0,"b":0,"a":1},"thickness":0}"#
                .utf8)
        let tooThick = Data(
            #"{"type":"arrow","start":{"x":0,"y":0},"end":{"x":1,"y":1},"color":{"r":1,"g":0,"b":0,"a":1},"thickness":65}"#
                .utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPrimitive.self, from: tooThin)
        }
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPrimitive.self, from: tooThick)
        }
    }

    @Test("a stroke with no points is rejected")
    func emptyStrokeRejected() {
        let data = Data(
            #"{"type":"stroke","points":[],"color":{"r":1,"g":0,"b":0,"a":1},"thickness":2}"#
                .utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPrimitive.self, from: data)
        }
    }

    @Test("unknown primitive types fail closed")
    func unknownPrimitiveRejected() {
        let data = Data(
            #"{"type":"ellipse","start":{"x":0,"y":0},"end":{"x":1,"y":1},"color":{"r":1,"g":0,"b":0,"a":1},"thickness":2}"#
                .utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPrimitive.self, from: data)
        }
    }

    @Test("payload requires attachment id and schema version")
    func payloadRequiresIdentityAndVersion() throws {
        #expect(throws: MarkupValidationError.emptyAttachmentId) {
            _ = try MarkupPayload(attachmentId: "  ", primitives: [])
        }
        #expect(throws: MarkupValidationError.unsupportedSchemaVersion(2)) {
            _ = try MarkupPayload(attachmentId: "media-1", primitives: [], schemaVersion: 2)
        }
        let missingFields = Data(#"{"primitives":[]}"#.utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPayload.self, from: missingFields)
        }
        let badVersion = Data(
            #"{"schemaVersion":99,"attachmentId":"media-1","primitives":[]}"#.utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPayload.self, from: badVersion)
        }
        let emptyId = Data(
            #"{"schemaVersion":1,"attachmentId":"","primitives":[]}"#.utf8)
        #expect(throws: DecodingError.self) {
            _ = try JSONDecoder().decode(MarkupPayload.self, from: emptyId)
        }
    }

    @Test("payload round-trips primitives with identity and schema version")
    func primitiveSerialization() throws {
        let primitives: [MarkupPrimitive] = [
            .stroke(
                points: [
                    NormalizedCoordinate(x: 0.1, y: 0.1),
                    NormalizedCoordinate(x: 0.9, y: 0.9),
                ], color: .red, thickness: 2.0),
            .rect(
                start: NormalizedCoordinate(x: 0.2, y: 0.2),
                end: NormalizedCoordinate(x: 0.8, y: 0.8),
                color: .blue,
                thickness: 1.0),
            .arrow(
                start: NormalizedCoordinate(x: 0.5, y: 0.1),
                end: NormalizedCoordinate(x: 0.5, y: 0.9),
                color: .green,
                thickness: 3.0),
        ]
        let payload = try MarkupPayload(attachmentId: "media-row-7", primitives: primitives)
        let data = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(MarkupPayload.self, from: data)
        #expect(decoded.schemaVersion == MarkupPayload.currentSchemaVersion)
        #expect(decoded.attachmentId == "media-row-7")
        #expect(decoded.primitives.count == 3)

        if case .stroke(let points, let color, let thickness) = decoded.primitives[0] {
            #expect(points.count == 2)
            #expect(color == .red)
            #expect(thickness == 2.0)
        } else {
            Issue.record("Expected stroke")
        }
        if case .rect(let start, let end, let color, let thickness) = decoded.primitives[1] {
            #expect(start.x == 0.2)
            #expect(end.y == 0.8)
            #expect(color == .blue)
            #expect(thickness == 1.0)
        } else {
            Issue.record("Expected rect")
        }
        if case .arrow(let start, let end, let color, let thickness) = decoded.primitives[2] {
            #expect(start.x == 0.5)
            #expect(end.y == 0.9)
            #expect(color == .green)
            #expect(thickness == 3.0)
        } else {
            Issue.record("Expected arrow")
        }
    }

    @Test("decoded payload coordinates remain inside 0...1")
    func payloadDecodeClampsNestedCoordinates() throws {
        let json = Data(
            #"{"schemaVersion":1,"attachmentId":"shot-1","primitives":[{"type":"arrow","start":{"x":-2,"y":0.2},"end":{"x":4,"y":1.7},"color":{"r":1,"g":0,"b":0,"a":1},"thickness":2}]}"#
                .utf8)
        let decoded = try JSONDecoder().decode(MarkupPayload.self, from: json)
        guard case .arrow(let start, let end, _, _) = decoded.primitives[0] else {
            Issue.record("Expected arrow")
            return
        }
        #expect(start.x == 0)
        #expect(start.y == 0.2)
        #expect(end.x == 1)
        #expect(end.y == 1)
    }
}
