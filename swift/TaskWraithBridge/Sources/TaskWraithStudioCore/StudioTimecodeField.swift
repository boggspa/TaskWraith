import Foundation

/// A typed-into timecode readout (mission outcome 2's "timecode entry").
///
/// WHY THIS IS NOT AN NSTextField. An editable AppKit control over a
/// CAMetalLayer is a separate compositing layer above the video, which the
/// banked AVCDAW do-not-repeat note rules out for the preview surface. It is
/// also not how an NLE behaves: editors type INTO the running timecode display,
/// digits filling from the right, and the display itself is the field. Modelling
/// it as a small state machine keeps the whole behaviour in Core where it is
/// asserted, and leaves the drawing to the same Metal pass as everything else.
///
/// FILLING FROM THE RIGHT is the part people get wrong. Typing "412" means four
/// seconds and twelve frames, not four hours; each new digit shifts the previous
/// ones left. That matches every deck and NLE, and it matches the bare-digit
/// shorthand StudioTimecodeConverter.parse already accepts.
public struct StudioTimecodeFieldSnapshot: Equatable, Sendable {
    /// What the readout shows while entry is active, including the caret.
    public let displayText: String
    /// Digits typed so far, most significant first, at most 8.
    public let digits: String

    public init(displayText: String, digits: String) {
        self.displayText = displayText
        self.digits = digits
    }
}

public struct StudioTimecodeField: Equatable, Sendable {
    /// HHMMSSFF.
    public static let digitCapacity = 8
    /// Shown where a digit has not been typed yet.
    public static let placeholder: Character = "-"
    public static let caret: Character = "_"

    public private(set) var isActive = false
    public private(set) var digits = ""
    /// Drop-frame governs the separator this field emits, and therefore whether
    /// the parser applies drop-frame legality. Carried rather than inferred so a
    /// 29.97 asset can still be addressed in non-drop notation.
    public var usesDropFrame: Bool

    public init(usesDropFrame: Bool = false) {
        self.usesDropFrame = usesDropFrame
    }

    // MARK: - Editing

    public mutating func begin() {
        isActive = true
        digits = ""
    }

    public mutating func cancel() {
        isActive = false
        digits = ""
    }

    /// Accepts one character. Returns false for anything that is not a digit so
    /// the caller can let an unhandled key fall through to its normal binding —
    /// swallowing every keystroke while entry is open would strand the viewer.
    @discardableResult
    public mutating func input(_ character: Character) -> Bool {
        guard isActive, character.isNumber, character.isASCII else { return false }
        if digits.count == Self.digitCapacity {
            // Full: the oldest digit falls off the left, so entry keeps flowing
            // instead of silently ignoring keys.
            digits.removeFirst()
        }
        digits.append(character)
        return true
    }

    @discardableResult
    public mutating func backspace() -> Bool {
        guard isActive, !digits.isEmpty else { return false }
        digits.removeLast()
        return true
    }

    // MARK: - Output

    /// The text to hand to StudioTimecodeConverter, or nil when nothing was
    /// typed. Emitted in full separated form rather than as bare digits so the
    /// drop-frame separator — and therefore drop-frame legality checking — is
    /// explicit at the boundary.
    public func commitText() -> String? {
        guard isActive, !digits.isEmpty else { return nil }
        let padded = String(repeating: "0", count: Self.digitCapacity - digits.count) + digits
        let fields = stride(from: 0, to: Self.digitCapacity, by: 2).map { offset -> String in
            let start = padded.index(padded.startIndex, offsetBy: offset)
            let end = padded.index(start, offsetBy: 2)
            return String(padded[start..<end])
        }
        let framesSeparator = usesDropFrame ? ";" : ":"
        return "\(fields[0]):\(fields[1]):\(fields[2])\(framesSeparator)\(fields[3])"
    }

    /// Right-aligned digits in HH:MM:SS:FF shape, with a caret marking the slot
    /// that becomes occupied NEXT.
    ///
    /// The caret travels LEFT as the run grows, which looks backwards until you
    /// remember that digits always enter at the right and shift everything
    /// along: after typing "4" the caret sits one place left of it, because that
    /// is exactly where the 4 is about to move to. A full field has no caret,
    /// since every slot already holds a digit.
    public var displayText: String {
        var slots = [Character](repeating: Self.placeholder, count: Self.digitCapacity)
        let typed = Array(digits)
        for (offset, character) in typed.reversed().enumerated() {
            slots[Self.digitCapacity - 1 - offset] = character
        }
        if typed.count < Self.digitCapacity {
            slots[Self.digitCapacity - 1 - typed.count] = Self.caret
        }
        let framesSeparator = usesDropFrame ? ";" : ":"
        return "\(slots[0])\(slots[1]):\(slots[2])\(slots[3]):\(slots[4])\(slots[5])"
            + "\(framesSeparator)\(slots[6])\(slots[7])"
    }

    public var snapshot: StudioTimecodeFieldSnapshot? {
        guard isActive else { return nil }
        return StudioTimecodeFieldSnapshot(displayText: displayText, digits: digits)
    }
}
