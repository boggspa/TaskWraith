// Thin live-number label for counts that tick (token bars, badge counts, ±
// stats). Centralizes monospaced digits + `.contentTransition(.numericText)`
// and the Reduce Motion path so call sites don't re-derive the recipe.
//
// Design law (motion pass): keep native `.numericText` — do NOT port Electron's
// DigitOdometer wheel. Static labels stay plain `Text`.

import SwiftUI

public struct NumericTickText: View {
    private let text: String
    private let value: Double
    private let font: Font
    private let color: Color?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(
        _ text: String,
        value: Double,
        font: Font = .body.monospacedDigit(),
        color: Color? = nil
    ) {
        self.text = text
        self.value = value
        self.font = font
        self.color = color
    }

    public init(
        value: Int,
        format: (Int) -> String = { "\($0)" },
        font: Font = .body.monospacedDigit(),
        color: Color? = nil
    ) {
        self.text = format(value)
        self.value = Double(value)
        self.font = font
        self.color = color
    }

    public var body: some View {
        textLabel
            .font(font)
            .contentTransition(reduceMotion ? .identity : .numericText(value: value))
            .animation(
                reduceMotion ? ComposerMotion.reducedFade : .snappy(duration: 0.25),
                value: value)
    }

    @ViewBuilder
    private var textLabel: some View {
        if let color {
            Text(text).foregroundStyle(color)
        } else {
            Text(text)
        }
    }
}
