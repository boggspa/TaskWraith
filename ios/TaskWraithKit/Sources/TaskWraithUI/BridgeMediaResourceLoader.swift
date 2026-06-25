// BridgeMediaResourceLoader — feed AVPlayer a large transcript media asset by
// pulling it in 448 KiB chunks over the E2EE bridge.
//
// AVURLAsset can't speak our bridge protocol, so we hand it a custom-scheme URL
// (`twbridge-media://…`) and intercept every load via an
// AVAssetResourceLoaderDelegate. For each AVAssetResourceLoadingRequest we learn
// the asset's total size from the first slice, fill AVFoundation's
// content-information, then stream the requested byte window chunk-by-chunk,
// respecting the server's 448 KiB clamp.
//
// The whole file is gated `#if canImport(AVFoundation)` (NOT `#if os(iOS)`):
// AVAssetResourceLoaderDelegate is cross-platform, so this compiles under macOS
// `swift build` too — which means its Swift-6 strict-concurrency is
// compile-checked here, not just on an iOS archive.
//
// Concurrency model: AVFoundation drives the delegate from its own (arbitrary)
// queues. The loader is `@unchecked Sendable` because it owns mutable state
// (`inflight`) that crosses isolation; every touch of that state goes through a
// private NSLock via a tiny `write` helper (the PingContinuationGate idiom).
// Each loading request runs in its own detached `Task` keyed by
// `ObjectIdentifier(loadingRequest)`; cancel tears it down. The fetch closure is
// `@Sendable` and captures the `@MainActor` `RemoteSessionModel` (legal — a
// @MainActor class is implicitly Sendable).

#if canImport(AVFoundation)

import Foundation
@preconcurrency import AVFoundation
import UniformTypeIdentifiers
import TaskWraithKit

/// Builds + parses the custom-scheme URLs that route an AVURLAsset through the
/// bridge loader. The three ids are carried as percent-encoded path segments so
/// arbitrary characters (`/`, `?`, `#`, `%`) survive a round-trip.
public enum BridgeMediaURL {
    /// The custom scheme AVFoundation must NOT try to load itself — it triggers
    /// `shouldWaitForLoadingOfRequestedResource` instead.
    public static let scheme = "twbridge-media"

    /// RFC-3986 unreserved set (`ALPHA / DIGIT / "-" / "." / "_" / "~"`). Every
    /// other byte — including `/`, `?`, `#`, `%` — is percent-escaped, so an id
    /// containing path/query delimiters can't break the URL structure.
    private static let unreserved: CharacterSet = {
        var set = CharacterSet()
        set.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return set
    }()

    /// `twbridge-media://media/<threadId>/<rowId>/<mediaId>`, each id
    /// percent-encoded. We set `percentEncodedPath` directly (NOT `.path`,
    /// which would re-encode our `%` escapes into `%25`).
    public static func make(threadId: String, rowId: String, mediaId: String) -> URL {
        let segs = [threadId, rowId, mediaId].map {
            $0.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = "media"
        components.percentEncodedPath = "/" + segs.joined(separator: "/")
        // Force-unwrap is safe: scheme+host+a well-formed percent-encoded path
        // always yields a valid URL.
        return components.url!
    }

    /// Inverse of ``make(threadId:rowId:mediaId:)``. `url.pathComponents` is
    /// already percent-decoded by Foundation, so the ids come back intact; the
    /// leading "/" component is dropped. Returns nil unless exactly three
    /// segments remain.
    public static func parse(_ url: URL) -> (threadId: String, rowId: String, mediaId: String)? {
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 3 else { return nil }
        return (parts[0], parts[1], parts[2])
    }
}

/// AVAssetResourceLoaderDelegate that serves a single media asset from the
/// bridge in 448 KiB chunks. Construct one per asset (the fetch closure already
/// binds the thread/row/media); attach via
/// `asset.resourceLoader.setDelegate(loader, queue: loader.deliveryQueue)`.
public final class BridgeMediaResourceLoader: NSObject,
    AVAssetResourceLoaderDelegate, @unchecked Sendable
{
    /// Fetch one byte slice starting at `offset` (length capped by the caller).
    /// Returns the bytes plus the asset's total size. May return fewer than
    /// `length` bytes (server clamp) — callers advance by `data.count`.
    private let fetchChunk: @Sendable (_ offset: Int, _ length: Int) async throws -> (data: Data, totalBytes: Int)
    /// MIME of the asset, mapped to a UTType for AVFoundation's content-info.
    private let mimeType: String
    /// Server hard-clamps each slice to 448 KiB; request at most that.
    private let chunkSize: Int = 448 * 1024

    /// The queue AVFoundation should call the delegate on. Public so the caller
    /// passes it to `setDelegate(_:queue:)`.
    public let deliveryQueue = DispatchQueue(label: "tw.bridge-media.loader")

    /// Guards `inflight`, which AVFoundation touches from its own queues and the
    /// request Tasks touch from theirs (PingContinuationGate idiom — a plain
    /// NSLock, no actor hop on the hot path).
    private let lock = NSLock()
    private var inflight: [ObjectIdentifier: Task<Void, Never>] = [:]

    public init(
        mimeType: String,
        fetchChunk: @escaping @Sendable (_ offset: Int, _ length: Int) async throws -> (data: Data, totalBytes: Int)
    ) {
        self.mimeType = mimeType
        self.fetchChunk = fetchChunk
        super.init()
    }

    // MARK: - Locked state helper (PingContinuationGate style)

    @discardableResult
    private func write<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    private func remove(_ key: ObjectIdentifier) {
        write { inflight.removeValue(forKey: key) }
    }

    // MARK: - AVAssetResourceLoaderDelegate

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        let key = ObjectIdentifier(loadingRequest)
        let task = Task { [weak self] in
            await self?.service(loadingRequest)
            self?.remove(key)
        }
        write { inflight[key] = task }
        return true
    }

    public func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        let task = write { inflight.removeValue(forKey: ObjectIdentifier(loadingRequest)) }
        task?.cancel()
    }

    // MARK: - Servicing one loading request

    private func service(_ loadingRequest: AVAssetResourceLoadingRequest) async {
        do {
            let dataRequest = loadingRequest.dataRequest

            guard let dataRequest else {
                // Info-only request (no byte range): fetch a 1-byte probe purely
                // to learn the asset's total size, fill content-info, finish.
                let (_, total) = try await fetchChunk(0, 1)
                fillContentInformation(loadingRequest, total: total)
                loadingRequest.finishLoading()
                return
            }

            // Learn the total from the first slice. firstWant honours what AVF
            // asked for (clamped to one chunk, floored at 1 so we never request
            // a zero-length slice for a degenerate requestedLength==0).
            let startOff = Int(dataRequest.currentOffset)
            let firstWant = min(chunkSize, max(Int(dataRequest.requestedLength), 1))
            let (firstData, total) = try await fetchChunk(startOff, firstWant)

            fillContentInformation(loadingRequest, total: total)

            // The closed-open window AVF actually wants out of [0, total].
            let window = MediaRangePlanner.window(
                currentOffset: startOff,
                requestedOffset: Int(dataRequest.requestedOffset),
                requestedLength: dataRequest.requestedLength,
                toEnd: dataRequest.requestsAllDataToEndOfResource,
                totalBytes: total)

            // The first slice starts at startOff == window.start: deliver it if
            // it lands in-window, then advance by however much actually arrived
            // (the server may clamp shorter than firstWant).
            var offset = startOff
            if !firstData.isEmpty && offset >= window.start && offset < window.endExclusive {
                dataRequest.respond(with: firstData)
                offset += firstData.count
            }

            // Stream the remainder chunk-by-chunk to the window end.
            while true {
                try Task.checkCancellation()
                let want = MediaRangePlanner.nextChunkLength(
                    offset: offset, window: window, chunkSize: chunkSize)
                if want == 0 { break }
                let (data, _) = try await fetchChunk(offset, want)
                if data.isEmpty { break }  // server gave nothing — avoid a spin.
                dataRequest.respond(with: data)
                offset += data.count  // advance by ACTUAL bytes, not `want`.
            }

            loadingRequest.finishLoading()
        } catch is CancellationError {
            // AVFoundation owns the request post-didCancel — touching it would
            // race/assert. Say nothing.
        } catch {
            loadingRequest.finishLoading(with: error)
        }
    }

    /// Fills `contentInformationRequest` (when present) so AVFoundation knows the
    /// asset's type, length, and that byte-range access is supported.
    private func fillContentInformation(
        _ loadingRequest: AVAssetResourceLoadingRequest, total: Int
    ) {
        guard let info = loadingRequest.contentInformationRequest else { return }
        info.contentType = (UTType(mimeType: mimeType) ?? .data).identifier
        info.contentLength = Int64(total)
        info.isByteRangeAccessSupported = true
    }
}

#endif
