import Foundation
import Vision
import CoreGraphics
import ImageIO

/// One OCR block — a line of recognized text plus its bounding rect in
/// normalized image coordinates (origin bottom-left, per Vision's convention).
/// We pass the rect through to callers so the AI can be told *where* text
/// appeared on the captured window — useful when the AI is asked to locate
/// a button, label, or value.
struct OcrBlock: Encodable, Sendable {
    let text: String
    let confidence: Double
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OcrResult: Sendable {
    let text: String
    let blocks: [OcrBlock]

    func toJSONObject() -> [String: Any] {
        return [
            "text": text,
            "blocks": blocks.map { block in
                [
                    "text": block.text,
                    "confidence": block.confidence,
                    "x": block.x,
                    "y": block.y,
                    "width": block.width,
                    "height": block.height
                ] as [String: Any]
            }
        ]
    }
}

enum AttachedWindowOCR {
    /// Recognize text in a PNG payload. Runs entirely on-device via the
    /// Vision framework — no data leaves the machine here. The caller still
    /// decides where to send the *resulting* OCR text (which follows the
    /// user's selected provider, same as any other tool output).
    static func recognize(pngData: Data) async throws -> OcrResult {
        guard let image = makeCGImage(from: pngData) else {
            return OcrResult(text: "", blocks: [])
        }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            if String(describing: error) == "nilError" {
                return OcrResult(text: "", blocks: [])
            }
            throw error
        }

        let observations = request.results ?? []
        var blocks: [OcrBlock] = []
        var lines: [String] = []
        blocks.reserveCapacity(observations.count)
        lines.reserveCapacity(observations.count)
        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            lines.append(candidate.string)
            let box = observation.boundingBox
            blocks.append(OcrBlock(
                text: candidate.string,
                confidence: Double(candidate.confidence),
                x: Double(box.origin.x),
                y: Double(box.origin.y),
                width: Double(box.size.width),
                height: Double(box.size.height)
            ))
        }
        return OcrResult(
            text: lines.joined(separator: "\n"),
            blocks: blocks
        )
    }

    private static func makeCGImage(from pngData: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(pngData as CFData, nil) else {
            return nil
        }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
}
