// Sparse iOS haptics palette for discrete, user-initiated actions.
// Desktop gets no haptic affordance (no reliable hardware path).
//
// Law: fire ONLY on user-initiated discrete actions — never streaming,
// passive, or timer-driven updates. Call sites should reference these
// tokens rather than scattering SensoryFeedback literals.

import SwiftUI

enum MotionHaptics {
    /// Toggles, pickers, chip taps, drag-commit nudge.
    static let selection: SensoryFeedback = .selection

    /// Approval accept, pairing/send success, recenter success.
    static let success: SensoryFeedback = .success

    /// Approval deny, failure banner, destructive confirm.
    static let warning: SensoryFeedback = .warning

    /// Drag pickup (discrete user grab). Kept as impact so a hold-to-move
    /// feels heavier than a light selection tick.
    static let impactMedium: SensoryFeedback = .impact(weight: .medium)

    /// Map an approval decision to success vs warning.
    static func forApproval(destructive: Bool) -> SensoryFeedback {
        destructive ? warning : success
    }
}

extension View {
    /// Apply a palette haptic on an equatable trigger (counter ticks, toggles).
    func motionHaptic(_ feedback: SensoryFeedback, trigger: some Equatable) -> some View {
        sensoryFeedback(feedback, trigger: trigger)
    }
}
