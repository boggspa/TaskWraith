import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Vision
@testable import TaskWraithBridgeDaemon

/// OCR plumbing tests. We don't exercise Vision's text-recognition accuracy
/// here — that's Apple's responsibility and unit tests with synthetic glyphs
/// would be brittle. We do pin down the wire shape: an empty / textless PNG
/// returns an empty `OcrResult`, and the JSON envelope matches what the main
/// process expects when forwarding via `attached_window_capture`.
final class AttachedWindowOCRTests: XCTestCase {
    func testEmptyPNGProducesEmptyResultWithoutThrowing() async throws {
        let png = makeBlankPNG(width: 32, height: 32, gray: 1.0)
        let result = try await AttachedWindowOCR.recognize(pngData: png)
        XCTAssertEqual(result.text, "")
        XCTAssertTrue(result.blocks.isEmpty)
    }

    func testJSONShapeContainsTextAndBlocksKeys() async throws {
        let png = makeBlankPNG(width: 16, height: 16, gray: 0.0)
        let result = try await AttachedWindowOCR.recognize(pngData: png)
        let json = result.toJSONObject()
        XCTAssertNotNil(json["text"] as? String)
        XCTAssertNotNil(json["blocks"] as? [[String: Any]])
    }

    func testCorruptInputResolvesToEmptyResultRatherThanThrowing() async throws {
        // makeCGImage returns nil for garbage data, and the recognizer
        // short-circuits to an empty result — the OCR layer never throws
        // on bad pixels, so callers can safely treat "no text" the same
        // as "could not decode".
        let garbage = Data([0x00, 0x01, 0x02, 0x03])
        let result = try await AttachedWindowOCR.recognize(pngData: garbage)
        XCTAssertEqual(result.text, "")
        XCTAssertTrue(result.blocks.isEmpty)
    }

    // MARK: - Path-based entry point (document.ocrImage)

    func testRecognizeAtPathReadsAnImageFile() async throws {
        let png = makeBlankPNG(width: 24, height: 24, gray: 1.0)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ocr-path-\(UUID().uuidString).png")
        try png.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }

        let result = try await AttachedWindowOCR.recognize(imageAtPath: url.path)
        XCTAssertEqual(result.text, "")
        XCTAssertTrue(result.blocks.isEmpty)
    }

    func testRecognizeAtPathRejectsMissingFile() async throws {
        let missing = FileManager.default.temporaryDirectory
            .appendingPathComponent("ocr-absent-\(UUID().uuidString).png")
        do {
            _ = try await AttachedWindowOCR.recognize(imageAtPath: missing.path)
            XCTFail("expected badInput for a missing file")
        } catch AttachedWindowOCR.OcrError.badInput(let message) {
            XCTAssertTrue(message.contains("not found"))
        }
    }

    func testRecognizeAtPathRejectsOversizedFile() async throws {
        // Bounds the decode: an unbounded read would let a huge file balloon
        // daemon memory. Written sparsely so the test stays fast.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ocr-huge-\(UUID().uuidString).png")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(AttachedWindowOCR.maxImageBytes + 1))
        try handle.close()
        defer { try? FileManager.default.removeItem(at: url) }

        do {
            _ = try await AttachedWindowOCR.recognize(imageAtPath: url.path)
            XCTFail("expected badInput for an oversized file")
        } catch AttachedWindowOCR.OcrError.badInput(let message) {
            XCTAssertTrue(message.contains("OCR limit"))
        }
    }

    // MARK: - Empty-recognition error classification
    //
    // Vision throws on a blank/textless image on some macOS versions (observed
    // on the release app-host) but returns zero observations on others, so the
    // throw path can't be exercised deterministically via a real image. These
    // tests pin the classifier directly: Vision-domain failures degrade to an
    // empty result, the legacy "nilError" description still matches as a
    // fallback, and unrelated errors must rethrow.

    func testVisionDomainErrorIsTreatedAsEmpty() {
        let err = NSError(domain: VNErrorDomain, code: 0, userInfo: nil)
        XCTAssertTrue(AttachedWindowOCR.isEmptyRecognitionError(err))
    }

    func testLegacyNilErrorDescriptionIsTreatedAsEmpty() {
        XCTAssertTrue(AttachedWindowOCR.isEmptyRecognitionError(LegacyNilError()))
    }

    func testUnrelatedErrorIsNotTreatedAsEmpty() {
        let err = NSError(domain: NSCocoaErrorDomain, code: 42, userInfo: nil)
        XCTAssertFalse(AttachedWindowOCR.isEmptyRecognitionError(err))
    }

    /// Mimics the pre-hardening runtime error whose `String(describing:)` is
    /// exactly "nilError", exercising the defensive fallback branch.
    private struct LegacyNilError: Error, CustomStringConvertible {
        var description: String { "nilError" }
    }

    // MARK: - Helpers

    private func makeBlankPNG(width: Int, height: Int, gray: CGFloat) -> Data {
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return Data()
        }
        context.setFillColor(gray: gray, alpha: 1.0)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let cgImage = context.makeImage() else { return Data() }

        let mutableData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            mutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            return Data()
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        CGImageDestinationFinalize(destination)
        return mutableData as Data
    }
}
