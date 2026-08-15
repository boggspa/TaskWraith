import CoreMedia
import Foundation

/// Decides whether a compressed sample is a legal GOP restart point.
///
/// `kCMSampleAttachmentKey_DependsOnOthers` is load-bearing when present.
/// When it is *absent* — the 22,800-frame acceptance fixture omits it — the
/// CoreMedia convention "no attachment means sync" is a lie: every sample
/// looks intra, every backward seek "restarts" at a P-frame, and VideoToolbox
/// decodes that slice against the previous seek's DPB. That is the packaged
/// stripe/checker trail. Silent attachments fall through to the bitstream.
public enum StudioSyncSample {
    public static func isSync(_ sampleBuffer: CMSampleBuffer) -> Bool {
        let attachments = (
            CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer, createIfNecessary: false
            ) as? [[CFString: Any]]
        )?.first
        // Explicit DependsOnOthers is trustworthy (generated fixtures set it).
        // Silent attachments are not: missing stss makes NotSync look like
        // intra for every sample. Inspect the bitstream before believing that.
        if let dependsOnOthers = attachments?[kCMSampleAttachmentKey_DependsOnOthers] as? Bool {
            return !dependsOnOthers
        }
        if canInspectBitstream(sampleBuffer) {
            return bitstreamContainsIndependentCodedSlice(sampleBuffer)
        }
        if let notSync = attachments?[kCMSampleAttachmentKey_NotSync] as? Bool {
            return !notSync
        }
        return false
    }

    private static func canInspectBitstream(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else {
            return false
        }
        switch CMFormatDescriptionGetMediaSubType(format) {
        case kCMVideoCodecType_H264, kCMVideoCodecType_HEVC:
            return CMSampleBufferGetDataBuffer(sampleBuffer) != nil
        default:
            return false
        }
    }

    /// True when the payload contains an H.264 IDR or HEVC IRAP slice.
    /// Used only when CoreMedia attachments are silent.
    public static func bitstreamContainsIndependentCodedSlice(
        _ sampleBuffer: CMSampleBuffer
    ) -> Bool {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer),
            let block = CMSampleBufferGetDataBuffer(sampleBuffer)
        else {
            return false
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else { return false }
        var bytes = [UInt8](repeating: 0, count: length)
        guard
            CMBlockBufferCopyDataBytes(
                block, atOffset: 0, dataLength: length, destination: &bytes
            ) == noErr
        else {
            return false
        }

        let codec = CMFormatDescriptionGetMediaSubType(format)
        switch codec {
        case kCMVideoCodecType_H264:
            return containsNAL(bytes, headerLength: h264NALHeaderLength(format)) { header in
                (header & 0x1F) == 5
            }
        case kCMVideoCodecType_HEVC:
            return containsNAL(bytes, headerLength: hevcNALHeaderLength(format)) { header in
                let type = (header >> 1) & 0x3F
                return type == 16 || type == 17 || type == 18 || type == 19
                    || type == 20 || type == 21
            }
        default:
            return false
        }
    }

    private static func h264NALHeaderLength(_ format: CMFormatDescription) -> Int {
        var nalHeaderLength: Int32 = 4
        let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: nil,
            parameterSetSizeOut: nil,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: &nalHeaderLength
        )
        return status == noErr ? max(1, Int(nalHeaderLength)) : 4
    }

    private static func hevcNALHeaderLength(_ format: CMFormatDescription) -> Int {
        var nalHeaderLength: Int32 = 4
        let status = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
            format,
            parameterSetIndex: 0,
            parameterSetPointerOut: nil,
            parameterSetSizeOut: nil,
            parameterSetCountOut: nil,
            nalUnitHeaderLengthOut: &nalHeaderLength
        )
        return status == noErr ? max(1, Int(nalHeaderLength)) : 4
    }

    private static func containsNAL(
        _ bytes: [UInt8],
        headerLength: Int,
        headerMatches: (UInt8) -> Bool
    ) -> Bool {
        if headerLength > 0, scanAVCC(bytes, headerLength: headerLength, headerMatches) {
            return true
        }
        return scanAnnexB(bytes, headerMatches)
    }

    private static func scanAVCC(
        _ bytes: [UInt8],
        headerLength: Int,
        _ headerMatches: (UInt8) -> Bool
    ) -> Bool {
        var offset = 0
        while offset + headerLength < bytes.count {
            var nalLength = 0
            for i in 0..<headerLength {
                nalLength = (nalLength << 8) | Int(bytes[offset + i])
            }
            offset += headerLength
            guard nalLength > 0, offset + nalLength <= bytes.count else { return false }
            if headerMatches(bytes[offset]) { return true }
            offset += nalLength
        }
        return false
    }

    private static func scanAnnexB(
        _ bytes: [UInt8],
        _ headerMatches: (UInt8) -> Bool
    ) -> Bool {
        var i = 0
        while i + 3 < bytes.count {
            let start: Int
            if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 0,
                i + 4 < bytes.count, bytes[i + 3] == 1
            {
                start = i + 4
            } else if bytes[i] == 0, bytes[i + 1] == 0, bytes[i + 2] == 1 {
                start = i + 3
            } else {
                i += 1
                continue
            }
            if start < bytes.count, headerMatches(bytes[start]) { return true }
            i = start
        }
        return false
    }
}
