import Foundation

/// Swift mirror of the host's normative media identity.
///
/// src/main/studio/StudioProtocol.ts is NORMATIVE and this conforms to it — never
/// the reverse. Field names and the mediaKind vocabulary must match exactly, or
/// an open_media notification silently fails to parse and the companion simply
/// never loads anything.
///
/// OWNERSHIP OF THE PATH JAIL IS THE HOST'S. StudioMediaAsset.path is documented
/// there as "canonical real path returned by the host after its media-root
/// check": the host resolves symlinks, enforces allowedMediaRoots and rejects
/// non-regular files before it ever emits this. The companion therefore opens
/// exactly the path it is given and does NOT re-implement that policy — a second
/// copy of a security check is a second thing to drift. The loader's own checks
/// below are existence sanity so a missing file fails as a typed error rather
/// than an opaque AVFoundation one; they are not an access-control boundary.
public enum StudioMediaKind: String, Equatable, Sendable {
    case video
}

public struct StudioMediaAsset: Equatable, Sendable {
    /// Mirrors STUDIO_OPEN_MEDIA_SCHEMA_VERSION, which versions the openMedia
    /// payload independently of protocol v1.
    public static let openMediaSchemaVersion = 1

    public let assetId: String
    public let path: String
    public let mediaKind: StudioMediaKind

    public init(assetId: String, path: String, mediaKind: StudioMediaKind = .video) {
        self.assetId = assetId
        self.path = path
        self.mediaKind = mediaKind
    }

    /// Decodes the `asset` object exactly as the host serialises it.
    public static func decode(from object: [String: Any]) -> StudioMediaAsset? {
        guard
            let assetId = object["assetId"] as? String,
            let path = object["path"] as? String,
            let rawKind = object["mediaKind"] as? String,
            let mediaKind = StudioMediaKind(rawValue: rawKind)
        else {
            return nil
        }
        return StudioMediaAsset(assetId: assetId, path: path, mediaKind: mediaKind)
    }

    /// Extracts the asset from a studio/editCommitted `op` payload, returning nil
    /// for any operation that is not an open_media. Insert-range commits flow
    /// through the same notification, so the type discriminator is load-bearing.
    public static func fromDocumentOperation(_ operation: [String: Any]) -> StudioMediaAsset? {
        guard operation["type"] as? String == "open_media" else { return nil }
        guard let assetObject = operation["asset"] as? [String: Any] else { return nil }
        return decode(from: assetObject)
    }
}
