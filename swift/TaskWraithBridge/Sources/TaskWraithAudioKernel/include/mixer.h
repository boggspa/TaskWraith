/*
 * TaskWraithAudioKernel — pure-C, framework-free offline multitrack mixer.
 *
 * This is the DSP kernel for `audio.mixdown` (S4 of the native AV pipeline).
 * The Swift side (`AudioMixer.swift`) decodes each source WAV/M4A into planar
 * float32, computes per-source placement/fade frame counts, gathers the planar
 * channel pointers, and hands them here as `TWMixSource[]`. This kernel is the
 * ONLY place the per-sample summing/gain/pan/fade/soft-limit math lives.
 *
 * Contract (LOCKED, from the DSP-correctness review):
 *   - Sum in float32, NO per-track clamp.
 *   - Soft-limit ONCE after summing, per output sample (cubic soft-knee).
 *   - Gain dB->linear via powf(10, dB/20); the dB is clamped to [-60,+12] in
 *     Swift before it reaches here (we apply whatever is in `gainDb`).
 *   - Pan is equal-power; stereo->stereo is a BALANCE (not a matrix).
 *   - Fades are equal-power cosine, source-local position based.
 *   - Placement: output frame g contributes source-local p = g - startFrame
 *     iff 0 <= p < frameCount.
 *
 * Purity rules: NO malloc, NO locks, NO abort/exit, NO printf, NO globals, NO
 * threads. Single-threaded, feed-forward, deterministic. Only <stddef.h> and
 * <stdint.h> are included; <math.h> is pulled in by the .c (not the public
 * header) so consumers of this header stay framework/lib-free.
 */
#ifndef TASKWRAITH_AUDIO_MIXER_H
#define TASKWRAITH_AUDIO_MIXER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * One source laid onto the output timeline. The audio is PLANAR float32:
 * `channels[c]` points to a `frameCount`-length plane for channel c, with c in
 * [0, channelCount). Pointers are owned by the caller and must outlive the
 * `tw_mix` call.
 */
typedef struct {
    /* Planar channel pointers; channels[c] is a frameCount-length float plane. */
    const float *const *channels;
    /* 1 (mono) or 2 (stereo). Sources with >2 channels are rejected in Swift. */
    int32_t channelCount;
    /* Length (in frames/samples) of each plane in `channels`. */
    int64_t frameCount;
    /* Placement offset on the OUTPUT timeline, in samples. May be 0. */
    int64_t startFrame;
    /* Fade-in length in frames (0 = no fade-in). Clamped <= frameCount in Swift. */
    int64_t fadeInFrames;
    /* Fade-out length in frames (0 = no fade-out). Clamped <= frameCount in Swift. */
    int64_t fadeOutFrames;
    /* Gain in dB (clamped to [-60,+12] in Swift before it reaches here). */
    float   gainDb;
    /* Stereo pan / balance in [-1,+1]. Ignored when the OUTPUT is mono. */
    float   pan;
} TWMixSource;

/*
 * Mix `sourceCount` sources into the planar output (`out` is `outChannelCount`
 * planes, each `outFrames` floats long). The output planes are ZEROED first,
 * then each source has gain -> pan -> fade -> placement applied and is summed
 * in; finally each output sample is soft-limited once.
 *
 * `outChannelCount` must be 1 or 2. Returns 0 on success, a negative value on a
 * bad argument (null pointers, out-of-range channel counts, negative frame
 * counts). The function never allocates, never blocks, and is safe to call from
 * any thread (it touches no shared state).
 */
int tw_mix(const TWMixSource *sources, size_t sourceCount,
           float *const *out, int32_t outChannelCount, int64_t outFrames);

#ifdef __cplusplus
}
#endif

#endif /* TASKWRAITH_AUDIO_MIXER_H */
