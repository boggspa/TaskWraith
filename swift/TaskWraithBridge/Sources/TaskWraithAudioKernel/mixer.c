/*
 * TaskWraithAudioKernel — mixer.c
 *
 * Pure-C offline multitrack mix kernel. See include/mixer.h for the ABI and the
 * LOCKED DSP contract. Everything here is feed-forward float32 math; no malloc,
 * no locks, no globals, no I/O.
 */
#include "mixer.h"

#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/*
 * Cubic soft-knee limiter, applied ONCE per output sample after summing.
 * Identity below |x| <= 0.9; above the knee it compresses toward ~1.0 so a
 * summed overshoot is tamed without a hard clip. (Exact form from the DSP
 * review — do not "improve" the constants.)
 */
static inline float tw_soft_limit(float x) {
    /* A non-finite sample (NaN/Inf — e.g. a poisoned source plane) would
     * otherwise propagate: Inf runs the knee formula to 0.9 + Inf/Inf = NaN and
     * corrupts the whole WAV/AAC. Map it to silence at that output sample. */
    if (!isfinite(x)) {
        return 0.0f;
    }
    float ax = fabsf(x);
    if (ax <= 0.9f) {
        return x;
    }
    float e = ax - 0.9f;
    return copysignf(0.9f + e / (1.0f + e * e), x);
}

/* dB -> linear amplitude. The dB is pre-clamped to [-60,+12] in Swift. */
static inline float tw_db_to_linear(float db) {
    return powf(10.0f, db / 20.0f);
}

int tw_mix(const TWMixSource *sources, size_t sourceCount,
           float *const *out, int32_t outChannelCount, int64_t outFrames) {
    /* --- Argument validation (no abort; negative return on bad args) ------- */
    if (out == NULL) {
        return -1;
    }
    if (outChannelCount != 1 && outChannelCount != 2) {
        return -2;
    }
    if (outFrames < 0) {
        return -3;
    }
    /* A null `out` plane is fatal; we are about to write into every plane. */
    for (int32_t c = 0; c < outChannelCount; ++c) {
        if (out[c] == NULL) {
            return -4;
        }
    }
    /* sourceCount > 0 requires a sources pointer. */
    if (sourceCount > 0 && sources == NULL) {
        return -5;
    }

    /* --- Zero the output planes -------------------------------------------- */
    for (int32_t c = 0; c < outChannelCount; ++c) {
        float *plane = out[c];
        for (int64_t i = 0; i < outFrames; ++i) {
            plane[i] = 0.0f;
        }
    }

    /* Nothing to mix (still a valid request: silence of length outFrames). */
    if (outFrames == 0 || sourceCount == 0) {
        return 0;
    }

    float *outL = out[0];
    float *outR = (outChannelCount == 2) ? out[1] : NULL;

    /* --- Sum each source -------------------------------------------------- */
    for (size_t s = 0; s < sourceCount; ++s) {
        const TWMixSource src = sources[s];

        /* Per-source argument sanity. A degenerate source is skipped (not a
         * hard error) so one bad track can't void the whole mix; truly fatal
         * shape problems (null channels with frames) return negative. */
        if (src.frameCount <= 0) {
            continue; /* empty source contributes nothing */
        }
        if (src.channelCount != 1 && src.channelCount != 2) {
            return -6;
        }
        if (src.channels == NULL) {
            return -7;
        }
        const float *srcL = src.channels[0];
        if (srcL == NULL) {
            return -8;
        }
        const float *srcR = (src.channelCount == 2) ? src.channels[1] : NULL;
        if (src.channelCount == 2 && srcR == NULL) {
            return -9;
        }

        const float gain = tw_db_to_linear(src.gainDb);

        /* Clamp fades so they fit inside the source. If both together exceed
         * frameCount, split the source in half (fadeIn = n/2, fadeOut = rest).
         * Swift also clamps, but we re-clamp here so a direct kernel call is
         * safe. */
        int64_t fadeIn = src.fadeInFrames;
        int64_t fadeOut = src.fadeOutFrames;
        if (fadeIn < 0) fadeIn = 0;
        if (fadeOut < 0) fadeOut = 0;
        if (fadeIn > src.frameCount) fadeIn = src.frameCount;
        if (fadeOut > src.frameCount) fadeOut = src.frameCount;
        if (fadeIn + fadeOut > src.frameCount) {
            fadeIn = src.frameCount / 2;
            fadeOut = src.frameCount - fadeIn;
        }

        /* Equal-power pan coefficients (used for a mono source -> stereo out,
         * and as the L/R balance scalars for a stereo source -> stereo out). */
        float pan = src.pan;
        if (pan < -1.0f) pan = -1.0f;
        if (pan > 1.0f) pan = 1.0f;
        const float pn = (pan + 1.0f) * 0.5f;
        const float panL = cosf(0.5f * (float)M_PI * pn);
        const float panR = sinf(0.5f * (float)M_PI * pn);
        /* Stereo-source balance: attenuate the opposite channel only. */
        const float balL = (pan <= 0.0f) ? 1.0f : cosf(0.5f * (float)M_PI * pan);
        const float balR = (pan >= 0.0f) ? 1.0f : cosf(0.5f * (float)M_PI * (-pan));

        /* Intersect the source's placed span with the output window so we only
         * iterate the frames that actually land in [0,outFrames). */
        int64_t gStart = src.startFrame;
        if (gStart < 0) gStart = 0; /* a source-local p<0 region never contributes */
        /* gEnd = startFrame + frameCount (exclusive). Use a saturating add so a
         * startFrame near INT64_MAX cannot invoke signed-overflow UB under -O2;
         * on overflow fall back to outFrames (it is clamped to outFrames just
         * below anyway, so this is behavior-identical for every in-range input).
         * The Swift output-size cap already bounds real calls; this is defensive. */
        int64_t gEnd;
        if (__builtin_add_overflow(src.startFrame, src.frameCount, &gEnd)) {
            gEnd = outFrames;
        }
        if (gEnd > outFrames) gEnd = outFrames;

        for (int64_t g = gStart; g < gEnd; ++g) {
            const int64_t p = g - src.startFrame; /* source-local position */
            if (p < 0 || p >= src.frameCount) {
                continue; /* defensive; the loop bounds already guarantee this */
            }

            /* Equal-power cosine fade envelope from the source-local position. */
            float env_in = 1.0f;
            if (fadeIn > 0 && p < fadeIn) {
                env_in = sinf(0.5f * (float)M_PI * ((float)p / (float)fadeIn));
            }
            float env_out = 1.0f;
            const int64_t q = src.frameCount - 1 - p; /* distance from the tail */
            if (fadeOut > 0 && q < fadeOut) {
                env_out = sinf(0.5f * (float)M_PI * ((float)q / (float)fadeOut));
            }
            const float env = env_in * env_out;
            const float k = gain * env; /* combined per-sample scalar */

            if (outChannelCount == 2) {
                if (src.channelCount == 1) {
                    /* Mono source -> stereo out: equal-power pan. */
                    const float v = srcL[p] * k;
                    outL[g] += v * panL;
                    outR[g] += v * panR;
                } else {
                    /* Stereo source -> stereo out: balance (NOT a matrix). */
                    outL[g] += srcL[p] * k * balL;
                    outR[g] += srcR[p] * k * balR;
                }
            } else {
                /* Mono output (pan ignored). */
                if (src.channelCount == 1) {
                    outL[g] += srcL[p] * k;
                } else {
                    /* Stereo source -> mono out: -3dB downmix. */
                    outL[g] += (srcL[p] + srcR[p]) * 0.70710678f * k;
                }
            }
        }
    }

    /* --- Soft-limit each output sample once -------------------------------- */
    for (int32_t c = 0; c < outChannelCount; ++c) {
        float *plane = out[c];
        for (int64_t i = 0; i < outFrames; ++i) {
            plane[i] = tw_soft_limit(plane[i]);
        }
    }

    return 0;
}
