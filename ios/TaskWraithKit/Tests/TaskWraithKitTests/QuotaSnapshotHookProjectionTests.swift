import Foundation
import Testing

@testable import TaskWraithKit

@Suite("Credential-free quota hook projection")
struct QuotaSnapshotHookProjectionTests {
  @Test("decodes AntiGravity and PAYG display values additively")
  func decodesHookMeters() throws {
    let json = """
      {"usage":{"generatedAt":"2026-08-02T02:00:00.000Z","providers":[
        {"provider":"antigravity","planName":"Google AI Pro","windows":[
          {"id":"agy-weekly","label":"Gemini Weekly","usedPercent":0,"limitLabel":"99.97% remaining","resetAt":"2026-08-08T17:20:35.000Z"}
        ]},
        {"provider":"deepseek","planName":"API Credits","windows":[
          {"id":"deepseek-credit","label":"Credit used","usedPercent":9,"limitLabel":"$0.92 of $10.00","valueText":"$0.92"}
        ]},
        {"provider":"cerebras","planName":"Pay as you go","windows":[
          {"id":"cerebras-credit","label":"Credit used","usedPercent":14,"limitLabel":"$1.36 of $10.00","valueText":"$1.36"}
        ]}
      ]}}
      """

    let message = try JSONDecoder().decode(ModelUsageMessage.self, from: Data(json.utf8))

    #expect(message.usage.providers.map(\.provider) == ["antigravity", "deepseek", "cerebras"])
    #expect(message.usage.providers[0].planName == "Google AI Pro")
    #expect(message.usage.providers[0].windows[0].valueText == nil)
    #expect(message.usage.providers[1].planName == "API Credits")
    #expect(message.usage.providers[1].windows[0].valueText == "$0.92")
    #expect(message.usage.providers[2].windows[0].limitLabel == "$1.36 of $10.00")
  }

  @Test("keeps older quota-only payloads compatible")
  func decodesLegacyMeter() throws {
    let json = """
      {"usage":{"providers":[{"provider":"codex","windows":[
        {"id":"codex-weekly","label":"Weekly","usedPercent":14,"limitLabel":"86% remaining"}
      ]}]}}
      """

    let message = try JSONDecoder().decode(ModelUsageMessage.self, from: Data(json.utf8))

    #expect(message.usage.providers[0].planName == nil)
    #expect(message.usage.providers[0].windows[0].valueText == nil)
    #expect(message.usage.providers[0].windows[0].usedPercent == 14)
  }
}
