#!/usr/bin/env swift

import AppKit
import Foundation
import Vision

struct StudioHudTextObservation: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: studio-hud-ocr.swift <screenshot.png>\n", stderr)
    exit(64)
}

let screenshotURL = URL(
    fileURLWithPath: CommandLine.arguments[1]
).standardizedFileURL
guard let image = NSImage(contentsOf: screenshotURL),
      let cgImage = image.cgImage(
          forProposedRect: nil,
          context: nil,
          hints: nil
      )
else {
    fputs("could not decode screenshot\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
request.minimumTextHeight = 0.005

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
    let observations = (request.results ?? []).compactMap {
        observation -> StudioHudTextObservation? in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }
        return StudioHudTextObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            x: observation.boundingBox.origin.x,
            y: observation.boundingBox.origin.y,
            width: observation.boundingBox.width,
            height: observation.boundingBox.height
        )
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(observations))
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    fputs("Studio HUD OCR failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
