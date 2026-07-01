import XCTest
import AVFoundation
import AudioToolbox
@testable import TaskWraithBridgeDaemon
import TaskWraithAudioKernel

/// Tests for the native offline multitrack audio mixdown
/// (`AudioMixer.mixdown`, C kernel `tw_mix` + AVFoundation/AudioToolbox glue).
///
/// All sources are synthesized to disk as 16-bit WAV with `AVAudioFile` (NO
/// ffmpeg). Each test runs the FULL decode → `tw_mix` → write pipeline, then
/// re-opens the output via `AVAudioFile` and reads it back to planar float to
/// assert placement, gain, pan, fades, downmix, and the result/codec contract.
/// A handful of pure-C kernel tests call `tw_mix` directly with crafted planes.
final class AudioMixerTests: XCTestCase {

    // MARK: - Pure-C kernel (direct tw_mix calls, crafted planes)

    /// Two identical mono sources at unity gain sum to ~2x where they overlap
    /// (the soft-limiter only bites above |0.9|, so a 0.2+0.2=0.4 sum is exact).
    func testKernelTwoMonoSourcesSum() {
        let n = 8
        var a = [Float](repeating: 0.2, count: n)
        var b = [Float](repeating: 0.2, count: n)
        var out = [Float](repeating: 999, count: n)

        a.withUnsafeBufferPointer { ap in
            b.withUnsafeBufferPointer { bp in
                var aPtrs: [UnsafePointer<Float>?] = [ap.baseAddress]
                var bPtrs: [UnsafePointer<Float>?] = [bp.baseAddress]
                aPtrs.withUnsafeBufferPointer { aBase in
                    bPtrs.withUnsafeBufferPointer { bBase in
                        let sources = [
                            TWMixSource(channels: aBase.baseAddress, channelCount: 1,
                                        frameCount: Int64(n), startFrame: 0,
                                        fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0),
                            TWMixSource(channels: bBase.baseAddress, channelCount: 1,
                                        frameCount: Int64(n), startFrame: 0,
                                        fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0)
                        ]
                        out.withUnsafeMutableBufferPointer { ob in
                            var outPlanes: [UnsafeMutablePointer<Float>?] = [ob.baseAddress]
                            outPlanes.withUnsafeMutableBufferPointer { obp in
                                sources.withUnsafeBufferPointer { sp in
                                    let rc = tw_mix(sp.baseAddress, sp.count, obp.baseAddress, 1, Int64(n))
                                    XCTAssertEqual(rc, 0)
                                }
                            }
                        }
                    }
                }
            }
        }
        for v in out { XCTAssertEqual(v, 0.4, accuracy: 1e-5) }
    }

    /// The cubic SOFT-knee compresses a summed overshoot (it is NOT a brickwall
    /// limiter — large sums can still exceed 1.0). For a linear sum of 1.6 the
    /// spec gives 0.9 + 0.7/(1+0.49) ≈ 1.3698; the key properties are: the output
    /// is BELOW the linear sum (compression happened) and matches the exact
    /// soft-knee formula. A sub-knee signal (|x|<=0.9) is left untouched.
    func testKernelSoftKneeCompressesOvershoot() {
        let n = 4
        let amp: Float = 0.8
        var a = [Float](repeating: amp, count: n)
        var b = [Float](repeating: amp, count: n)
        var out = [Float](repeating: 0, count: n)
        a.withUnsafeBufferPointer { ap in
            b.withUnsafeBufferPointer { bp in
                var aPtrs: [UnsafePointer<Float>?] = [ap.baseAddress]
                var bPtrs: [UnsafePointer<Float>?] = [bp.baseAddress]
                aPtrs.withUnsafeBufferPointer { aB in
                    bPtrs.withUnsafeBufferPointer { bB in
                        let sources = [
                            TWMixSource(channels: aB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                        startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0),
                            TWMixSource(channels: bB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                        startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0)
                        ]
                        out.withUnsafeMutableBufferPointer { ob in
                            var op: [UnsafeMutablePointer<Float>?] = [ob.baseAddress]
                            op.withUnsafeMutableBufferPointer { obp in
                                sources.withUnsafeBufferPointer { sp in
                                    _ = tw_mix(sp.baseAddress, sp.count, obp.baseAddress, 1, Int64(n))
                                }
                            }
                        }
                    }
                }
            }
        }
        // Exact soft-knee expectation for a linear sum of 1.6.
        let linearSum: Float = amp * 2
        let e = linearSum - 0.9
        let expected = 0.9 + e / (1.0 + e * e) // ≈ 1.3698
        for v in out {
            XCTAssertEqual(v, expected, accuracy: 1e-4, "must match the cubic soft-knee formula")
            XCTAssertLessThan(v, linearSum, "soft-knee must compress below the linear sum")
        }
    }

    /// A sub-knee summed signal (|x| <= 0.9) passes through the limiter exactly.
    func testKernelSubKneeIsUntouched() {
        let n = 4
        // 0.4 + 0.4 = 0.8 ≤ 0.9 → identity.
        var a = [Float](repeating: 0.4, count: n)
        var b = [Float](repeating: 0.4, count: n)
        var out = [Float](repeating: 0, count: n)
        a.withUnsafeBufferPointer { ap in
            b.withUnsafeBufferPointer { bp in
                var aPtrs: [UnsafePointer<Float>?] = [ap.baseAddress]
                var bPtrs: [UnsafePointer<Float>?] = [bp.baseAddress]
                aPtrs.withUnsafeBufferPointer { aB in
                    bPtrs.withUnsafeBufferPointer { bB in
                        let sources = [
                            TWMixSource(channels: aB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                        startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0),
                            TWMixSource(channels: bB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                        startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: 0)
                        ]
                        out.withUnsafeMutableBufferPointer { ob in
                            var op: [UnsafeMutablePointer<Float>?] = [ob.baseAddress]
                            op.withUnsafeMutableBufferPointer { obp in
                                sources.withUnsafeBufferPointer { sp in
                                    _ = tw_mix(sp.baseAddress, sp.count, obp.baseAddress, 1, Int64(n))
                                }
                            }
                        }
                    }
                }
            }
        }
        for v in out { XCTAssertEqual(v, 0.8, accuracy: 1e-5) }
    }

    /// Bad arguments → negative return, output left zeroed.
    func testKernelRejectsBadChannelCount() {
        var out = [Float](repeating: 0, count: 4)
        let rc = out.withUnsafeMutableBufferPointer { ob -> Int32 in
            var op: [UnsafeMutablePointer<Float>?] = [ob.baseAddress]
            return op.withUnsafeMutableBufferPointer { obp in
                tw_mix(nil, 0, obp.baseAddress, 3 /* invalid */, 4)
            }
        }
        XCTAssertLessThan(rc, 0)
    }

    /// Mono-source equal-power pan hard-left puts all energy in L, ~none in R.
    func testKernelPanHardLeft() {
        let n = 4
        var mono = [Float](repeating: 0.5, count: n)
        var outL = [Float](repeating: 0, count: n)
        var outR = [Float](repeating: 0, count: n)
        mono.withUnsafeBufferPointer { mp in
            var mPtrs: [UnsafePointer<Float>?] = [mp.baseAddress]
            mPtrs.withUnsafeBufferPointer { mB in
                let sources = [
                    TWMixSource(channels: mB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                startFrame: 0, fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: -1.0)
                ]
                outL.withUnsafeMutableBufferPointer { lp in
                    outR.withUnsafeMutableBufferPointer { rp in
                        var op: [UnsafeMutablePointer<Float>?] = [lp.baseAddress, rp.baseAddress]
                        op.withUnsafeMutableBufferPointer { obp in
                            sources.withUnsafeBufferPointer { sp in
                                _ = tw_mix(sp.baseAddress, sp.count, obp.baseAddress, 2, Int64(n))
                            }
                        }
                    }
                }
            }
        }
        for v in outL { XCTAssertEqual(v, 0.5, accuracy: 1e-4) } // cos(0)=1
        for v in outR { XCTAssertEqual(v, 0.0, accuracy: 1e-4) } // sin(0)=0
    }

    /// STEREO source → STEREO out BALANCE law (the highest-risk, previously
    /// untested path). A stereo source whose L and R are both a constant `c`, at
    /// unity gain / no fade, mixed with various pan values. The spec balance law
    /// (mixer.c) is `balL = pan<=0 ? 1 : cos(0.5π·pan)`,
    /// `balR = pan>=0 ? 1 : cos(0.5π·(-pan))` — i.e. panning RIGHT (pan>0)
    /// attenuates the LEFT channel and keeps RIGHT at unity. We assert the EXACT
    /// per-channel output for pan = +0.5, −0.5, and +1.0 (all below the 0.9 knee,
    /// so the soft-limiter is identity).
    func testKernelStereoSourceStereoBalance() {
        let n = 4
        let c: Float = 0.5

        // Run one stereo-source mix at `pan`, returning (outL[0], outR[0]).
        func runBalance(pan: Float) -> (Float, Float) {
            var sL = [Float](repeating: c, count: n)
            var sR = [Float](repeating: c, count: n)
            var outL = [Float](repeating: 999, count: n)
            var outR = [Float](repeating: 999, count: n)
            sL.withUnsafeBufferPointer { lp in
                sR.withUnsafeBufferPointer { rp in
                    // The source is a 2-plane (stereo) channel-pointer array.
                    var srcPtrs: [UnsafePointer<Float>?] = [lp.baseAddress, rp.baseAddress]
                    srcPtrs.withUnsafeBufferPointer { sB in
                        let sources = [
                            TWMixSource(channels: sB.baseAddress, channelCount: 2,
                                        frameCount: Int64(n), startFrame: 0,
                                        fadeInFrames: 0, fadeOutFrames: 0, gainDb: 0, pan: pan)
                        ]
                        outL.withUnsafeMutableBufferPointer { olp in
                            outR.withUnsafeMutableBufferPointer { orp in
                                var op: [UnsafeMutablePointer<Float>?] = [olp.baseAddress, orp.baseAddress]
                                op.withUnsafeMutableBufferPointer { obp in
                                    sources.withUnsafeBufferPointer { sp in
                                        let rc = tw_mix(sp.baseAddress, sp.count, obp.baseAddress, 2, Int64(n))
                                        XCTAssertEqual(rc, 0)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return (outL[0], outR[0])
        }

        let cosQuarter = Float(cos(0.5 * Double.pi * 0.5)) // cos(π/4) ≈ 0.70710678

        // pan = +0.5 (pan right): balL = cos(0.5π·0.5), balR = 1.0.
        let (l05, r05) = runBalance(pan: 0.5)
        XCTAssertEqual(l05, c * cosQuarter, accuracy: 1e-5, "pan +0.5 attenuates LEFT by cos(π/4)")
        XCTAssertEqual(r05, c, accuracy: 1e-5, "pan +0.5 keeps RIGHT at unity")

        // pan = −0.5 (mirror): balL = 1.0, balR = cos(0.5π·0.5).
        let (lm05, rm05) = runBalance(pan: -0.5)
        XCTAssertEqual(lm05, c, accuracy: 1e-5, "pan −0.5 keeps LEFT at unity")
        XCTAssertEqual(rm05, c * cosQuarter, accuracy: 1e-5, "pan −0.5 attenuates RIGHT by cos(π/4)")

        // pan = +1.0 (hard right): balL = cos(π/2) = 0 → LEFT silent, RIGHT unity.
        let (l1, r1) = runBalance(pan: 1.0)
        XCTAssertEqual(l1, 0.0, accuracy: 1e-5, "pan +1.0 silences LEFT (cos(π/2)=0)")
        XCTAssertEqual(r1, c, accuracy: 1e-5, "pan +1.0 keeps RIGHT at unity")
    }

    /// Fade-OUT tail (only fade-in was previously covered). A mono source at unity
    /// with a fade-out: the equal-power cosine envelope is
    /// `env_out = sin(0.5π·q/fadeOut)`, q = frameCount-1-p. The LAST sample (q=0)
    /// must be ~0, and a sample fadeOut/2 from the end (q=fadeOut/2) must be
    /// sin(π/4)=0.7071 of nominal. No fade-in, so the head is full amplitude.
    func testKernelFadeOutTail() {
        let n = 100
        let fadeOut = 40
        let amp: Float = 0.5
        var src = [Float](repeating: amp, count: n)
        var out = [Float](repeating: 999, count: n)
        src.withUnsafeBufferPointer { sp in
            var sPtrs: [UnsafePointer<Float>?] = [sp.baseAddress]
            sPtrs.withUnsafeBufferPointer { sB in
                let sources = [
                    TWMixSource(channels: sB.baseAddress, channelCount: 1, frameCount: Int64(n),
                                startFrame: 0, fadeInFrames: 0, fadeOutFrames: Int64(fadeOut),
                                gainDb: 0, pan: 0)
                ]
                out.withUnsafeMutableBufferPointer { ob in
                    var op: [UnsafeMutablePointer<Float>?] = [ob.baseAddress]
                    op.withUnsafeMutableBufferPointer { obp in
                        sources.withUnsafeBufferPointer { s in
                            let rc = tw_mix(s.baseAddress, s.count, obp.baseAddress, 1, Int64(n))
                            XCTAssertEqual(rc, 0)
                        }
                    }
                }
            }
        }
        // Head (before the fade-out region begins) is full amplitude.
        XCTAssertEqual(out[0], amp, accuracy: 1e-5, "pre-fade head is full amplitude")
        // Last sample: q = 0 → sin(0) = 0.
        XCTAssertEqual(out[n - 1], 0.0, accuracy: 1e-5, "fade-out tail ends at ~0")
        // A sample fadeOut/2 from the end: q = fadeOut/2 → sin(π/4) = 0.7071 of amp.
        // p = n-1-q with q = fadeOut/2.
        let q = fadeOut / 2
        let pMid = n - 1 - q
        let sinQuarter = Float(sin(0.5 * Double.pi * Double(q) / Double(fadeOut))) // sin(π/4)
        XCTAssertEqual(out[pMid], amp * sinQuarter, accuracy: 1e-5,
                       "fade-out is the equal-power cosine: sin(0.5π·q/fadeOut)")
        XCTAssertEqual(sinQuarter, 0.70710678, accuracy: 1e-5, "q=fadeOut/2 ⇒ sin(π/4)")
        // The envelope ramps DOWN across the tail (monotone decreasing).
        XCTAssertGreaterThan(out[pMid], out[n - 1], "tail must ramp down toward zero")
        XCTAssertGreaterThan(out[n - fadeOut], out[pMid], "earlier-in-tail sample is louder than mid-tail")
    }

    // MARK: - Full pipeline: placement / duration

    /// Output duration == max(placement + length). A 0.5s tone placed at 0.5s
    /// yields a 1.0s output; the first half is silent, the second half has signal.
    func testPlacementAndDuration() async throws {
        let sr = 44100
        let toneFrames = sr / 2 // 0.5s
        let src = try makeToneWAV(frames: toneFrames, channels: 1, sampleRate: sr, amplitude: 0.4, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav")
        defer { try? FileManager.default.removeItem(at: out) }

        let result = try await AudioMixer.mixdown(
            outputPath: out.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0,
                                              offsetMs: 500, fadeInMs: 0, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        // 0.5s offset + 0.5s tone = 1.0s output.
        XCTAssertEqual(result.durationMs, 1000, accuracy: 2)
        XCTAssertEqual(result.sampleRate, sr)
        XCTAssertEqual(result.channels, 1)
        XCTAssertEqual(result.codec, "pcm_s16le")
        XCTAssertEqual(result.trackCount, 1)

        let (planes, frames) = try readPlanar(out)
        XCTAssertEqual(frames, Int64(sr), accuracy: 2) // ~1.0s
        // First quarter-second (well before the 0.5s placement) must be silent.
        let early = planes[0][0..<(sr / 4)]
        XCTAssertLessThan(peak(early), 0.001, "audio before the placement offset must be silent")
        // Just after 0.5s there must be real signal.
        let lateStart = Int(Double(sr) * 0.6)
        let late = planes[0][lateStart..<min(lateStart + 1000, planes[0].count)]
        XCTAssertGreaterThan(peak(late), 0.2, "audio after the placement offset must carry the tone")
    }

    /// Two equal full-overlap tones at unity sum to ~2x amplitude (within the
    /// soft-limit). A 0.3-amplitude tone summed with itself peaks ~0.6.
    func testTwoTracksSumLouder() async throws {
        let sr = 44100
        let frames = sr / 4
        let amp: Float = 0.3
        let src = try makeToneWAV(frames: frames, channels: 1, sampleRate: sr, amplitude: amp, freq: 220)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav")
        defer { try? FileManager.default.removeItem(at: out) }

        let result = try await AudioMixer.mixdown(
            outputPath: out.path,
            tracks: [
                AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0),
                AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)
            ],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        XCTAssertEqual(result.trackCount, 2)
        let (planes, _) = try readPlanar(out)
        // Summed peak should be ~2*amp = 0.6 (the soft-knee starts at 0.9, so no
        // compression here). Allow headroom for int16 quantization + windowing.
        let pk = peak(planes[0][...])
        XCTAssertGreaterThan(pk, 0.5, "two equal tones should sum well above one")
        XCTAssertLessThan(pk, 0.7)
    }

    /// A -6 dB gain roughly halves amplitude (10^(-6/20) ≈ 0.501).
    func testGainMinus6dBHalvesAmplitude() async throws {
        let sr = 44100
        let frames = sr / 4
        let amp: Float = 0.6
        let src = try makeToneWAV(frames: frames, channels: 1, sampleRate: sr, amplitude: amp, freq: 330)
        defer { try? FileManager.default.removeItem(at: src) }

        // Reference (0 dB) peak.
        let outRef = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: outRef) }
        _ = try await AudioMixer.mixdown(
            outputPath: outRef.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        let (refPlanes, _) = try readPlanar(outRef)
        let refPeak = peak(refPlanes[0][...])

        // -6 dB peak.
        let out6 = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out6) }
        _ = try await AudioMixer.mixdown(
            outputPath: out6.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: -6, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        let (planes6, _) = try readPlanar(out6)
        let peak6 = peak(planes6[0][...])

        let ratio = peak6 / refPeak
        XCTAssertEqual(ratio, 0.501, accuracy: 0.04, "-6 dB should ~halve the amplitude")
    }

    /// Pan hard-left through the FULL pipeline: a mono tone panned to -1 puts
    /// energy in the LEFT output channel and ~none in the RIGHT.
    func testPanHardLeftPipeline() async throws {
        let sr = 44100
        let frames = sr / 4
        let src = try makeToneWAV(frames: frames, channels: 1, sampleRate: sr, amplitude: 0.5, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }

        let result = try await AudioMixer.mixdown(
            outputPath: out.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: -1.0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 2, bitrateKbps: nil
        )
        XCTAssertEqual(result.channels, 2)
        let (planes, _) = try readPlanar(out)
        XCTAssertEqual(planes.count, 2)
        let lPeak = peak(planes[0][...])
        let rPeak = peak(planes[1][...])
        XCTAssertGreaterThan(lPeak, 0.4, "left channel must carry the panned tone")
        XCTAssertLessThan(rPeak, 0.02, "right channel must be ~silent for a hard-left pan")
    }

    /// Fade-in ramps from ~0 at the start to full by the fade length.
    func testFadeInRampsFromZero() async throws {
        let sr = 44100
        let frames = sr / 2 // 0.5s
        let src = try makeToneWAV(frames: frames, channels: 1, sampleRate: sr, amplitude: 0.6, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }

        _ = try await AudioMixer.mixdown(
            outputPath: out.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0,
                                              fadeInMs: 200, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        let (planes, _) = try readPlanar(out)
        // Window peaks: very start (~0..5ms) must be tiny; mid-fade > start;
        // post-fade (~300ms) near full amplitude.
        let startWin = windowPeak(planes[0], sr: sr, startMs: 0, lenMs: 3)
        let midWin = windowPeak(planes[0], sr: sr, startMs: 100, lenMs: 10)
        let fullWin = windowPeak(planes[0], sr: sr, startMs: 300, lenMs: 10)
        XCTAssertLessThan(startWin, 0.1, "fade-in must start near zero")
        XCTAssertGreaterThan(midWin, startWin, "fade-in must rise")
        XCTAssertGreaterThan(fullWin, 0.5, "post-fade audio must be near full amplitude")
        XCTAssertGreaterThan(fullWin, midWin)
    }

    // MARK: - Channel handling

    /// Mono-output downmix of a STEREO source: out += (L+R)*0.707. Two channels
    /// each at 0.4 → 0.4*2*0.707 ≈ 0.566 in the mono output.
    func testMonoOutputDownmixOfStereoSource() async throws {
        let sr = 44100
        let frames = sr / 4
        let src = try makeToneWAV(frames: frames, channels: 2, sampleRate: sr, amplitude: 0.4, freq: 300)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }

        let result = try await AudioMixer.mixdown(
            outputPath: out.path,
            tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
            format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
        )
        XCTAssertEqual(result.channels, 1)
        let (planes, _) = try readPlanar(out)
        XCTAssertEqual(planes.count, 1)
        let pk = peak(planes[0][...])
        // 0.4 (L) + 0.4 (R), both the same tone in phase, * 0.707 ≈ 0.566.
        XCTAssertEqual(pk, 0.566, accuracy: 0.05, "stereo→mono downmix should be (L+R)*0.707")
    }

    // MARK: - Format / codec contract

    /// M4A output produces a non-empty AAC file and reports codec="aac".
    func testM4AProducesNonEmptyAACFile() async throws {
        let sr = 44100
        let frames = sr / 2
        let src = try makeToneWAV(frames: frames, channels: 2, sampleRate: sr, amplitude: 0.5, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "m4a"); defer { try? FileManager.default.removeItem(at: out) }

        let result: AudioMixer.Result
        do {
            result = try await AudioMixer.mixdown(
                outputPath: out.path,
                tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
                format: "m4a", sampleRate: sr, channels: 2, bitrateKbps: 128
            )
        } catch let err as AudioMixer.AudioMixError {
            if case .mixFailed(let message) = err, message.contains("OSStatus 1718449215") {
                throw XCTSkip("AAC encoder client format unavailable in this environment (fmt?)")
            }
            throw err
        }
        XCTAssertEqual(result.codec, "aac")
        XCTAssertEqual(result.channels, 2)
        let attrs = try FileManager.default.attributesOfItem(atPath: out.path)
        let size = (attrs[.size] as? Int) ?? 0
        XCTAssertGreaterThan(size, 0, "AAC output must be a non-empty file")
        // It must re-open as a real audio asset.
        let reopened = try AVAudioFile(forReading: out)
        XCTAssertGreaterThan(reopened.length, 0)
    }

    // MARK: - Error paths

    func testEmptyTracksThrowsBadInput() async throws {
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await AudioMixer.mixdown(outputPath: out.path, tracks: [],
                                             format: "wav", sampleRate: 44100, channels: 2, bitrateKbps: nil)
            XCTFail("expected a throw for empty tracks")
        } catch let err as AudioMixer.AudioMixError {
            guard case .badInput = err else { return XCTFail("expected .badInput, got \(err)") }
        }
    }

    /// A source whose sample rate != the requested rate is rejected, and the
    /// message names the file + both rates.
    func testSampleRateMismatchThrowsBadInput() async throws {
        let src = try makeToneWAV(frames: 22050, channels: 1, sampleRate: 22050, amplitude: 0.4, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await AudioMixer.mixdown(
                outputPath: out.path,
                tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
                format: "wav", sampleRate: 44100 /* mismatch */, channels: 1, bitrateKbps: nil
            )
            XCTFail("expected a throw for a sample-rate mismatch")
        } catch let err as AudioMixer.AudioMixError {
            guard case .badInput(let msg) = err else { return XCTFail("expected .badInput, got \(err)") }
            XCTAssertTrue(msg.contains("22050"), "message should name the file rate: \(msg)")
            XCTAssertTrue(msg.contains("44100"), "message should name the expected rate: \(msg)")
        }
    }

    func testUnreadableSourceThrowsBadInput() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tw-not-audio-\(UUID().uuidString).wav")
        try Data("definitely not a wav".utf8).write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await AudioMixer.mixdown(
                outputPath: out.path,
                tracks: [AudioMixer.AudioMixTrack(sourcePath: tmp.path, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
                format: "wav", sampleRate: 44100, channels: 1, bitrateKbps: nil
            )
            XCTFail("expected a throw for an unreadable source")
        } catch is AudioMixer.AudioMixError {
            // expected
        }
    }

    /// Output-size cap (Fix 1): a tiny 1-frame source with a huge `offsetMs`
    /// pushes `outFrames` (= offset + 1) into the tens-of-billions, so the output
    /// buffer would be hundreds of GB. This MUST throw `.badInput` (caller-
    /// correctable) BEFORE the non-throwing plane allocation — never crash/hang.
    func testHugeOffsetExceedsOutputCapThrowsBadInput() async throws {
        let sr = 44100
        // A real, decodable 1-frame source (passes the >0-frame + input-decode cap).
        let src = try makeToneWAV(frames: 1, channels: 1, sampleRate: sr, amplitude: 0.4, freq: 440)
        defer { try? FileManager.default.removeItem(at: src) }
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await AudioMixer.mixdown(
                outputPath: out.path,
                // offsetMs = 1e9 → ~4.41e10 output frames → ~176 GB buffer.
                tracks: [AudioMixer.AudioMixTrack(sourcePath: src.path, gainDb: 0, pan: 0,
                                                  offsetMs: 1_000_000_000, fadeInMs: 0, fadeOutMs: 0)],
                format: "wav", sampleRate: sr, channels: 1, bitrateKbps: nil
            )
            XCTFail("expected a throw for an output buffer that exceeds the size cap")
        } catch let err as AudioMixer.AudioMixError {
            guard case .badInput(let msg) = err else { return XCTFail("expected .badInput, got \(err)") }
            XCTAssertTrue(msg.contains("output too large"),
                          "message should explain the output is too large: \(msg)")
        }
    }

    func testMissingSourceThrowsBadInput() async throws {
        let missing = "/tmp/tw-mix-missing-\(UUID().uuidString).wav"
        let out = stagingURL(ext: "wav"); defer { try? FileManager.default.removeItem(at: out) }
        do {
            _ = try await AudioMixer.mixdown(
                outputPath: out.path,
                tracks: [AudioMixer.AudioMixTrack(sourcePath: missing, gainDb: 0, pan: 0, offsetMs: 0, fadeInMs: 0, fadeOutMs: 0)],
                format: "wav", sampleRate: 44100, channels: 1, bitrateKbps: nil
            )
            XCTFail("expected a throw for a missing source")
        } catch let err as AudioMixer.AudioMixError {
            guard case .badInput = err else { return XCTFail("expected .badInput, got \(err)") }
        }
    }

    // MARK: - Param contract (the shape the RPC layer decodes)

    func testParamDefaultsDecode() throws {
        let json: [String: Any] = [
            "outputPath": "/tmp/out.wav",
            "format": "wav",
            "sampleRate": 44100,
            "channels": 2,
            "tracks": [["sourcePath": "/tmp/a.wav"]]
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(AudioMixParams.self, from: data)
        XCTAssertEqual(parsed.outputPath, "/tmp/out.wav")
        XCTAssertEqual(parsed.format, "wav")
        XCTAssertEqual(parsed.sampleRate, 44100)
        XCTAssertEqual(parsed.channels, 2)
        XCTAssertNil(parsed.bitrateKbps)
        XCTAssertEqual(parsed.tracks.count, 1)
        XCTAssertEqual(parsed.tracks[0].sourcePath, "/tmp/a.wav")
        XCTAssertNil(parsed.tracks[0].gainDb)
        XCTAssertNil(parsed.tracks[0].pan)
        XCTAssertNil(parsed.tracks[0].offsetMs)
    }

    func testParamsFullyPopulatedDecode() throws {
        let json: [String: Any] = [
            "outputPath": "/tmp/out.m4a",
            "format": "m4a",
            "sampleRate": 48000,
            "channels": 2,
            "bitrateKbps": 256,
            "tracks": [
                ["sourcePath": "/tmp/a.wav", "gainDb": -3.0, "pan": -0.5, "offsetMs": 250.0, "fadeInMs": 100.0, "fadeOutMs": 200.0],
                ["sourcePath": "/tmp/b.m4a", "gainDb": 2.0, "pan": 1.0]
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: json)
        let parsed = try JSONDecoder().decode(AudioMixParams.self, from: data)
        XCTAssertEqual(parsed.format, "m4a")
        XCTAssertEqual(parsed.sampleRate, 48000)
        XCTAssertEqual(parsed.bitrateKbps, 256)
        XCTAssertEqual(parsed.tracks.count, 2)
        XCTAssertEqual(parsed.tracks[0].gainDb, -3.0)
        XCTAssertEqual(parsed.tracks[0].pan, -0.5)
        XCTAssertEqual(parsed.tracks[0].offsetMs, 250.0)
        XCTAssertEqual(parsed.tracks[0].fadeInMs, 100.0)
        XCTAssertEqual(parsed.tracks[0].fadeOutMs, 200.0)
        XCTAssertEqual(parsed.tracks[1].pan, 1.0)
        XCTAssertNil(parsed.tracks[1].offsetMs)
    }

    // MARK: - Helpers

    private func stagingURL(ext: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("audio-mix-staging", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("tw-\(UUID().uuidString).\(ext)")
    }

    /// Synthesize a sine-tone 16-bit WAV on disk. `channels` 1 or 2 (both
    /// channels carry the same in-phase tone). Returns the file URL.
    private func makeToneWAV(
        frames: Int, channels: Int, sampleRate: Int, amplitude: Float, freq: Double
    ) throws -> URL {
        let url = stagingURL(ext: "wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Double(sampleRate),
            AVNumberOfChannelsKey: channels,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
        let file = try AVAudioFile(forWriting: url, settings: settings)
        // Write through a float32 buffer at the SAME rate/channel layout
        // (processingFormat is float deinterleaved); AVAudioFile quantizes to int16.
        guard let pf = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate),
                                     channels: AVAudioChannelCount(channels)),
              let buffer = AVAudioPCMBuffer(pcmFormat: pf, frameCapacity: AVAudioFrameCount(frames)) else {
            throw NSError(domain: "AudioMixerTests", code: 1)
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        let twoPiFOverSr = 2.0 * Double.pi * freq / Double(sampleRate)
        if let chans = buffer.floatChannelData {
            for c in 0..<channels {
                let plane = chans[c]
                for i in 0..<frames {
                    plane[i] = amplitude * Float(sin(twoPiFOverSr * Double(i)))
                }
            }
        }
        try file.write(from: buffer)
        return url
    }

    /// Re-open an output file (WAV or M4A) and read its ENTIRE content into
    /// planar float arrays. Returns (planes, frameCount).
    private func readPlanar(_ url: URL) throws -> ([[Float]], Int64) {
        let file = try AVAudioFile(forReading: url)
        let pf = file.processingFormat
        let length = file.length
        guard length > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: pf, frameCapacity: AVAudioFrameCount(length)) else {
            return ([], 0)
        }
        try file.read(into: buffer)
        let n = Int(buffer.frameLength)
        var out: [[Float]] = []
        if let chans = buffer.floatChannelData {
            for c in 0..<Int(pf.channelCount) {
                out.append(Array(UnsafeBufferPointer(start: chans[c], count: n)))
            }
        }
        return (out, Int64(n))
    }

    private func peak<S: Sequence>(_ samples: S) -> Float where S.Element == Float {
        var m: Float = 0
        for s in samples { m = max(m, abs(s)) }
        return m
    }

    /// Peak amplitude over a [startMs, startMs+lenMs) window of a plane.
    private func windowPeak(_ plane: [Float], sr: Int, startMs: Int, lenMs: Int) -> Float {
        let start = min(plane.count, startMs * sr / 1000)
        let end = min(plane.count, start + max(1, lenMs * sr / 1000))
        guard start < end else { return 0 }
        return peak(plane[start..<end])
    }
}

// Convenience: XCTAssertEqual for Int with an accuracy window (frame counts can
// differ by an encoder's priming/quantization by a sample or two).
private func XCTAssertEqual(_ a: Int, _ b: Int, accuracy: Int,
                            _ message: @autoclosure () -> String = "",
                            file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertLessThanOrEqual(abs(a - b), accuracy, message(), file: file, line: line)
}

private func XCTAssertEqual(_ a: Int64, _ b: Int64, accuracy: Int64,
                            _ message: @autoclosure () -> String = "",
                            file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertLessThanOrEqual(abs(a - b), accuracy, message(), file: file, line: line)
}
