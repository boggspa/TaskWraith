import Foundation
import AVFoundation
import AudioToolbox
import TaskWraithAudioKernel

/// Native offline multitrack audio mixdown for `audio.mixdown` (S4 of the
/// native AV pipeline).
///
/// Pipeline: decode each source (WAV/M4A) into planar float32 via `AVAudioFile`
/// at the file's native rate → gather the planar channel pointers → hand them
/// to the pure-C `tw_mix` kernel (gain/pan/fade/placement/soft-limit) → write
/// the summed planar output to `outputPath` as 16-bit PCM WAV (TPDF-dithered)
/// or AAC `.m4a` via `ExtAudioFile`.
///
/// We do NOT return bytes — like the video producers, the TS side reads + deletes
/// the file at `outputPath`. We return ONLY metadata (the locked Result shape).
///
/// v1 constraints (matching the contract): every source must ALREADY be at the
/// requested `sampleRate` (no resample); a source may have at most 2 channels;
/// the output is mono or stereo. Sources are TS-path-jailed — we trust the paths.
enum AudioMixer {

    /// Mix failures surfaced to the RPC boundary. `.badInput` → `invalidParams`
    /// (caller-correctable: empty tracks, a sample-rate-mismatched / >2ch /
    /// unreadable source, or a decode that exceeds the memory cap);
    /// `.mixFailed` → `internalError` (the inputs looked valid but the kernel or
    /// the writer could not complete). Mirrors `VideoEncodeError`'s mapping.
    enum AudioMixError: Error, CustomStringConvertible {
        case badInput(String)
        case mixFailed(String)

        var description: String {
            switch self {
            case .badInput(let m): return m
            case .mixFailed(let m): return m
            }
        }
    }

    /// Decoded per-track placement params (the JSON-RPC shape, post-defaulting).
    struct AudioMixTrack: Sendable {
        let sourcePath: String
        let gainDb: Float
        let pan: Float
        let offsetMs: Double
        let fadeInMs: Double
        let fadeOutMs: Double
    }

    /// `audio.mixdown` result. FIXED shape (the TS staging-read path consumes
    /// these exact keys/types): `durationMs`(Int) / `sampleRate`(Int) /
    /// `channels`(Int) / `codec`(String, "pcm_s16le" | "aac") / `trackCount`(Int).
    struct Result: Sendable {
        let durationMs: Int
        let sampleRate: Int
        let channels: Int
        let codec: String
        let trackCount: Int

        func toJSONObject() -> [String: Any] {
            return [
                "durationMs": durationMs,
                "sampleRate": sampleRate,
                "channels": channels,
                "codec": codec,
                "trackCount": trackCount
            ]
        }
    }

    /// Cap on total decoded PCM held in memory across all tracks (1 GiB). A mix
    /// whose summed decoded float32 footprint would exceed this is rejected as
    /// `.badInput` rather than risking an OOM in the daemon.
    static let MIX_MAX_TOTAL_DECODE_BYTES: Int64 = 1_073_741_824 // 1 GiB

    /// Cap on the OUTPUT buffer (1 GiB). A caller-supplied `offsetMs`/placement
    /// can push `outFrames` arbitrarily high even when every source is tiny, and
    /// the output planes are allocated with the NON-throwing
    /// `UnsafeMutablePointer.allocate(capacity:)` — an oversized request would be
    /// an uncatchable Swift runtime trap that kills the shared daemon. We reject
    /// it as `.badInput` BEFORE any allocation. (The input-decode cap above only
    /// bounds summed INPUT and never trips on a small source.)
    static let MIX_MAX_OUTPUT_BYTES: Int64 = 1_073_741_824 // 1 GiB output-buffer ceiling

    // MARK: - Public entry

    /// Mix `tracks` into one file at `outputPath` (a TS-owned staging path).
    /// - Parameters:
    ///   - outputPath: where to WRITE the mixed file (TS reads + deletes it).
    ///   - tracks: 1..N sources with per-track gain/pan/offset/fade.
    ///   - format: "wav" (16-bit PCM) or "m4a" (AAC).
    ///   - sampleRate: output rate; EVERY source must already be this rate.
    ///   - channels: 1 (mono) or 2 (stereo) output channels.
    ///   - bitrateKbps: AAC bitrate (m4a only; ignored for wav; default 192).
    static func mixdown(
        outputPath: String,
        tracks: [AudioMixTrack],
        format: String,
        sampleRate: Int,
        channels: Int,
        bitrateKbps: Int?
    ) async throws -> Result {
        // --- 1. Validate the top-level request -------------------------------
        guard !tracks.isEmpty else {
            throw AudioMixError.badInput("audio.mixdown requires at least one track")
        }
        guard channels == 1 || channels == 2 else {
            throw AudioMixError.badInput("channels must be 1 or 2, got \(channels)")
        }
        guard sampleRate > 0 else {
            throw AudioMixError.badInput("sampleRate must be > 0, got \(sampleRate)")
        }
        let normalizedFormat = format.lowercased()
        guard normalizedFormat == "wav" || normalizedFormat == "m4a" else {
            throw AudioMixError.badInput("format must be \"wav\" or \"m4a\", got \"\(format)\"")
        }

        // --- 2. Decode every source into planar float32 ----------------------
        // We hold each decoded `AVAudioPCMBuffer` for the LIFETIME of the
        // tw_mix call (its `floatChannelData` planes are what the kernel reads),
        // so collect them in an array that outlives the call.
        struct DecodedSource {
            let buffer: AVAudioPCMBuffer   // keeps the float planes alive
            let channelCount: Int          // 1 or 2 (source channels)
            let frameCount: Int64          // plane length
            let startFrame: Int64          // placement offset (output samples)
            let fadeInFrames: Int64
            let fadeOutFrames: Int64
            let gainDb: Float
            let pan: Float
        }

        var decoded: [DecodedSource] = []
        decoded.reserveCapacity(tracks.count)
        var totalDecodedBytes: Int64 = 0

        for track in tracks {
            let url = URL(fileURLWithPath: track.sourcePath)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw AudioMixError.badInput("source file does not exist: \(track.sourcePath)")
            }

            let file: AVAudioFile
            do {
                file = try AVAudioFile(forReading: url)
            } catch {
                throw AudioMixError.badInput(
                    "unreadable/unsupported source \(track.sourcePath): \(error.localizedDescription)"
                )
            }

            // processingFormat is float32 deinterleaved at the file's NATIVE rate.
            let pf = file.processingFormat
            let fileRate = Int(pf.sampleRate.rounded())
            guard fileRate == sampleRate else {
                throw AudioMixError.badInput(
                    "sample rate mismatch for \(track.sourcePath): file is \(fileRate) Hz, expected \(sampleRate) Hz"
                )
            }
            let srcChannels = Int(pf.channelCount)
            guard srcChannels >= 1, srcChannels <= 2 else {
                throw AudioMixError.badInput(
                    "source \(track.sourcePath) has \(srcChannels) channels; only 1 or 2 are supported"
                )
            }

            let frameLength = file.length // AVAudioFramePosition (Int64)
            guard frameLength > 0 else {
                // A zero-length source can't contribute and breaks the
                // frameCapacity:0 buffer; treat as caller error (likely wrong file).
                throw AudioMixError.badInput("source has zero audio frames: \(track.sourcePath)")
            }

            // Memory-cap guard: float32 planes = frames * channels * 4 bytes.
            let bytes = frameLength &* Int64(srcChannels) &* 4
            totalDecodedBytes &+= bytes
            if totalDecodedBytes > MIX_MAX_TOTAL_DECODE_BYTES {
                throw AudioMixError.badInput(
                    "mix too large: decoded audio exceeds \(MIX_MAX_TOTAL_DECODE_BYTES) bytes"
                )
            }

            guard let buffer = AVAudioPCMBuffer(
                pcmFormat: pf,
                frameCapacity: AVAudioFrameCount(frameLength)
            ) else {
                throw AudioMixError.mixFailed("could not allocate a decode buffer for \(track.sourcePath)")
            }
            do {
                try file.read(into: buffer)
            } catch {
                throw AudioMixError.mixFailed(
                    "failed to decode \(track.sourcePath): \(error.localizedDescription)"
                )
            }
            // The number of frames actually read (== file.length for a full read).
            let readFrames = Int64(buffer.frameLength)
            guard readFrames > 0, buffer.floatChannelData != nil else {
                throw AudioMixError.mixFailed("decoded zero usable frames from \(track.sourcePath)")
            }

            // Placement + fades, computed in double then settled to frames.
            let startFrame = Int64((track.offsetMs * Double(sampleRate) / 1000.0).rounded())
            let safeStart = max(0, startFrame)
            var fadeIn = Int64((max(0, track.fadeInMs) * Double(sampleRate) / 1000.0).rounded())
            var fadeOut = Int64((max(0, track.fadeOutMs) * Double(sampleRate) / 1000.0).rounded())
            // Clamp fades to the source length; if both exceed it, split in half
            // (the kernel re-clamps too, but we keep Swift authoritative).
            if fadeIn < 0 { fadeIn = 0 }
            if fadeOut < 0 { fadeOut = 0 }
            if fadeIn > readFrames { fadeIn = readFrames }
            if fadeOut > readFrames { fadeOut = readFrames }
            if fadeIn + fadeOut > readFrames {
                fadeIn = readFrames / 2
                fadeOut = readFrames - fadeIn
            }

            // Clamp the gain dB to [-60,+12] BEFORE it reaches the kernel.
            let clampedGainDb = min(max(track.gainDb, -60.0), 12.0)
            // Clamp pan defensively (kernel also clamps).
            let clampedPan = min(max(track.pan, -1.0), 1.0)

            decoded.append(DecodedSource(
                buffer: buffer,
                channelCount: srcChannels,
                frameCount: readFrames,
                startFrame: safeStart,
                fadeInFrames: fadeIn,
                fadeOutFrames: fadeOut,
                gainDb: clampedGainDb,
                pan: clampedPan
            ))
        }

        // --- 3. Output length = max over sources of (startFrame + frameCount) -
        var outFrames: Int64 = 0
        for d in decoded {
            let end = d.startFrame &+ d.frameCount
            if end > outFrames { outFrames = end }
        }
        guard outFrames > 0 else {
            throw AudioMixError.mixFailed("computed zero output frames")
        }

        // Bound the output allocation so a caller-supplied offsetMs/placement cannot
        // request an enormous buffer (a non-throwing allocate() trap would kill the
        // shared daemon, uncatchable by the JSON-RPC error mapping). Mirror the 1 GiB
        // input-decode cap. outFrames * channels * 4 bytes must stay under the cap.
        let outputBytes = outFrames &* Int64(channels) &* 4
        guard outputBytes <= MIX_MAX_OUTPUT_BYTES else {
            throw AudioMixError.badInput(
                "mix output too large: \(outFrames) frames × \(channels) ch ≈ \(outputBytes) bytes exceeds the \(MIX_MAX_OUTPUT_BYTES)-byte cap; reduce track offsets/length")
        }

        // --- 4. Allocate the planar OUTPUT buffers + run the C kernel ---------
        // Output planes are heap float buffers we own; the kernel zeroes then
        // sums into them. We keep them alive until after the writer consumes them.
        let outChannelCount = channels
        // Optional element type so the array's base address is
        // `UnsafePointer<UnsafeMutablePointer<Float>?>` — exactly what tw_mix's
        // `out` parameter imports as (C `float *const *`). Every element is
        // non-nil (we allocate them); the writers force-unwrap below.
        var outPlanes: [UnsafeMutablePointer<Float>?] = []
        outPlanes.reserveCapacity(outChannelCount)
        for _ in 0..<outChannelCount {
            outPlanes.append(UnsafeMutablePointer<Float>.allocate(capacity: Int(outFrames)))
        }
        defer { for p in outPlanes { p?.deallocate() } }
        // Non-optional view for the writers (guaranteed non-nil by construction).
        let outPlanesUnwrapped: [UnsafeMutablePointer<Float>] = outPlanes.map { $0! }

        // Gather the planar channel pointers + per-source scalar metadata.
        //
        // The source float planes come from each buffer's `floatChannelData[c]`;
        // those stay valid as long as the AVAudioPCMBuffer (held in `decoded`,
        // alive for the whole function) is alive. For each source we build a
        // small `[UnsafePointer<Float>?]` array of its channel-plane pointers;
        // `tw_mix` wants a `const float *const *` per source, i.e. the base
        // address of one of those arrays. A buffer-pointer's base address is only
        // valid inside its own `withUnsafeBufferPointer` closure, so to hand N of
        // them to one C call we NEST the closures (see `withRecursiveBasePointers`).
        var channelPtrStorage: [[UnsafePointer<Float>?]] = []
        channelPtrStorage.reserveCapacity(decoded.count)
        var meta: [MixMeta] = []
        meta.reserveCapacity(decoded.count)

        for d in decoded {
            guard let planes = d.buffer.floatChannelData else {
                throw AudioMixError.mixFailed("decoded buffer lost its float channel data")
            }
            var ptrs: [UnsafePointer<Float>?] = []
            ptrs.reserveCapacity(d.channelCount)
            for c in 0..<d.channelCount {
                ptrs.append(UnsafePointer<Float>(planes[c]))
            }
            channelPtrStorage.append(ptrs)
            meta.append(MixMeta(
                channelCount: Int32(d.channelCount),
                frameCount: d.frameCount,
                startFrame: d.startFrame,
                fadeInFrames: d.fadeInFrames,
                fadeOutFrames: d.fadeOutFrames,
                gainDb: d.gainDb,
                pan: d.pan
            ))
        }

        // Pin every channel-pointer array's base address simultaneously (nested
        // withUnsafeBufferPointer), build the TWMixSource[] against those stable
        // bases, then call the kernel — all while `decoded` (the backing PCM
        // buffers) stays alive. The output planes are pinned in the innermost
        // scope so `out` is valid for the call too.
        let mixStatus: Int32 = withExtendedLifetime(decoded) {
            channelPtrStorage.withRecursiveBasePointers { bases -> Int32 in
                var sources: [TWMixSource] = []
                sources.reserveCapacity(meta.count)
                for (i, m) in meta.enumerated() {
                    sources.append(TWMixSource(
                        channels: bases[i],
                        channelCount: m.channelCount,
                        frameCount: m.frameCount,
                        startFrame: m.startFrame,
                        fadeInFrames: m.fadeInFrames,
                        fadeOutFrames: m.fadeOutFrames,
                        gainDb: m.gainDb,
                        pan: m.pan
                    ))
                }
                return outPlanes.withUnsafeMutableBufferPointer { outBuf -> Int32 in
                    // tw_mix's `out` is `UnsafeMutablePointer<UnsafeMutablePointer<Float>?>`
                    // (C `float *const *`); outBuf.baseAddress matches exactly since
                    // the element type is the optional plane pointer.
                    sources.withUnsafeBufferPointer { srcBuf -> Int32 in
                        tw_mix(
                            srcBuf.baseAddress,
                            srcBuf.count,
                            outBuf.baseAddress,
                            Int32(outChannelCount),
                            outFrames
                        )
                    }
                }
            }
        }
        guard mixStatus == 0 else {
            throw AudioMixError.mixFailed("audio mix kernel returned error status \(mixStatus)")
        }

        // --- 5. Write the mixed output ---------------------------------------
        let codec: String
        if normalizedFormat == "wav" {
            try writeWAV(
                outputPath: outputPath,
                planes: outPlanesUnwrapped,
                channels: outChannelCount,
                frames: outFrames,
                sampleRate: sampleRate
            )
            codec = "pcm_s16le"
        } else {
            try writeAAC(
                outputPath: outputPath,
                planes: outPlanesUnwrapped,
                channels: outChannelCount,
                frames: outFrames,
                sampleRate: sampleRate,
                bitrateKbps: bitrateKbps ?? 192
            )
            codec = "aac"
        }

        // --- 6. Result --------------------------------------------------------
        let durationMs = Int((Double(outFrames) * 1000.0 / Double(sampleRate)).rounded())
        return Result(
            durationMs: durationMs,
            sampleRate: sampleRate,
            channels: outChannelCount,
            codec: codec,
            trackCount: tracks.count
        )
    }

    // MARK: - Window clip (inspect_audio_segment)

    /// `audio.windowClip` result. FIXED shape the TS staging-read path consumes:
    /// `durationMs`(Int) / `sampleRate`(Int) / `channels`(Int) / `codec`(String).
    /// The codec is the TRUE writer output — `writeWAV` emits 16-bit PCM, so this is
    /// always `"pcm_s16le"` (not a claim; it's what we wrote).
    struct WindowClipResult: Sendable {
        let durationMs: Int
        let sampleRate: Int
        let channels: Int
        let codec: String

        func toJSONObject() -> [String: Any] {
            return [
                "durationMs": durationMs,
                "sampleRate": sampleRate,
                "channels": channels,
                "codec": codec
            ]
        }
    }

    /// Cut a `[startMs, endMs]` WINDOW out of one source and write it as a standalone
    /// 16-bit PCM WAV at `outputPath` (a TS-owned staging path the TS side reads +
    /// deletes). REUSES `mixdown`'s decode (`AVAudioFile.processingFormat` → planar
    /// float32 at the file's NATIVE rate), the exact frame-math (`offsetMs` placement
    /// style), and `writeWAV` verbatim (incl. TPDF dither) — no second WAV writer.
    ///
    /// Frame bounds (computed against the DECODED sample rate, mirroring mixdown):
    ///   frameStart = floor(startMs * sr / 1000), clamped to [0, length]
    ///   frameEnd   = floor(endMs   * sr / 1000), clamped to [0, length], forced > frameStart
    /// An empty/degenerate window (after clamping to the file length) → `.badInput`.
    ///
    /// - Parameters:
    ///   - sourcePath: the (TS-jailed) source audio file to slice.
    ///   - startMs/endMs: the window bounds (ms; the TS side already validated finite,
    ///     0 <= startMs < endMs, and span <= 120s — we re-clamp defensively here too).
    ///   - outputPath: where to WRITE the windowed WAV (TS reads + deletes it).
    static func windowClip(
        sourcePath: String,
        startMs: Int,
        endMs: Int,
        outputPath: String
    ) async throws -> WindowClipResult {
        let url = URL(fileURLWithPath: sourcePath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw AudioMixError.badInput("source file does not exist: \(sourcePath)")
        }

        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            throw AudioMixError.badInput(
                "unreadable/unsupported source \(sourcePath): \(error.localizedDescription)"
            )
        }

        // processingFormat is float32 deinterleaved at the file's NATIVE rate (decodeAudio
        // resamples to this rate). Frame bounds are computed against THIS rate.
        let pf = file.processingFormat
        let sampleRate = Int(pf.sampleRate.rounded())
        guard sampleRate > 0 else {
            throw AudioMixError.mixFailed("source reported a non-positive sample rate")
        }
        let srcChannels = Int(pf.channelCount)
        guard srcChannels >= 1, srcChannels <= 2 else {
            throw AudioMixError.badInput(
                "source \(sourcePath) has \(srcChannels) channels; only 1 or 2 are supported"
            )
        }

        let length = file.length // AVAudioFramePosition (Int64), total frames
        guard length > 0 else {
            throw AudioMixError.badInput("source has zero audio frames: \(sourcePath)")
        }

        // Memory cap: reuse mixdown's 1 GiB decode ceiling on the source's float planes.
        let decodeBytes = length &* Int64(srcChannels) &* 4
        if decodeBytes > MIX_MAX_TOTAL_DECODE_BYTES {
            throw AudioMixError.badInput(
                "source too large: decoded audio exceeds \(MIX_MAX_TOTAL_DECODE_BYTES) bytes"
            )
        }

        // Frame-math: floor(ms * sr / 1000), clamped to [0, length], frameEnd > frameStart.
        // Use Double then floor (mirrors mixdown's placement computation), and clamp BOTH
        // ends to the actual file length so an over-long window simply hits EOF.
        let rawStart = Int64((Double(max(0, startMs)) * Double(sampleRate) / 1000.0).rounded(.down))
        let rawEnd = Int64((Double(max(0, endMs)) * Double(sampleRate) / 1000.0).rounded(.down))
        let frameStart = min(max(0, rawStart), length)
        let frameEnd = min(max(0, rawEnd), length)
        guard frameEnd > frameStart else {
            throw AudioMixError.badInput(
                "window [\(startMs)ms, \(endMs)ms] is empty after clamping to the \(length)-frame source")
        }
        let windowFrames = frameEnd - frameStart

        // Decode the WHOLE source into one planar buffer, then slice. (A read into a
        // capacity-(length) buffer mirrors mixdown; we copy out the [frameStart,frameEnd)
        // span per channel into fresh planes the writer owns.)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: pf,
            frameCapacity: AVAudioFrameCount(length)
        ) else {
            throw AudioMixError.mixFailed("could not allocate a decode buffer for \(sourcePath)")
        }
        do {
            try file.read(into: buffer)
        } catch {
            throw AudioMixError.mixFailed("failed to decode \(sourcePath): \(error.localizedDescription)")
        }
        let readFrames = Int64(buffer.frameLength)
        guard readFrames > 0, let srcPlanes = buffer.floatChannelData else {
            throw AudioMixError.mixFailed("decoded zero usable frames from \(sourcePath)")
        }
        // The window must fit inside what was actually read (a short read clamps it).
        let safeEnd = min(frameEnd, readFrames)
        guard safeEnd > frameStart else {
            throw AudioMixError.badInput("window starts at/after end of decoded audio")
        }
        let copyFrames = safeEnd - frameStart

        // Build per-channel float planes holding ONLY the windowed slice. writeWAV takes
        // `[UnsafeMutablePointer<Float>]` (one per channel) + a frame count; we own these
        // and free them after the write.
        var slicePlanes: [UnsafeMutablePointer<Float>] = []
        slicePlanes.reserveCapacity(srcChannels)
        for _ in 0..<srcChannels {
            slicePlanes.append(UnsafeMutablePointer<Float>.allocate(capacity: Int(copyFrames)))
        }
        defer { for p in slicePlanes { p.deallocate() } }
        for c in 0..<srcChannels {
            let src = srcPlanes[c].advanced(by: Int(frameStart))
            slicePlanes[c].update(from: src, count: Int(copyFrames))
        }

        // Reuse the EXACT same WAV writer as mixdown (16-bit PCM, TPDF dither). No new
        // writer path — `writeWAV` mutates the planes in-place (dither) then quantizes.
        try writeWAV(
            outputPath: outputPath,
            planes: slicePlanes,
            channels: srcChannels,
            frames: copyFrames,
            sampleRate: sampleRate
        )

        let durationMs = Int((Double(copyFrames) * 1000.0 / Double(sampleRate)).rounded())
        return WindowClipResult(
            durationMs: durationMs,
            sampleRate: sampleRate,
            channels: srcChannels,
            codec: "pcm_s16le"
        )
    }

    /// Per-source scalar metadata, paired 1:1 with `channelPtrStorage` when
    /// building the `TWMixSource[]` inside the pinned-pointer scope.
    private struct MixMeta {
        let channelCount: Int32
        let frameCount: Int64
        let startFrame: Int64
        let fadeInFrames: Int64
        let fadeOutFrames: Int64
        let gainDb: Float
        let pan: Float
    }

    // MARK: - Writers

    /// Write 16-bit signed PCM WAV with TPDF dither. Uses `ExtAudioFile` with an
    /// int16 LPCM WAV file format and a float32 deinterleaved CLIENT format, so
    /// we feed the (dithered) float planes and the framework quantizes.
    private static func writeWAV(
        outputPath: String,
        planes: [UnsafeMutablePointer<Float>],
        channels: Int,
        frames: Int64,
        sampleRate: Int
    ) throws {
        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: url) // writers refuse overwrite

        // Apply TPDF dither in-place to the float planes BEFORE handing them to
        // the int16 writer. Deterministic xorshift32 (NOT a time seed) so tests
        // are reproducible and the daemon's no-nondeterministic-seed rule holds.
        applyTPDFDither(planes: planes, channels: channels, frames: frames)

        // Output file format: 16-bit signed-integer interleaved LPCM in a WAV.
        var fileASBD = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(2 * channels),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(2 * channels),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 16,
            mReserved: 0
        )

        var extFile: ExtAudioFileRef?
        let createStatus = ExtAudioFileCreateWithURL(
            url as CFURL,
            kAudioFileWAVEType,
            &fileASBD,
            nil,
            AudioFileFlags.eraseFile.rawValue,
            &extFile
        )
        guard createStatus == noErr, let ext = extFile else {
            throw AudioMixError.mixFailed("ExtAudioFileCreateWithURL(wav) failed: OSStatus \(createStatus)")
        }
        defer { ExtAudioFileDispose(ext) }

        // Client format: float32 DEINTERLEAVED (non-interleaved) so we can point
        // the AudioBufferList mBuffers at our per-channel planes directly.
        var clientASBD = floatDeinterleavedASBD(channels: channels, sampleRate: sampleRate)
        let setClient = ExtAudioFileSetProperty(
            ext,
            kExtAudioFileProperty_ClientDataFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size),
            &clientASBD
        )
        guard setClient == noErr else {
            throw AudioMixError.mixFailed("ExtAudioFileSetProperty(client,wav) failed: OSStatus \(setClient)")
        }

        try writeFloatPlanes(ext: ext, planes: planes, channels: channels, frames: frames)
    }

    /// Write AAC `.m4a`. `ExtAudioFile` with `kAudioFileM4AType` + an AAC file
    /// ASBD, float32 deinterleaved CLIENT format. No dither (AAC is lossy). We
    /// best-effort set the encoder bitrate via the underlying AudioConverter.
    private static func writeAAC(
        outputPath: String,
        planes: [UnsafeMutablePointer<Float>],
        channels: Int,
        frames: Int64,
        sampleRate: Int,
        bitrateKbps: Int
    ) throws {
        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.removeItem(at: url)

        // AAC file ASBD: only mFormatID/mSampleRate/mChannelsPerFrame are
        // meaningful; the rest are zero (the encoder fills packet geometry).
        var fileASBD = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate),
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 0,
            mBytesPerFrame: 0,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0,
            mReserved: 0
        )

        var extFile: ExtAudioFileRef?
        let createStatus = ExtAudioFileCreateWithURL(
            url as CFURL,
            kAudioFileM4AType,
            &fileASBD,
            nil,
            AudioFileFlags.eraseFile.rawValue,
            &extFile
        )
        guard createStatus == noErr, let ext = extFile else {
            throw AudioMixError.mixFailed("ExtAudioFileCreateWithURL(m4a/aac) failed: OSStatus \(createStatus)")
        }
        defer { ExtAudioFileDispose(ext) }

        var clientASBD = floatDeinterleavedASBD(channels: channels, sampleRate: sampleRate)
        let setClient = ExtAudioFileSetProperty(
            ext,
            kExtAudioFileProperty_ClientDataFormat,
            UInt32(MemoryLayout<AudioStreamBasicDescription>.size),
            &clientASBD
        )
        guard setClient == noErr else {
            throw AudioMixError.mixFailed("ExtAudioFileSetProperty(client,aac) failed: OSStatus \(setClient)")
        }

        // Best-effort AAC bitrate via the converter (ignore failure — accept the
        // encoder default rather than failing the whole mix on a property miss).
        if bitrateKbps > 0 {
            var converter: AudioConverterRef?
            var sizeOut = UInt32(MemoryLayout<AudioConverterRef?>.size)
            let getConv = ExtAudioFileGetProperty(
                ext,
                kExtAudioFileProperty_AudioConverter,
                &sizeOut,
                &converter
            )
            if getConv == noErr, let conv = converter {
                var bitrate = UInt32(bitrateKbps * 1000)
                // Set the bitrate directly on the underlying converter. ExtAudioFile
                // writes THROUGH this same converter, so the new rate takes effect
                // on the subsequent writes without an explicit re-sync. We ignore a
                // failure here (accept the encoder default rather than fail the mix).
                _ = AudioConverterSetProperty(
                    conv,
                    kAudioConverterEncodeBitRate,
                    UInt32(MemoryLayout<UInt32>.size),
                    &bitrate
                )
            }
        }

        try writeFloatPlanes(ext: ext, planes: planes, channels: channels, frames: frames)
    }

    /// Shared float32-deinterleaved client ASBD (used by both writers).
    private static func floatDeinterleavedASBD(channels: Int, sampleRate: Int) -> AudioStreamBasicDescription {
        // Non-interleaved float32: mBytesPerFrame/Packet are PER-CHANNEL (4),
        // and kAudioFormatFlagIsNonInterleaved is set, so each AudioBuffer holds
        // one channel plane.
        return AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 32,
            mReserved: 0
        )
    }

    /// Drive `ExtAudioFileWrite` from the planar float buffers, chunked so the
    /// AudioBufferList stays a sane size. Builds a non-interleaved
    /// AudioBufferList (one buffer per channel) pointing at offsets into our
    /// planes; writes in `chunk`-frame batches until `frames` are consumed.
    private static func writeFloatPlanes(
        ext: ExtAudioFileRef,
        planes: [UnsafeMutablePointer<Float>],
        channels: Int,
        frames: Int64
    ) throws {
        let chunk: Int64 = 65_536
        var offset: Int64 = 0
        while offset < frames {
            let n = Int(min(chunk, frames - offset))
            // Allocate an AudioBufferList with `channels` buffers.
            let ablPtr = AudioBufferList.allocate(maximumBuffers: channels)
            defer { free(ablPtr.unsafeMutablePointer) }
            ablPtr.unsafeMutablePointer.pointee.mNumberBuffers = UInt32(channels)
            for c in 0..<channels {
                ablPtr[c] = AudioBuffer(
                    mNumberChannels: 1,
                    mDataByteSize: UInt32(n * MemoryLayout<Float>.size),
                    mData: UnsafeMutableRawPointer(planes[c].advanced(by: Int(offset)))
                )
            }
            var nFrames = UInt32(n)
            let status = ExtAudioFileWrite(ext, nFrames, ablPtr.unsafePointer)
            guard status == noErr else {
                throw AudioMixError.mixFailed("ExtAudioFileWrite failed: OSStatus \(status)")
            }
            _ = nFrames // silence unused-mutation note; nFrames is in/out per call
            offset += Int64(n)
        }
    }

    // MARK: - Dither

    /// In-place TPDF (triangular PDF) dither over the float planes, scaled to ±1
    /// int16 LSB. Two independent uniform-[-0.5,0.5] draws summed give a
    /// triangular distribution; dividing by 32768 puts it at the 16-bit LSB
    /// scale, then the int16 writer quantizes. Uses a DETERMINISTIC xorshift32
    /// (fixed seed) — the daemon forbids time/nondeterministic seeds and tests
    /// need reproducibility.
    private static func applyTPDFDither(
        planes: [UnsafeMutablePointer<Float>],
        channels: Int,
        frames: Int64
    ) {
        var state: UInt32 = 0x12345678 // fixed, deterministic seed
        @inline(__always) func nextUnit() -> Float {
            // xorshift32 → uniform float in [0,1).
            state ^= state << 13
            state ^= state >> 17
            state ^= state << 5
            // Top 24 bits → [0,1) (24-bit mantissa).
            return Float(state >> 8) * (1.0 / 16_777_216.0)
        }
        let lsb: Float = 1.0 / 32_768.0
        for c in 0..<channels {
            let plane = planes[c]
            for i in 0..<Int(frames) {
                let r1 = nextUnit() - 0.5
                let r2 = nextUnit() - 0.5
                plane[i] += (r1 + r2) * lsb
            }
        }
    }
}

// MARK: - Pointer-array recursion helper

private extension Array where Element == [UnsafePointer<Float>?] {
    /// Recursively pin the base address of every inner array so they're all
    /// valid simultaneously inside `body`. `withUnsafeBufferPointer` only
    /// guarantees the base address for the duration of its own closure, so to
    /// pass N arrays' base addresses to one C call we nest the closures.
    func withRecursiveBasePointers<R>(
        _ body: ([UnsafePointer<UnsafePointer<Float>?>]) -> R
    ) -> R {
        var bases: [UnsafePointer<UnsafePointer<Float>?>] = []
        bases.reserveCapacity(count)
        func recurse(_ index: Int) -> R {
            if index == count {
                return body(bases)
            }
            return self[index].withUnsafeBufferPointer { buf in
                // An empty inner array would yield a nil base; sources always
                // have >=1 channel so this is non-nil in practice. Fall back to a
                // dangling-but-unused pointer guard is unnecessary (kernel checks).
                bases.append(buf.baseAddress!)
                let r = recurse(index + 1)
                bases.removeLast()
                return r
            }
        }
        return recurse(0)
    }
}
