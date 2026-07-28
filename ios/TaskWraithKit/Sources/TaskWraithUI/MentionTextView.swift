// A UITextView-backed composer input that mirrors the previous
// `TextField(text:, axis: .vertical).lineLimit(1...2)` behaviour, so a later
// slice can colour @mention tokens inline as the user types.
//
// WHY a representable (not TextField/TextEditor): SwiftUI text controls bound to
// a `String` render PLAIN text only — there is no API to colour individual
// character ranges inline WHILE EDITING on iOS 17. The transcript can tint
// mentions because it is static `Text(AttributedString)`; an editable field
// cannot. So inline composer highlighting requires dropping to UIKit.
//
// LAYOUT CONTRACT — must stay visually compatible with the old TextField inside
// the composer input HStack, across every composer shell variant:
//   - greedy horizontal: the call site wraps this in `.frame(maxWidth:.infinity)`
//     so the HStack hands it the leftover width after the row buttons, and
//     `sizeThatFits` adopts that proposed width (a representable has no built-in
//     "fill" trait the way SwiftUI's TextField does);
//   - vertical auto-grow 1→2 lines then scrolls (lineLimit(1...2) parity), with a
//     ~8pt vertical text inset so a 1-line field is the same height as the old
//     TextField (NOT a collapsed glyph-tall box — that shrank/de-centred the row
//     on small-send-button shells like claude);
//   - font = the shell's font design; text colour = shell.palette.textPrimary;
//   - a manual placeholder label (UITextView has none);
//   - return SUBMITS (`onSubmit`) — on-screen the key is labelled "send", and a
//     hardware Return matches the desktop composer's Enter-sends. A newline is
//     still reachable two ways: hardware Shift+Return (a prioritised
//     UIKeyCommand), and pasted/dictated text (multi-character insertions are
//     never intercepted). An in-flight IME composition's Return commits the
//     marked text as normal — intercepting it would break CJK entry.
//
// This file is UIKit-only (the shipping target). The macOS `swift build` used
// for compile-checks has no UIKit, so the composer keeps a plain `TextField`
// fallback there (see ComposerView.composerTextInput) — mirroring how
// FileEditorViews guards its Runestone representable.

import SwiftUI
import TaskWraithKit

/// Pure decision for the composer's Return interception, kept outside the
/// UIKit guard so the macOS test build can pin it. Return SUBMITS exactly when
/// the inserted text is one lone newline, a submit action exists, no IME
/// composition is being committed (a CJK keyboard's Return commits marked text
/// — intercepting it would break entry), and the Shift+Return key command has
/// not latched this insertion as a deliberate newline. Everything else —
/// pasted/dictated multi-character text included — inserts as typed.
func twComposerReturnSubmits(
    replacement: String, hasSubmitAction: Bool, isCommittingMarkedText: Bool,
    newlineLatched: Bool
) -> Bool {
    replacement == "\n" && hasSubmitAction && !isCommittingMarkedText && !newlineLatched
}

#if canImport(UIKit)
    import UIKit

    /// UIFont parity for `twComposerFont` (which returns `.system(.body, design:)`).
    /// Built from the Dynamic-Type body font so size tracks the user's text-size
    /// setting exactly like the SwiftUI original.
    func twUIComposerFont(_ design: ComposerShellFontDesign, scale: TWAppScale = .standard) -> UIFont {
        let base = UIFont.preferredFont(forTextStyle: .body)
        let pointSize = scale.scaled(base.pointSize)
        let systemDesign: UIFontDescriptor.SystemDesign
        switch design {
        case .system: systemDesign = .default
        case .monospaced: systemDesign = .monospaced
        case .serif: systemDesign = .serif
        }
        if let descriptor = base.fontDescriptor.withDesign(systemDesign) {
            return UIFont(descriptor: descriptor, size: pointSize)
        }
        return UIFont(descriptor: base.fontDescriptor, size: pointSize)
    }

    /// UITextView subclass whose only job is the Shift+Return newline: a
    /// prioritised key command intercepts the hardware chord before the system
    /// inserts a plain "\n" (which the delegate would submit), and the
    /// `allowNextNewline` latch lets that one programmatic insertion pass the
    /// delegate's Return interception.
    final class TWComposerTextView: UITextView {
        var allowNextNewline = false

        override var keyCommands: [UIKeyCommand]? {
            let shiftReturn = UIKeyCommand(
                input: "\r", modifierFlags: .shift, action: #selector(insertNewlineFromShiftReturn))
            // Without priority the system handles shift+return as an ordinary
            // Return (shift ignored) and the command never fires.
            shiftReturn.wantsPriorityOverSystemBehavior = true
            return [shiftReturn]
        }

        @objc private func insertNewlineFromShiftReturn() {
            allowNextNewline = true
            insertText("\n")
            allowNextNewline = false
        }
    }

    struct MentionTextView: UIViewRepresentable {
        @Binding var text: String
        /// Bridges the composer's focus state (was `@FocusState`) to the text
        /// view's first-responder status, both directions.
        @Binding var focused: Bool
        /// Return-key submit action (the same action as the send button). When
        /// nil the field keeps the old newline-on-return behaviour.
        var onSubmit: (() -> Void)? = nil
        /// Ensemble participants used to resolve @mention tokens to a provider hue
        /// (empty = no tinting). Same resolution the transcript uses, so composer
        /// and transcript colour identical tokens identically.
        var participants: [RemoteEnsembleState.Participant] = []
        var font: UIFont
        var textColor: Color
        var placeholderColor: Color
        var placeholder: String
        /// Visible lines before scrolling kicks in (the lineLimit upper bound).
        var maxLines: Int = 2
        /// Top/bottom text inset — restores the old TextField's vertical breathing
        /// room so the row height + sibling centring are unchanged.
        var verticalInset: CGFloat = 8

        // Heights are derived from the coordinator's MEASURED line-fragment height
        // (see Coordinator.lineFragmentHeight) — NOT `ceil(font.lineHeight)`, which
        // is ~1pt/line short of TextKit's true fragment height and so clips the 2nd
        // line / scrolls a line early on common Dynamic-Type sizes.

        func makeCoordinator() -> Coordinator { Coordinator(self) }

        func makeUIView(context: Context) -> UITextView {
            let textView = TWComposerTextView()
            textView.delegate = context.coordinator
            textView.backgroundColor = .clear
            textView.textContainerInset = UIEdgeInsets(
                top: verticalInset, left: 0, bottom: verticalInset, right: 0)
            textView.textContainer.lineFragmentPadding = 0
            textView.font = font
            textView.textColor = UIColor(textColor)
            // Caret/selection use the text colour (not an accent): guaranteed
            // legible on every shell surface — a low-contrast accent could make the
            // caret invisible on some palettes.
            textView.tintColor = UIColor(textColor)
            textView.isScrollEnabled = false  // hug content until the 2-line cap
            textView.scrollsToTop = false
            textView.adjustsFontForContentSizeCategory = true
            // With a submit action the on-screen key says "send" and Return
            // submits (desktop Enter parity; Shift+Return = newline). Without
            // one, the old newline-on-return behaviour stands.
            textView.returnKeyType = onSubmit == nil ? .default : .send
            textView.textContainer.lineBreakMode = .byWordWrapping
            textView.typingAttributes = [
                .font: font, .foregroundColor: UIColor(textColor),
            ]
            // One coherent VoiceOver field (the placeholder is a sibling label).
            textView.accessibilityLabel = placeholder

            // Manual placeholder — UITextView has no native one. Pinned to match the
            // text origin (top inset; left inset is 0).
            let placeholderLabel = UILabel()
            placeholderLabel.text = placeholder
            placeholderLabel.font = font
            placeholderLabel.textColor = UIColor(placeholderColor)
            placeholderLabel.numberOfLines = 1
            placeholderLabel.lineBreakMode = .byTruncatingTail
            placeholderLabel.isAccessibilityElement = false
            placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
            textView.addSubview(placeholderLabel)
            NSLayoutConstraint.activate([
                placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor),
                placeholderLabel.trailingAnchor.constraint(
                    lessThanOrEqualTo: textView.trailingAnchor),
                placeholderLabel.topAnchor.constraint(
                    equalTo: textView.topAnchor, constant: verticalInset),
            ])
            context.coordinator.placeholderLabel = placeholderLabel

            textView.text = text
            placeholderLabel.isHidden = !text.isEmpty
            refreshHighlight(textView, coordinator: context.coordinator)
            return textView
        }

        func updateUIView(_ textView: UITextView, context: Context) {
            context.coordinator.parent = self

            // Adopt EXTERNAL text changes (insertMention, queue-clear, thread
            // switch) without clobbering an in-progress edit or IME marked text.
            // Normal typing never reaches here (the delegate already synced the
            // binding to the view), so this branch only fires for programmatic
            // edits — where the user expects the caret at the END of the new text.
            if textView.markedTextRange == nil, textView.text != text {
                textView.text = text
                let end = (textView.text as NSString).length
                textView.selectedRange = NSRange(location: end, length: 0)
                // The String setter resets typingAttributes — restore them so the
                // next typed glyph keeps the shell font/colour (and, later, isn't
                // tinted with a stale mention colour).
                textView.typingAttributes = [
                    .font: font, .foregroundColor: UIColor(textColor),
                ]
            }

            // Caret/selection tint ONLY. Do NOT set textView.font / textView.textColor
            // here: those are VIEW-WIDE and stomp the per-character @mention colours
            // (typing a word after "@Codex" was wiping its hue while the bold — a
            // run attribute the getter-gated font line happened to skip — survived).
            // The shell font + base text colour are owned by applyHighlight via
            // attributedText/typingAttributes, and re-applied when the shell changes
            // because the highlight signature includes the font + colour.
            textView.tintColor = UIColor(textColor)

            let placeholderLabel = context.coordinator.placeholderLabel
            placeholderLabel?.text = placeholder
            placeholderLabel?.font = font
            placeholderLabel?.textColor = UIColor(placeholderColor)
            placeholderLabel?.isHidden = !textView.text.isEmpty
            textView.accessibilityLabel = placeholder

            // Re-tint @mentions when the resolved ranges / shell style changed.
            // Runs before the scroll measure so the cap sees the emphasised text;
            // preserves the caret and resets typingAttributes.
            refreshHighlight(textView, coordinator: context.coordinator)

            // Scroll only once content exceeds the visible-line cap; otherwise the
            // view hugs its content and `sizeThatFits` drives the frame height. Skip
            // until the view has a real width (bounds.width is 0 on the first pass).
            if textView.bounds.width > 1 {
                let fitted = textView.sizeThatFits(
                    CGSize(width: textView.bounds.width, height: .greatestFiniteMagnitude)
                ).height
                let cap = context.coordinator.cappedHeight(
                    font: font, maxLines: maxLines, inset: verticalInset)
                let shouldScroll = fitted > cap + 0.5
                if textView.isScrollEnabled != shouldScroll {
                    textView.isScrollEnabled = shouldScroll
                }
            }

            // Focus bridge. Deferred out of the layout pass: a synchronous
            // become/resign here can trigger "modifying state during view update"
            // (the delegate writes `focused` back) and becomeFirstResponder no-ops
            // if the view isn't in a window yet. Only dispatch on a real mismatch,
            // and re-check inside (state may have moved on by the next runloop).
            if focused != textView.isFirstResponder {
                let wantsFocus = focused
                DispatchQueue.main.async {
                    guard wantsFocus != textView.isFirstResponder,
                        textView.window != nil
                    else { return }
                    if wantsFocus {
                        textView.becomeFirstResponder()
                    } else {
                        textView.resignFirstResponder()
                    }
                }
            }
        }

        /// iOS 16+: accept SwiftUI's proposed width (the HStack leftover, made
        /// concrete by `.frame(maxWidth:.infinity)` at the call site) and return the
        /// content height clamped to 1…maxLines. This is what gives the field
        /// TextField-like greedy-horizontal / hug-vertical behaviour.
        func sizeThatFits(
            _ proposal: ProposedViewSize, uiView textView: UITextView, context: Context
        ) -> CGSize? {
            guard let width = proposal.width, width > 0, width != .infinity else { return nil }
            let fitted = textView.sizeThatFits(
                CGSize(width: width, height: .greatestFiniteMagnitude)
            ).height
            let minHeight = context.coordinator.minHeight(font: font, inset: verticalInset)
            let maxHeight = context.coordinator.cappedHeight(
                font: font, maxLines: maxLines, inset: verticalInset)
            let height = max(minHeight, min(fitted, maxHeight))
            return CGSize(width: width, height: height)
        }

        /// Re-tint @mentions, but ONLY when the resolved ranges or shell style
        /// changed since the last apply. Ordinary keystrokes don't change the mention
        /// set, so they skip the rebuild — important because re-installing
        /// `attributedText` on every keystroke tears down iOS's live autocorrect /
        /// predictive session and the double-space-period shortcut. IME-safe.
        @MainActor
        func refreshHighlight(_ textView: UITextView, coordinator: Coordinator) {
            guard textView.markedTextRange == nil else { return }  // don't disturb IME
            let plain = textView.text ?? ""
            let ranges: [TWMentionRange] =
                (participants.isEmpty || plain.isEmpty)
                ? [] : twMentionRanges(in: plain, participants: participants)
            let signature = highlightSignature(plain: plain, ranges: ranges)
            guard signature != coordinator.lastHighlightSignature else { return }
            applyHighlight(to: textView, ranges: ranges)
            coordinator.lastHighlightSignature = signature
        }

        /// Signature of everything that affects the rendered tint: shell font + text
        /// colour, and per resolved mention its range + accent + matched token text.
        /// Deliberately EXCLUDES the raw text, so appending plain text (the common
        /// case) leaves it stable and skips the rebuild; the token text is included
        /// so swapping one mention for a same-length one still re-tints. Including the
        /// accent also re-tints when the theme accent (chroma1 / @user) changes.
        private func highlightSignature(plain: String, ranges: [TWMentionRange]) -> String {
            var parts: [String] = [
                font.fontName, "\(font.pointSize)", UIColor(textColor).description,
            ]
            let ns = plain as NSString
            for range in ranges {
                let token =
                    (range.location >= 0 && range.location + range.length <= ns.length)
                    ? ns.substring(with: NSRange(location: range.location, length: range.length))
                    : ""
                parts.append(
                    "\(range.location):\(range.length):\(UIColor(range.accent).description):\(token)")
            }
            return parts.joined(separator: "\u{1}")
        }

        /// Build + install the attributed text from pre-resolved ranges. UTF-16
        /// (NSRange) locations from `twMentionRanges` drop straight into
        /// NSAttributedString. Selection-preserving; resets typingAttributes so text
        /// typed AFTER a mention is not tinted/bold; keeps the caret on-screen.
        @MainActor
        func applyHighlight(to textView: UITextView, ranges: [TWMentionRange]) {
            let plain = textView.text ?? ""
            let base: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: UIColor(textColor),
            ]
            let attributed = NSMutableAttributedString(string: plain, attributes: base)
            let emphasis = emphasisFont(font)
            let full = attributed.length
            for range in ranges {
                guard range.location >= 0, range.length > 0,
                    range.location + range.length <= full
                else { continue }
                attributed.addAttributes(
                    [.font: emphasis, .foregroundColor: UIColor(range.accent)],
                    range: NSRange(location: range.location, length: range.length))
            }
            let selected = textView.selectedRange
            textView.attributedText = attributed
            let length = attributed.length
            let location = min(selected.location, length)
            textView.selectedRange = NSRange(
                location: location, length: min(selected.length, length - location))
            textView.typingAttributes = base
            // A re-tint may have re-laid-out a scrolled (2-line) field — keep the
            // caret visible.
            if textView.isScrollEnabled, textView.isFirstResponder {
                textView.scrollRangeToVisible(textView.selectedRange)
            }
        }

        /// A SEMIBOLD variant of the shell font for mention tokens — matches the
        /// transcript's `.semibold` weight while keeping the shell's design
        /// (mono/serif). UIFont falls back to the nearest available face if a given
        /// design lacks semibold, so the colour stays the guaranteed signal.
        private func emphasisFont(_ base: UIFont) -> UIFont {
            let descriptor = base.fontDescriptor.addingAttributes([
                .traits: [UIFontDescriptor.TraitKey.weight: UIFont.Weight.semibold]
            ])
            return UIFont(descriptor: descriptor, size: base.pointSize)
        }

        final class Coordinator: NSObject, UITextViewDelegate {
            var parent: MentionTextView
            weak var placeholderLabel: UILabel?
            // Single-slot cache for the measured line-fragment height (font rarely
            // changes — Dynamic Type / shell font-design swaps invalidate it).
            private var cachedFont: UIFont?
            private var cachedLineHeight: CGFloat = 0
            /// Last tint signature applied (see MentionTextView.highlightSignature)
            /// so make/update/typing skip rebuilding the attributed text unless the
            /// resolved mentions or shell style actually changed.
            var lastHighlightSignature: String = "\u{0}"

            init(_ parent: MentionTextView) { self.parent = parent }

            /// TextKit lays each line out a hair taller than `font.lineHeight`
            /// (fragment rounding / `usesFontLeading`). Measure the REAL one-line
            /// height for this exact font once, so the 1-/2-line caps don't clip the
            /// last line or scroll early. Design-agnostic (mono/serif measured too).
            func lineFragmentHeight(for font: UIFont) -> CGFloat {
                if cachedFont == font { return cachedLineHeight }
                let probe = UITextView()
                probe.textContainerInset = .zero
                probe.textContainer.lineFragmentPadding = 0
                probe.font = font
                probe.text = "Ag"
                let measured = ceil(
                    probe.sizeThatFits(
                        CGSize(width: CGFloat(10_000), height: .greatestFiniteMagnitude)
                    ).height)
                cachedFont = font
                cachedLineHeight = measured
                return measured
            }

            func minHeight(font: UIFont, inset: CGFloat) -> CGFloat {
                lineFragmentHeight(for: font) + inset * 2
            }

            func cappedHeight(font: UIFont, maxLines: Int, inset: CGFloat) -> CGFloat {
                lineFragmentHeight(for: font) * CGFloat(maxLines) + inset * 2
            }

            func textView(
                _ textView: UITextView, shouldChangeTextIn range: NSRange,
                replacementText text: String
            ) -> Bool {
                // See twComposerReturnSubmits for the full contract (IME
                // commit and Shift+Return latch pass through; paste/dictation
                // are multi-character and never match).
                let submits = twComposerReturnSubmits(
                    replacement: text,
                    hasSubmitAction: parent.onSubmit != nil,
                    isCommittingMarkedText: textView.markedTextRange != nil,
                    newlineLatched: (textView as? TWComposerTextView)?.allowNextNewline == true
                )
                guard submits else { return true }
                parent.onSubmit?()
                return false
            }

            func textViewDidChange(_ textView: UITextView) {
                placeholderLabel?.isHidden = !textView.text.isEmpty
                // Don't publish provisional IME/dictation text — wait for the commit
                // (the next textViewDidChange) so the binding only ever holds
                // committed characters.
                guard textView.markedTextRange == nil else { return }
                if parent.text != textView.text { parent.text = textView.text }
                // Re-tint live so a just-completed @mention colours immediately
                // (no-op when the mention set is unchanged — see refreshHighlight).
                parent.refreshHighlight(textView, coordinator: self)
            }

            func textViewDidBeginEditing(_ textView: UITextView) {
                if !parent.focused { parent.focused = true }
            }

            func textViewDidEndEditing(_ textView: UITextView) {
                if parent.focused { parent.focused = false }
            }
        }
    }
#endif
