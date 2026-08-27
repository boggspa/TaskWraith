import Foundation
import SwiftUI
import TaskWraithKit

#if canImport(Combine)
    import Combine
#endif

// MARK: - Composer inbox (Foundation; UIKit is only needed to render the image)

/// One annotated screenshot waiting for the composer of a specific thread.
/// `imageData` is the flattened annotated bitmap when markup is present, or
/// the original FullSizeMediaAssembler / photo bytes when it is not.
/// `payload.attachmentId` is the id the composer will stamp onto the ordinary
/// image-attachment dict; a payload whose id cannot resolve is never enqueued.
public struct ComposerMarkupInboxItem: Equatable, Sendable {
    public let name: String
    public let imageData: Data
    public let payload: MarkupPayload?

    public init(name: String, imageData: Data, payload: MarkupPayload?) {
        self.name = name
        self.imageData = imageData
        self.payload = payload
    }

    /// Flatten non-empty markup into the bytes that will be attached. Identity
    /// when there are no primitives. Throws rather than enqueueing a clean
    /// screenshot that pretends to be annotated.
    public static func prepared(
        name: String,
        imageData: Data,
        payload: MarkupPayload?
    ) throws -> ComposerMarkupInboxItem {
        let bytes: Data
        if let payload, !payload.primitives.isEmpty {
            bytes = try MarkupFlattener.flatten(
                imageData: imageData, primitives: payload.primitives)
        } else {
            bytes = imageData
        }
        return ComposerMarkupInboxItem(name: name, imageData: bytes, payload: payload)
    }
}

/// Bounded consume of a thread's inbox. Leftovers stay queued so a full
/// composer cannot silently destroy annotated screenshots.
public struct ComposerMarkupTakeResult: Equatable, Sendable {
    public let taken: [ComposerMarkupInboxItem]
    public let leftoverCount: Int
    public let limit: Int
}

/// Thread-scoped pending attachments from the full-size annotate flow.
/// Composer drains this; the preview sheet enqueues. An empty `threadId` is
/// refused — that is the same class of defect as an unresolvable attachmentId.
@MainActor
public final class ComposerMarkupInbox: ObservableObject {
    public static let shared = ComposerMarkupInbox()

    @Published public private(set) var generation: UInt64 = 0
    private var pending: [String: [ComposerMarkupInboxItem]] = [:]

    public init() {}

    public func enqueue(threadId: String, item: ComposerMarkupInboxItem) {
        let threadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !threadId.isEmpty, !item.imageData.isEmpty else { return }
        if let payload = item.payload {
            let id = payload.attachmentId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { return }
        }
        pending[threadId, default: []].append(item)
        generation += 1
    }

    /// Consume at most `limit` items. Leftovers stay queued. `limit == 0`
    /// consumes nothing and reports how many were waiting — a full composer
    /// must lose nothing.
    public func take(threadId: String, limit: Int) -> ComposerMarkupTakeResult {
        let threadId = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
        let capped = max(0, limit)
        guard !threadId.isEmpty else {
            return ComposerMarkupTakeResult(taken: [], leftoverCount: 0, limit: capped)
        }
        let existing = pending[threadId] ?? []
        guard !existing.isEmpty else {
            return ComposerMarkupTakeResult(taken: [], leftoverCount: 0, limit: capped)
        }
        if capped == 0 {
            return ComposerMarkupTakeResult(
                taken: [], leftoverCount: existing.count, limit: 0)
        }
        let taken = Array(existing.prefix(capped))
        let leftover = Array(existing.dropFirst(taken.count))
        if leftover.isEmpty {
            pending.removeValue(forKey: threadId)
        } else {
            pending[threadId] = leftover
        }
        return ComposerMarkupTakeResult(
            taken: taken, leftoverCount: leftover.count, limit: capped)
    }

    public func drain(threadId: String) -> [ComposerMarkupInboxItem] {
        take(threadId: threadId, limit: Int.max).taken
    }
}

/// Stamps markup onto the existing image-attachment wire dict, or returns the
/// dict unchanged. If stamp would emit an id that does not resolve, markup is
/// dropped and the image still goes — an ordinary attachment beats a dangling id.
public enum ComposerMarkupWiring {
    public static let maxComposerImageAttachments = 15

    public struct AbsorbResult: Equatable, Sendable {
        public let taken: [ComposerMarkupInboxItem]
        public let leftoverCount: Int
        public let freeSlots: Int
        public let capacity: Int

        /// Nil when every waiting item fit. Names the leftovers otherwise —
        /// a silent discard is the defect this round keeps removing.
        public var refusalMessage: String? {
            guard leftoverCount > 0 else { return nil }
            if freeSlots == 0 {
                return
                    "Not attached. Composer already has \(capacity) images, so "
                    + "\(leftoverCount) annotated screenshot(s) stayed in the inbox."
            }
            return
                "Attached \(taken.count) annotated screenshot(s). \(leftoverCount) stayed "
                + "in the inbox because the composer is at its \(capacity)-image limit."
        }
    }

    /// Take a bounded batch from the inbox. Leftovers stay queued. The caller
    /// must surface `refusalMessage` rather than deciding the overflow did
    /// not matter.
    @MainActor
    public static func absorb(
        from inbox: ComposerMarkupInbox,
        threadId: String,
        currentlyAttached: Int,
        capacity: Int = maxComposerImageAttachments
    ) -> AbsorbResult {
        let freeSlots = max(0, capacity - currentlyAttached)
        let batch = inbox.take(threadId: threadId, limit: freeSlots)
        return AbsorbResult(
            taken: batch.taken,
            leftoverCount: batch.leftoverCount,
            freeSlots: freeSlots,
            capacity: capacity)
    }

    public static func bindMarkup(_ markup: MarkupPayload?, onto wire: [String: Any]) -> [String: Any] {
        guard let markup else { return withoutId(wire) }
        var candidate = wire
        candidate["id"] = markup.attachmentId
        if let stamped = MarkupAttachmentAssembly.stamp(markup, onto: candidate) {
            return stamped
        }
        return withoutId(wire)
    }

    private static func withoutId(_ wire: [String: Any]) -> [String: Any] {
        var plain = wire
        plain.removeValue(forKey: "id")
        plain.removeValue(forKey: "markup")
        return plain
    }
}

#if canImport(UIKit)
    import UIKit

    struct ComposerQueuedImage {
        var name: String
        var image: UIImage
        var markup: MarkupPayload? = nil
    }

    extension ComposerMarkupWiring {
        static func encode(_ item: ComposerQueuedImage) -> [String: Any]? {
            guard let wire = twEncodeImageAttachment(item.image, name: item.name) else {
                return nil
            }
            return bindMarkup(item.markup, onto: wire)
        }

        static func queuedImages(from inbox: [ComposerMarkupInboxItem]) -> [ComposerQueuedImage] {
            inbox.compactMap { item in
                guard let image = UIImage(data: item.imageData) else { return nil }
                return ComposerQueuedImage(name: item.name, image: image, markup: item.payload)
            }
        }
    }

    /// Annotate an existing full-size image. Not a canvas: gestures produce
    /// normalized coordinates, and "Add to prompt" flattens those strokes into
    /// the attached bitmap and keeps the coordinate payload alongside it.
    struct MarkupCaptureView: View {
        enum Tool: String, CaseIterable, Identifiable {
            case stroke, rect, arrow
            var id: String { rawValue }
            var label: String {
                switch self {
                case .stroke: return "Stroke"
                case .rect: return "Rect"
                case .arrow: return "Arrow"
                }
            }
            var systemImage: String {
                switch self {
                case .stroke: return "scribble"
                case .rect: return "rectangle"
                case .arrow: return "arrow.up.right"
                }
            }
        }

        let image: UIImage
        let imageData: Data
        let suggestedName: String
        let threadId: String
        var onAttached: () -> Void
        var onCancel: () -> Void

        @State private var session: MarkupCaptureSession
        @State private var tool: Tool = .stroke
        @State private var color: MarkupColor = .red
        @State private var inProgress: [MarkupPoint] = []
        @State private var attachFailed = false

        init(
            image: UIImage,
            imageData: Data,
            suggestedName: String,
            threadId: String,
            onAttached: @escaping () -> Void,
            onCancel: @escaping () -> Void
        ) {
            self.image = image
            self.imageData = imageData
            self.suggestedName = suggestedName
            self.threadId = threadId
            self.onAttached = onAttached
            self.onCancel = onCancel
            let pixel = image.size
            _session = State(
                initialValue: MarkupCaptureSession(
                    space: MarkupCoordinateSpace(
                        viewWidth: 1,
                        viewHeight: 1,
                        imageWidth: Double(pixel.width),
                        imageHeight: Double(pixel.height))))
        }

        var body: some View {
            NavigationStack {
                GeometryReader { geo in
                    ZStack {
                        Color.black.ignoresSafeArea()
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                        MarkupPrimitivesLayer(
                            primitives: session.primitives,
                            inProgress: inProgress,
                            tool: tool,
                            color: color,
                            space: session.space)
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .contentShape(Rectangle())
                    .gesture(dragGesture)
                    .onAppear { updateSpace(geo.size) }
                    .onChange(of: geo.size) { _, size in updateSpace(size) }
                }
                .background(Color.black)
                .navigationTitle("Annotate")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onCancel)
                    }
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 10) {
                            ForEach(Tool.allCases) { item in
                                Button {
                                    tool = item
                                    inProgress = []
                                } label: {
                                    Image(systemName: item.systemImage)
                                        .foregroundStyle(tool == item ? Color.white : Color.white.opacity(0.45))
                                }
                                .accessibilityLabel(item.label)
                            }
                            colorDot(MarkupColor.red)
                            colorDot(MarkupColor.green)
                            colorDot(MarkupColor.blue)
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add to prompt", action: attach)
                    }
                    ToolbarItemGroup(placement: .bottomBar) {
                        Button {
                            session.undoLast()
                            inProgress = []
                        } label: {
                            Label("Undo", systemImage: "arrow.uturn.backward")
                        }
                        .disabled(session.primitives.isEmpty && inProgress.isEmpty)
                        Spacer()
                    }
                }
                .alert("Could not attach image", isPresented: $attachFailed) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(
                        "The annotated screenshot could not be queued. Flattened images cannot exceed 8 MB."
                    )
                }
            }
        }

        private func colorDot(_ value: MarkupColor) -> some View {
            Button {
                color = value
            } label: {
                Circle()
                    .fill(Color(red: value.r, green: value.g, blue: value.b))
                    .frame(width: 14, height: 14)
                    .overlay(
                        Circle().strokeBorder(
                            color == value ? Color.white : Color.clear, lineWidth: 2))
            }
            .accessibilityLabel(value == .red ? "Red" : value == .green ? "Green" : "Blue")
        }

        private var dragGesture: some Gesture {
            DragGesture(minimumDistance: 0)
                .onChanged { value in
                    let point = MarkupPoint(
                        x: Double(value.location.x), y: Double(value.location.y))
                    switch tool {
                    case .stroke:
                        inProgress.append(point)
                    case .rect, .arrow:
                        let start = MarkupPoint(
                            x: Double(value.startLocation.x), y: Double(value.startLocation.y))
                        inProgress = [start, point]
                    }
                }
                .onEnded { _ in
                    commitInProgress()
                }
        }

        private func updateSpace(_ size: CGSize) {
            session.space = MarkupCoordinateSpace(
                viewWidth: Double(size.width),
                viewHeight: Double(size.height),
                imageWidth: Double(image.size.width),
                imageHeight: Double(image.size.height))
        }

        private func commitInProgress() {
            let points = inProgress
            inProgress = []
            guard session.space.isUsable else { return }
            do {
                switch tool {
                case .stroke:
                    try session.addStroke(viewPoints: points, color: color, thickness: 3)
                case .rect:
                    guard points.count >= 2 else { return }
                    try session.addRect(
                        start: points[0], end: points[points.count - 1], color: color, thickness: 3)
                case .arrow:
                    guard points.count >= 2 else { return }
                    try session.addArrow(
                        start: points[0], end: points[points.count - 1], color: color, thickness: 3)
                }
            } catch {
                // Invalid thickness/empty stroke is a no-op; keep prior primitives.
            }
        }

        private func attach() {
            let trimmedThread = threadId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmedThread.isEmpty, !imageData.isEmpty else {
                attachFailed = true
                return
            }
            let attachmentId = UUID().uuidString
            let payload: MarkupPayload?
            if session.primitives.isEmpty {
                payload = nil
            } else {
                do {
                    payload = try session.makePayload(attachmentId: attachmentId)
                } catch {
                    attachFailed = true
                    return
                }
            }
            let item: ComposerMarkupInboxItem
            do {
                item = try ComposerMarkupInboxItem.prepared(
                    name: suggestedName.isEmpty ? "screenshot.jpg" : suggestedName,
                    imageData: imageData,
                    payload: payload)
            } catch {
                attachFailed = true
                return
            }
            ComposerMarkupInbox.shared.enqueue(threadId: trimmedThread, item: item)
            onAttached()
        }
    }

    /// Draws committed primitives plus the in-progress gesture in view space.
    private struct MarkupPrimitivesLayer: View {
        let primitives: [MarkupPrimitive]
        let inProgress: [MarkupPoint]
        let tool: MarkupCaptureView.Tool
        let color: MarkupColor
        let space: MarkupCoordinateSpace

        var body: some View {
            ZStack {
                ForEach(Array(primitives.enumerated()), id: \.offset) { _, primitive in
                    primitiveOverlay(primitive)
                }
                inProgressOverlay
            }
            .allowsHitTesting(false)
        }

        @ViewBuilder
        private func primitiveOverlay(_ primitive: MarkupPrimitive) -> some View {
            switch primitive {
            case .stroke(let points, let color, let thickness):
                strokePath(points.map { space.viewPoint(from: $0) }, color: color, thickness: thickness)
            case .rect(let start, let end, let color, let thickness):
                let a = space.viewPoint(from: start)
                let b = space.viewPoint(from: end)
                Rectangle()
                    .stroke(
                        Color(red: color.r, green: color.g, blue: color.b, opacity: color.a),
                        lineWidth: thickness)
                    .frame(width: abs(a.x - b.x), height: abs(a.y - b.y))
                    .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
            case .arrow(let start, let end, let color, let thickness):
                strokePath(
                    [space.viewPoint(from: start), space.viewPoint(from: end)],
                    color: color, thickness: thickness)
            }
        }

        @ViewBuilder
        private var inProgressOverlay: some View {
            switch tool {
            case .stroke:
                strokePath(inProgress, color: color, thickness: 3)
            case .rect:
                if inProgress.count >= 2 {
                    let a = inProgress[0]
                    let b = inProgress[inProgress.count - 1]
                    Rectangle()
                        .stroke(
                            Color(red: color.r, green: color.g, blue: color.b, opacity: color.a),
                            lineWidth: 3)
                        .frame(width: abs(a.x - b.x), height: abs(a.y - b.y))
                        .position(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                }
            case .arrow:
                if inProgress.count >= 2 {
                    strokePath(
                        [inProgress[0], inProgress[inProgress.count - 1]],
                        color: color, thickness: 3)
                }
            }
        }

        private func strokePath(
            _ points: [MarkupPoint],
            color: MarkupColor,
            thickness: Double
        ) -> some View {
            Path { path in
                guard let first = points.first else { return }
                path.move(to: CGPoint(x: first.x, y: first.y))
                for point in points.dropFirst() {
                    path.addLine(to: CGPoint(x: point.x, y: point.y))
                }
            }
            .stroke(
                Color(red: color.r, green: color.g, blue: color.b, opacity: color.a),
                style: StrokeStyle(lineWidth: thickness, lineCap: .round, lineJoin: .round))
        }
    }
#endif
