import SwiftUI
import TaskWraithKit

/// Thread-list title ink for the three row tones — the iOS twin of the
/// desktop sidebar's `sidebar-terminal-outcome-shimmer` sweep.
///
/// Desktop paints the title text itself with a slow single-band gradient
/// clipped to the glyphs, so the row's own chrome never changes and the accent
/// can't be mistaken for selection. This does the same with a masked gradient
/// over the text, at the same deliberately slow 10s cadence: the point is a
/// signal you notice on a second glance, not a blinking alarm.
///
/// Colours mirror desktop exactly — the diff hues for the two settled outcomes
/// (`TWTheme.diffStatAdd`/`diffStatDel` are the same 0x2DB777 / 0xEC3D35 the
/// renderer's Appearance defaults use) and `statusAttention` (0xF5A623) for the
/// live waiting tone, which is the same `--tool-warning` amber.
public enum TWThreadRowToneInk {
    public static func color(for tone: TWThreadRowTone) -> Color {
        switch tone {
        case .waiting: return TWTheme.statusAttention
        case .sleeping: return sleepingInk
        case .success: return TWTheme.diffStatAdd
        case .failure: return TWTheme.diffStatDel
        }
    }

    /// Sea blue — neither "finished" nor "needs you", the two things a
    /// sleeping run must not be mistaken for.
    ///
    /// The only tone that varies by theme brightness. The other three are
    /// legible either way (the diff hues are the user's own; amber carries on
    /// white), but a blue bright enough for dark chrome washes out on a light
    /// thread list. The pair is contrast-BALANCED rather than merely passing —
    /// 7.9:1 on the dark list, 7.0:1 on the light one — and matches the
    /// desktop sidebar's #57b6d9 / #15607a exactly.
    static var sleepingInk: Color {
        TWThemeStore.shared.systemTheme.isLight ? Color(hex: 0x15607A) : Color(hex: 0x57B6D9)
    }

    /// Sweep period, matching the desktop keyframe duration.
    public static let sweepDuration: Double = 10

    public static func accessibilityLabel(for tone: TWThreadRowTone, title: String) -> String {
        switch tone {
        case .waiting: return "\(title), waiting on your response"
        case .sleeping: return "\(title), sleeping until its next wake-up"
        case .success: return "\(title), completed successfully, unread"
        case .failure: return "\(title), blocked or failed, unread"
        }
    }
}

private struct TWThreadRowToneInkModifier: ViewModifier {
    let tone: TWThreadRowTone?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    func body(content: Content) -> some View {
        guard let tone else { return AnyView(content) }
        let base = TWThreadRowToneInk.color(for: tone)
        let tinted = content.foregroundStyle(base)
        guard !reduceMotion else { return AnyView(tinted) }
        return AnyView(
            tinted
                .overlay(
                    GeometryReader { proxy in
                        // One highlight band travelling across the glyphs. Both
                        // ends of the travel sit fully off the text, so the
                        // loop restart is invisible — the desktop rule that
                        // keeps a 10s sweep from reading as a stutter.
                        LinearGradient(
                            colors: [base, base.opacity(0), base],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: proxy.size.width * 3)
                        .offset(x: phase * proxy.size.width * 2)
                        .blendMode(.plusLighter)
                    }
                    .allowsHitTesting(false)
                )
                .mask(content)
                .onAppear {
                    withAnimation(
                        .linear(duration: TWThreadRowToneInk.sweepDuration)
                            .repeatForever(autoreverses: false)
                    ) {
                        phase = 1
                    }
                }
        )
    }
}

extension View {
    /// Paint a thread-list title in its row tone, with the slow sweep. `nil`
    /// leaves the view exactly as it was.
    public func twThreadRowToneInk(_ tone: TWThreadRowTone?) -> some View {
        modifier(TWThreadRowToneInkModifier(tone: tone))
    }
}
