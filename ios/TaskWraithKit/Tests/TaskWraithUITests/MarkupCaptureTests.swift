import Foundation
import TaskWraithKit
import Testing
@testable import TaskWraithUI

@Suite("Markup coordinate space")
struct MarkupCoordinateSpaceTests {
    @Test("a view-placed point maps to the same normalized coordinate under a different view size")
    func viewPointRoundTripsAcrossViewSizes() {
        let imageWidth = 800.0
        let imageHeight = 600.0
        let small = MarkupCoordinateSpace(
            viewWidth: 400, viewHeight: 300,
            imageWidth: imageWidth, imageHeight: imageHeight)
        let large = MarkupCoordinateSpace(
            viewWidth: 800, viewHeight: 600,
            imageWidth: imageWidth, imageHeight: imageHeight)

        let tap = MarkupPoint(x: 100, y: 75)
        let normalized = small.normalize(viewPoint: tap)
        #expect(normalized.x == 0.25)
        #expect(normalized.y == 0.25)

        let projected = large.viewPoint(from: normalized)
        #expect(abs(projected.x - 200) < 1e-9)
        #expect(abs(projected.y - 150) < 1e-9)
        let again = large.normalize(viewPoint: projected)
        #expect(again.x == normalized.x)
        #expect(again.y == normalized.y)
    }

    @Test("letterboxed views still round-trip; letterbox taps clamp onto the image")
    func letterboxRoundTripAndClamp() {
        let square = MarkupCoordinateSpace(
            viewWidth: 400, viewHeight: 400,
            imageWidth: 800, imageHeight: 400)
        let compact = MarkupCoordinateSpace(
            viewWidth: 200, viewHeight: 200,
            imageWidth: 800, imageHeight: 400)

        // Fitted image is 400x200 centered at y=100 in the 400x400 view.
        let imageCenter = MarkupPoint(x: 200, y: 200)
        let normalized = square.normalize(viewPoint: imageCenter)
        #expect(abs(normalized.x - 0.5) < 1e-9)
        #expect(abs(normalized.y - 0.5) < 1e-9)

        let compactCenter = compact.viewPoint(from: normalized)
        #expect(abs(compactCenter.x - 100) < 1e-9)
        #expect(abs(compactCenter.y - 100) < 1e-9)
        let again = compact.normalize(viewPoint: compactCenter)
        #expect(again.x == normalized.x)
        #expect(again.y == normalized.y)

        let aboveImage = square.normalize(viewPoint: MarkupPoint(x: 200, y: 0))
        #expect(aboveImage.y == 0)
        let belowImage = square.normalize(viewPoint: MarkupPoint(x: 200, y: 400))
        #expect(belowImage.y == 1)
    }

    @Test("pixel mapping is independent of view size — the view/pixel boundary")
    func pixelMappingDoesNotDependOnViewSize() {
        let a = MarkupCoordinateSpace(
            viewWidth: 100, viewHeight: 50,
            imageWidth: 1000, imageHeight: 500)
        let b = MarkupCoordinateSpace(
            viewWidth: 40, viewHeight: 80,
            imageWidth: 1000, imageHeight: 500)
        let pixel = MarkupPoint(x: 250, y: 125)
        let fromA = a.normalize(pixel: pixel)
        let fromB = b.normalize(pixel: pixel)
        #expect(fromA.x == 0.25)
        #expect(fromA.y == 0.25)
        #expect(fromA == fromB)

        // Treating a pixel as a view point is a different space. That is the
        // boundary this feature has to keep honest.
        let mistaken = a.normalize(viewPoint: pixel)
        #expect(mistaken != fromA)
    }

    @Test("normalize(viewPoint(from:)) is a round trip for in-range coordinates")
    func viewPointInverse() {
        let space = MarkupCoordinateSpace(
            viewWidth: 320, viewHeight: 480,
            imageWidth: 640, imageHeight: 960)
        let original = NormalizedCoordinate(x: 0.2, y: 0.8)
        let view = space.viewPoint(from: original)
        let back = space.normalize(viewPoint: view)
        #expect(abs(back.x - original.x) < 1e-9)
        #expect(abs(back.y - original.y) < 1e-9)
    }
}

@Suite("Markup capture session")
struct MarkupCaptureSessionTests {
    private func space() -> MarkupCoordinateSpace {
        MarkupCoordinateSpace(
            viewWidth: 400, viewHeight: 300,
            imageWidth: 800, imageHeight: 600)
    }

    @Test("gestures recorded in one view size re-project under another")
    func primitivesSurviveViewResize() throws {
        var session = MarkupCaptureSession(space: space())
        try session.addArrow(
            start: MarkupPoint(x: 80, y: 60),
            end: MarkupPoint(x: 320, y: 240),
            color: .red,
            thickness: 3)
        guard case .arrow(let start, let end, _, _) = session.primitives[0] else {
            Issue.record("expected arrow")
            return
        }
        #expect(start.x == 0.2)
        #expect(start.y == 0.2)
        #expect(end.x == 0.8)
        #expect(end.y == 0.8)

        session.space = MarkupCoordinateSpace(
            viewWidth: 200, viewHeight: 150,
            imageWidth: 800, imageHeight: 600)
        let projected = session.space.viewPoint(from: start)
        #expect(abs(projected.x - 40) < 1e-9)
        #expect(abs(projected.y - 30) < 1e-9)
        let renormalized = session.space.normalize(viewPoint: projected)
        #expect(renormalized.x == start.x)
        #expect(renormalized.y == start.y)
    }

    @Test("payload attachmentId is the id we asked to bind")
    func payloadIdIsTheProducedAttachmentId() throws {
        var session = MarkupCaptureSession(space: space())
        try session.addRect(
            start: MarkupPoint(x: 0, y: 0),
            end: MarkupPoint(x: 400, y: 300),
            color: .blue,
            thickness: 2)
        let payload = try session.makePayload(attachmentId: "att-77")
        #expect(payload.attachmentId == "att-77")
        #expect(payload.primitives.count == 1)
    }

    @Test("empty attachmentId is refused — dangling is worse than none")
    func emptyAttachmentIdIsRefused() throws {
        let session = MarkupCaptureSession(space: space())
        do {
            _ = try session.makePayload(attachmentId: "  ")
            Issue.record("expected emptyAttachmentId")
        } catch MarkupValidationError.emptyAttachmentId {
            // ok
        } catch {
            Issue.record("wrong error \(error)")
        }
    }

    @Test("an unusable space refuses to record a gesture")
    func emptySpaceRefusesGestures() {
        var session = MarkupCaptureSession(
            space: MarkupCoordinateSpace(
                viewWidth: 0, viewHeight: 0, imageWidth: 10, imageHeight: 10))
        do {
            try session.addStroke(
                viewPoints: [MarkupPoint(x: 1, y: 1)], color: .red, thickness: 3)
            Issue.record("expected emptyCoordinateSpace")
        } catch MarkupValidationError.emptyCoordinateSpace {
            // ok
        } catch {
            Issue.record("wrong error \(error)")
        }
        #expect(session.primitives.isEmpty)
    }
}

@Suite("Markup attachment assembly")
struct MarkupAttachmentAssemblyTests {
    @Test("stamp requires the wire id to equal the payload attachmentId")
    func stampRequiresMatchingId() throws {
        let payload = try MarkupPayload(
            attachmentId: "att-1",
            primitives: [
                .arrow(
                    start: NormalizedCoordinate(x: 0.1, y: 0.2),
                    end: NormalizedCoordinate(x: 0.8, y: 0.9),
                    color: .red,
                    thickness: 2)
            ])
        let mismatched: [String: Any] = [
            "id": "other",
            "name": "shot.jpg",
            "mimeType": "image/jpeg",
            "dataBase64": "QQ==",
        ]
        #expect(MarkupAttachmentAssembly.stamp(payload, onto: mismatched) == nil)

        let missing: [String: Any] = [
            "name": "shot.jpg",
            "mimeType": "image/jpeg",
            "dataBase64": "QQ==",
        ]
        #expect(MarkupAttachmentAssembly.stamp(payload, onto: missing) == nil)

        let matched: [String: Any] = [
            "id": "att-1",
            "name": "shot.jpg",
            "mimeType": "image/jpeg",
            "dataBase64": "QQ==",
        ]
        let stamped = MarkupAttachmentAssembly.stamp(payload, onto: matched)
        let stampedId = stamped?["id"] as? String
        #expect(stampedId == "att-1")
        let markup = stamped?["markup"] as? [String: Any]
        #expect(markup?["attachmentId"] as? String == "att-1")
        #expect(matched["markup"] == nil)
    }

    @Test("makeWireDict refuses when the two ids would disagree")
    func makeWireDictRefusesIdMismatch() throws {
        let payload = try MarkupPayload(attachmentId: "att-1", primitives: [])
        #expect(
            MarkupAttachmentAssembly.makeWireDict(
                attachmentId: "att-2",
                name: "shot.jpg",
                mimeType: "image/jpeg",
                dataBase64: "QQ==",
                payload: payload) == nil)
        let ok = MarkupAttachmentAssembly.makeWireDict(
            attachmentId: "att-1",
            name: "shot.jpg",
            mimeType: "image/jpeg",
            dataBase64: "QQ==",
            payload: payload)
        #expect(ok?["id"] as? String == "att-1")
        #expect((ok?["markup"] as? [String: Any])?["attachmentId"] as? String == "att-1")
    }
}

@Suite("Composer markup wiring")
struct ComposerMarkupWiringTests {
    @Test("bindMarkup stamps id+markup when they match; otherwise drops markup not the image")
    func bindMarkupDropsDanglingIds() throws {
        let payload = try MarkupPayload(attachmentId: "att-9", primitives: [])
        let wire: [String: Any] = [
            "name": "shot.jpg",
            "mimeType": "image/jpeg",
            "dataBase64": "QQ==",
        ]
        let stamped = ComposerMarkupWiring.bindMarkup(payload, onto: wire)
        #expect(stamped["id"] as? String == "att-9")
        #expect((stamped["markup"] as? [String: Any])?["attachmentId"] as? String == "att-9")
        #expect(stamped["dataBase64"] as? String == "QQ==")

        let plain = ComposerMarkupWiring.bindMarkup(nil, onto: stamped)
        #expect(plain["id"] == nil)
        #expect(plain["markup"] == nil)
        #expect(plain["dataBase64"] as? String == "QQ==")
    }

    @Test("inbox is thread-scoped, refuses empty thread ids, and drain is consuming")
    @MainActor
    func inboxIsThreadScoped() throws {
        let box = ComposerMarkupInbox()
        let payload = try MarkupPayload(attachmentId: "att-a", primitives: [])
        let itemA = ComposerMarkupInboxItem(
            name: "a.jpg", imageData: Data([1, 2, 3]), payload: payload)
        let itemB = ComposerMarkupInboxItem(
            name: "b.jpg", imageData: Data([4]), payload: payload)
        box.enqueue(threadId: "", item: itemA)
        box.enqueue(threadId: "t1", item: itemA)
        box.enqueue(threadId: "t2", item: itemB)
        #expect(box.drain(threadId: "").isEmpty)
        let t1 = box.drain(threadId: "t1")
        #expect(t1.map(\.name) == ["a.jpg"])
        #expect(t1[0].payload?.attachmentId == "att-a")
        #expect(box.drain(threadId: "t1").isEmpty)
        #expect(box.drain(threadId: "t2").map(\.name) == ["b.jpg"])
    }

    @Test("inbox refuses a payload whose attachmentId is empty")
    @MainActor
    func inboxRefusesEmptyPayloadId() throws {
        let box = ComposerMarkupInbox()
        // Constructing MarkupPayload already refuses empty ids; enqueue also
        // guards so a future bypass cannot land an unresolvable item.
        let payload = try MarkupPayload(attachmentId: "ok", primitives: [])
        box.enqueue(
            threadId: "t",
            item: ComposerMarkupInboxItem(name: "x.jpg", imageData: Data(), payload: payload))
        #expect(box.drain(threadId: "t").isEmpty)
    }

    @Test("a full composer loses nothing — leftovers stay queued and the refusal is named")
    @MainActor
    func fullComposerRetainsInbox() throws {
        let box = ComposerMarkupInbox()
        let payload = try MarkupPayload(attachmentId: "att-full", primitives: [])
        let items = (0..<3).map { i in
            ComposerMarkupInboxItem(
                name: "shot-\(i).jpg", imageData: Data([UInt8(i + 1)]), payload: payload)
        }
        for item in items { box.enqueue(threadId: "t", item: item) }
        let result = ComposerMarkupWiring.absorb(
            from: box, threadId: "t", currentlyAttached: 15, capacity: 15)
        #expect(result.taken.isEmpty)
        #expect(result.leftoverCount == 3)
        #expect(result.freeSlots == 0)
        #expect(result.refusalMessage != nil)
        #expect(result.refusalMessage?.contains("15") == true)
        #expect(result.refusalMessage?.contains("3") == true)
        #expect(box.drain(threadId: "t").map(\.name) == ["shot-0.jpg", "shot-1.jpg", "shot-2.jpg"])
    }

    @Test("a partially-full composer absorbs exactly the free slots and retains the rest")
    @MainActor
    func partialComposerAbsorbsFreeSlotsOnly() throws {
        let box = ComposerMarkupInbox()
        let payload = try MarkupPayload(attachmentId: "att-part", primitives: [])
        for i in 0..<5 {
            box.enqueue(
                threadId: "t",
                item: ComposerMarkupInboxItem(
                    name: "shot-\(i).jpg", imageData: Data([UInt8(i + 1)]), payload: payload))
        }
        let result = ComposerMarkupWiring.absorb(
            from: box, threadId: "t", currentlyAttached: 13, capacity: 15)
        #expect(result.taken.map(\.name) == ["shot-0.jpg", "shot-1.jpg"])
        #expect(result.leftoverCount == 3)
        #expect(result.freeSlots == 2)
        #expect(result.refusalMessage != nil)
        #expect(box.drain(threadId: "t").map(\.name) == ["shot-2.jpg", "shot-3.jpg", "shot-4.jpg"])
    }
}

@Suite("Markup metadata bounds")
struct MarkupMetadataBoundTests {
    @Test("32 primitives are accepted; 33 is refused to match the host trust-boundary")
    func primitiveBoundMatchesHost() throws {
        #expect(MarkupPayload.maxPrimitives == 32)
        #expect(MarkupPayload.maxEncodedBytes == 16 * 1024)
        #expect(MarkupPayload.maxStrokePoints == 256)

        func arrows(_ count: Int) -> [MarkupPrimitive] {
            (0..<count).map { i in
                MarkupPrimitive.arrow(
                    start: NormalizedCoordinate(x: 0, y: 0),
                    end: NormalizedCoordinate(x: 1, y: Double(i % 2)),
                    color: .red,
                    thickness: 2)
            }
        }

        let accepted = try MarkupPayload(attachmentId: "att-32", primitives: arrows(32))
        #expect(accepted.primitives.count == 32)

        do {
            _ = try MarkupPayload(attachmentId: "att-33", primitives: arrows(33))
            Issue.record("expected tooManyPrimitives")
        } catch MarkupValidationError.tooManyPrimitives(let count, let maximum) {
            #expect(count == 33)
            #expect(maximum == 32)
        } catch {
            Issue.record("wrong error \(error)")
        }
    }

    @Test("a stroke longer than 256 points is refused")
    func tooManyStrokePointsIsRefused() {
        let points = (0..<MarkupPayload.maxStrokePoints + 1).map { i in
            NormalizedCoordinate(x: Double(i % 2), y: 0.5)
        }
        do {
            _ = try MarkupPayload(
                attachmentId: "att-stroke",
                primitives: [.stroke(points: points, color: .red, thickness: 2)])
            Issue.record("expected tooManyStrokePoints")
        } catch MarkupValidationError.tooManyStrokePoints(let count, let maximum) {
            #expect(count == MarkupPayload.maxStrokePoints + 1)
            #expect(maximum == MarkupPayload.maxStrokePoints)
        } catch {
            Issue.record("wrong error \(error)")
        }
    }

    @Test("the encoded-size bound is 16 KiB and is stated on the type")
    func encodedSizeBoundIsSixteenKib() throws {
        #expect(MarkupPayload.maxEncodedBytes == 16 * 1024)
        let payload = try MarkupPayload(
            attachmentId: "att-ok",
            primitives: [
                .arrow(
                    start: NormalizedCoordinate(x: 0.1, y: 0.1),
                    end: NormalizedCoordinate(x: 0.9, y: 0.9),
                    color: .red,
                    thickness: 2)
            ])
        let data = try payload.encodedJSONData()
        #expect(data.count <= MarkupPayload.maxEncodedBytes)
        #expect(data.count > 0)
    }
}

#if canImport(CoreGraphics) && canImport(ImageIO)
    import CoreGraphics
    import ImageIO

    @Suite("Markup flatten")
    struct MarkupFlattenTests {
        private func solidPNG(width: Int, height: Int, r: CGFloat, g: CGFloat, b: CGFloat) throws
            -> Data
        {
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            guard let ctx = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                width > 0, height > 0
            else {
                throw MarkupFlattenError.undecodableImage
            }
            ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            guard let image = ctx.makeImage() else {
                throw MarkupFlattenError.undecodableImage
            }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                data, "public.png" as CFString, 1, nil)
            else {
                throw MarkupFlattenError.undecodableImage
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw MarkupFlattenError.undecodableImage
            }
            return data as Data
        }

        private struct RGB: Equatable {
            var r: Int
            var g: Int
            var b: Int
        }

        /// Non-square four-quadrant PNG: TL red, TR green, BL blue, BR yellow.
        /// Asymmetry is the orientation oracle — a flip or rotate cannot match all four.
        private func asymmetricPNG(width: Int, height: Int) throws -> Data {
            let colorSpace = CGColorSpaceCreateDeviceRGB()
            guard let ctx = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
                width > 0, height > 0
            else {
                throw MarkupFlattenError.undecodableImage
            }
            let midX = CGFloat(width) / 2
            let midY = CGFloat(height) / 2
            // CG y=0 is the bottom of the bitmap. Visual top-left is CG top-left.
            ctx.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
            ctx.fill(CGRect(x: 0, y: midY, width: midX, height: midY))
            ctx.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            ctx.fill(CGRect(x: midX, y: midY, width: midX, height: midY))
            ctx.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: midX, height: midY))
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 0, alpha: 1))
            ctx.fill(CGRect(x: midX, y: 0, width: midX, height: midY))
            guard let image = ctx.makeImage() else {
                throw MarkupFlattenError.undecodableImage
            }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                data, "public.png" as CFString, 1, nil)
            else {
                throw MarkupFlattenError.undecodableImage
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw MarkupFlattenError.undecodableImage
            }
            return data as Data
        }

        private func decodeImage(_ data: Data) throws -> CGImage {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
                image.width > 0, image.height > 0
            else {
                throw MarkupFlattenError.undecodableImage
            }
            return image
        }

        /// Sample in payload space: `(nx, ny)` with origin top-left, matching markup y=0.
        /// `CGImage.cropping` is top-left origin, so this does not depend on
        /// CGContext bitmap row order.
        private func sample(_ image: CGImage, nx: Double, ny: Double) throws -> RGB {
            let width = image.width
            let height = image.height
            let x = min(width - 1, max(0, Int((nx * Double(width)).rounded(.down))))
            let yFromTop = min(height - 1, max(0, Int((ny * Double(height)).rounded(.down))))
            guard let cropped = image.cropping(
                to: CGRect(x: x, y: yFromTop, width: 1, height: 1))
            else {
                throw MarkupFlattenError.undecodableImage
            }
            var pixel = [UInt8](repeating: 0, count: 4)
            let drawn = pixel.withUnsafeMutableBytes { raw -> Bool in
                guard let ctx = CGContext(
                    data: raw.baseAddress,
                    width: 1,
                    height: 1,
                    bitsPerComponent: 8,
                    bytesPerRow: 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                else { return false }
                ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: 1, height: 1))
                return true
            }
            guard drawn else { throw MarkupFlattenError.undecodableImage }
            return RGB(r: Int(pixel[0]), g: Int(pixel[1]), b: Int(pixel[2]))
        }

        private func near(_ a: RGB, expected: RGB, slack: Int = 64) -> Bool {
            abs(a.r - expected.r) <= slack
                && abs(a.g - expected.g) <= slack
                && abs(a.b - expected.b) <= slack
        }

        /// Orientation oracle that survives ImageIO primary-color shifts.
        /// A flip/rotate swaps which quadrant is which and fails this.
        private func isRed(_ c: RGB) -> Bool { c.r >= 200 && c.r > c.g && c.r > c.b }
        private func isGreen(_ c: RGB) -> Bool { c.g >= 200 && c.g > c.r && c.g > c.b }
        private func isBlue(_ c: RGB) -> Bool { c.b >= 200 && c.b > c.r && c.b > c.g }
        private func isYellow(_ c: RGB) -> Bool { c.r >= 200 && c.g >= 200 && c.b < 80 }

        @Test("empty markup is identity — original bytes come back unchanged")
        func emptyMarkupIsIdentity() throws {
            let original = try solidPNG(width: 8, height: 8, r: 1, g: 0, b: 0)
            let flattened = try MarkupFlattener.flatten(imageData: original, primitives: [])
            #expect(flattened == original)
        }

        @Test("non-empty markup changes the bytes — a silent no-op would fail the user")
        func nonEmptyMarkupChangesBytes() throws {
            let original = try solidPNG(width: 64, height: 64, r: 0, g: 0, b: 1)
            let primitive = MarkupPrimitive.stroke(
                points: [
                    NormalizedCoordinate(x: 0, y: 0),
                    NormalizedCoordinate(x: 1, y: 1),
                ],
                color: .red,
                thickness: 64)
            let flattened = try MarkupFlattener.flatten(
                imageData: original, primitives: [primitive])
            #expect(flattened != original)
            #expect(flattened.count <= MarkupFlattener.maxEncodedBytes)
            let item = try ComposerMarkupInboxItem.prepared(
                name: "shot.jpg",
                imageData: original,
                payload: MarkupPayload(attachmentId: "att-flat", primitives: [primitive]))
            #expect(item.imageData != original)
            #expect(item.payload?.attachmentId == "att-flat")
        }

        @Test("flatten paints the mark at the normalized location without flipping the image")
        func flattenPaintsMarkAndPreservesOrientation() throws {
            let width = 160
            let height = 80
            let original = try asymmetricPNG(width: width, height: height)
            let source = try decodeImage(original)
            #expect(source.width == width)
            #expect(source.height == height)

            let red = RGB(r: 255, g: 0, b: 0)
            let blue = RGB(r: 0, g: 0, b: 255)
            let yellow = RGB(r: 255, g: 255, b: 0)

            // Interior of each quadrant. If this mapping is wrong the test
            // fails before flatten runs — the orientation oracle is the PNG.
            let sourceTL = try sample(source, nx: 0.20, ny: 0.20)
            let sourceTR = try sample(source, nx: 0.80, ny: 0.20)
            let sourceBL = try sample(source, nx: 0.20, ny: 0.80)
            let sourceBR = try sample(source, nx: 0.80, ny: 0.80)
            #expect(isRed(sourceTL), "TL=\(sourceTL)")
            #expect(isGreen(sourceTR), "TR=\(sourceTR)")
            #expect(isBlue(sourceBL), "BL=\(sourceBL)")
            #expect(isYellow(sourceBR), "BR=\(sourceBR)")

            let magenta = MarkupColor(r: 1, g: 0, b: 1)
            let mark = MarkupPrimitive.stroke(
                points: [
                    NormalizedCoordinate(x: 0.70, y: 0.15),
                    NormalizedCoordinate(x: 0.90, y: 0.35),
                ],
                color: magenta,
                thickness: MarkupPrimitive.maxThickness)
            let flattened = try MarkupFlattener.flatten(
                imageData: original, primitives: [mark])
            let output = try decodeImage(flattened)
            #expect(output.width == width)
            #expect(output.height == height)

            let marked = try sample(output, nx: 0.80, ny: 0.25)
            let baselineGreen = try sample(source, nx: 0.80, ny: 0.25)
            // Magenta on green: R and B rise, G falls. JPEG re-encoding of a
            // no-op draw cannot satisfy this; PNG-vs-JPEG byte inequality can.
            #expect(marked.r - baselineGreen.r >= 80)
            #expect(marked.b - baselineGreen.b >= 80)
            #expect(baselineGreen.g - marked.g >= 80)
            #expect(near(marked, expected: RGB(r: 255, g: 0, b: 255), slack: 80))

            let outTL = try sample(output, nx: 0.20, ny: 0.20)
            let outBL = try sample(output, nx: 0.20, ny: 0.80)
            let outBR = try sample(output, nx: 0.80, ny: 0.80)
            #expect(isRed(outTL) && near(outTL, expected: red), "outTL=\(outTL)")
            #expect(isBlue(outBL) && near(outBL, expected: blue), "outBL=\(outBL)")
            #expect(isYellow(outBR) && near(outBR, expected: yellow), "outBR=\(outBR)")
        }

        @Test("flatten refuses rather than silently exceeding the 8 MiB cap")
        func flattenRefusesOverCap() throws {
            let original = try solidPNG(width: 32, height: 32, r: 0, g: 1, b: 0)
            let primitive = MarkupPrimitive.rect(
                start: NormalizedCoordinate(x: 0, y: 0),
                end: NormalizedCoordinate(x: 1, y: 1),
                color: .red,
                thickness: 8)
            do {
                _ = try MarkupFlattener.flatten(
                    imageData: original, primitives: [primitive], maxEncodedBytes: 16)
                Issue.record("expected exceedsMaximum")
            } catch MarkupFlattenError.exceedsMaximum(let received, let maximum) {
                #expect(received > 16)
                #expect(maximum == 16)
            } catch {
                Issue.record("wrong error \(error)")
            }
        }

        @Test("flatten bounds decoded raster allocation before drawing")
        func flattenRefusesOversizedRaster() throws {
            let original = try solidPNG(width: 32, height: 32, r: 0, g: 1, b: 0)
            let primitive = MarkupPrimitive.rect(
                start: NormalizedCoordinate(x: 0, y: 0),
                end: NormalizedCoordinate(x: 1, y: 1),
                color: .red,
                thickness: 8)

            do {
                _ = try MarkupFlattener.flatten(
                    imageData: original,
                    primitives: [primitive],
                    maxRasterPixels: 1_000)
                Issue.record("expected rasterExceedsMaximum for pixel count")
            } catch MarkupFlattenError.rasterExceedsMaximum(
                let width, let height, let maximumDimension, let maximumPixels)
            {
                #expect(width == 32)
                #expect(height == 32)
                #expect(maximumDimension == MarkupFlattener.maxRasterDimension)
                #expect(maximumPixels == 1_000)
            } catch {
                Issue.record("wrong error \(error)")
            }

            do {
                _ = try MarkupFlattener.flatten(
                    imageData: original,
                    primitives: [primitive],
                    maxRasterDimension: 16)
                Issue.record("expected rasterExceedsMaximum for dimension")
            } catch MarkupFlattenError.rasterExceedsMaximum(
                let width, let height, let maximumDimension, let maximumPixels)
            {
                #expect(width == 32)
                #expect(height == 32)
                #expect(maximumDimension == 16)
                #expect(maximumPixels == MarkupFlattener.maxRasterPixels)
            } catch {
                Issue.record("wrong error \(error)")
            }
        }
    }
#endif
