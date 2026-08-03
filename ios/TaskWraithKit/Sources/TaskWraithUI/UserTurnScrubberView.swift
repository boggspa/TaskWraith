// Compact user-turn scrubber surface.
//
// Renders only when `UserTurnScrubber.isVisible` (two or more loaded user turns).
// Emits explicit `UserTurnScrubberJumpIntent` — host owns scroll anchoring.

import SwiftUI

public struct UserTurnScrubberView: View {
    public var markers: [UserTurnScrubberMarker]
    public var activeMarkerKey: String?
    public var frameHeight: CGFloat
    public var onJump: (UserTurnScrubberJumpIntent) -> Void

    public init(
        markers: [UserTurnScrubberMarker],
        activeMarkerKey: String? = nil,
        frameHeight: CGFloat = 220,
        onJump: @escaping (UserTurnScrubberJumpIntent) -> Void
    ) {
        self.markers = markers
        self.activeMarkerKey = activeMarkerKey
        self.frameHeight = frameHeight
        self.onJump = onJump
    }

    public var body: some View {
        if !UserTurnScrubber.isVisible(markers: markers) {
            EmptyView()
        } else {
            let layout = UserTurnScrubber.layoutMarkers(
                markers,
                frameHeight: Double(frameHeight)
            )
            VStack(spacing: 6) {
                Button {
                    onJump(.begin)
                } label: {
                    Image(systemName: "arrow.up.to.line")
                        .font(.caption.weight(.semibold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Jump to beginning of thread")

                ZStack(alignment: .top) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.18))
                        .frame(width: 3)
                        .frame(maxHeight: .infinity)

                    ForEach(Array(zip(markers, layout)), id: \.0.key) { marker, point in
                        let isActive = marker.key == activeMarkerKey
                        Button {
                            onJump(UserTurnScrubber.jumpIntent(for: marker))
                        } label: {
                            Capsule()
                                .fill(isActive ? Color.accentColor : Color.secondary.opacity(0.75))
                                .frame(width: isActive ? 14 : 10, height: 3)
                        }
                        .buttonStyle(.plain)
                        .offset(y: CGFloat(point.topPx))
                        .accessibilityLabel(
                            "Jump to user message \(marker.ordinal): \(marker.title)"
                        )
                    }
                }
                .frame(width: 28, height: frameHeight, alignment: .top)

                Button {
                    onJump(.end)
                } label: {
                    Image(systemName: "arrow.down.to.line")
                        .font(.caption.weight(.semibold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Jump to latest message")
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("User turn scrubber")
        }
    }
}
