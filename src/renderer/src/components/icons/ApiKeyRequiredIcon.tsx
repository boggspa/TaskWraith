/*
 * ApiKeyRequiredIcon — monoline horizontal key whose bow encloses a dollar
 * sign, marking model rows that run on the user's own API key.
 *
 * Traced verbatim from design-assets/api-key-required/api-key-required.svg; the
 * path data is unchanged so the glyph stays identical to the shipped mark.
 *
 * The source art is authored on a 24×24 canvas, but its content only occupies
 * y≈6.6–17.4 — roughly the middle half. At row-glyph size that dead space would
 * shrink the visible key to a few illegible pixels, so the viewBox is cropped to
 * the content bounds (stroke half-width 0.8 included on every side) and the box
 * is sized in CSS. Aspect ratio is preserved: this glyph is wide and short, so
 * unlike CodexFastBoltIcon it must NOT use preserveAspectRatio="none" — warping
 * a circular key bow into an ellipse reads as a rendering bug.
 *
 * Deliberately NO vectorEffect="nonScalingStroke", which is the other thing
 * CodexFastBoltIcon does and this must not copy. That bolt renders 11×13 from a
 * 16×16 box — near 1:1, so a pinned stroke is faithful. This glyph downscales
 * 22.6→16 (≈0.71×), so pinning the stroke at 1.6px would render it ~1.4× heavier
 * than designed; verified by render that the serrated bit and the dollar sign
 * fill into a blob. Letting the stroke scale keeps both legible.
 */

/** Content bounds of the 24×24 source art, stroke included: x 0.7→23.3, y 5.8→18.2. */
export const API_KEY_REQUIRED_VIEW_BOX = '0.7 5.8 22.6 12.4'
export const API_KEY_REQUIRED_STROKE_WIDTH = 1.6

export function ApiKeyRequiredIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox={API_KEY_REQUIRED_VIEW_BOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={API_KEY_REQUIRED_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      {/* Bow of the key, enclosing the dollar sign. */}
      <circle cx="17.5" cy="11.6" r="5" />
      {/* Shaft with the serrated bit. */}
      <path d="M12.84 9.8H1.5v3.6h.34l2.2 4 2.2-4 2.2 4 2.2-4h2.2" />
      {/* Dollar sign: stem, then the S. */}
      <path d="M17.5 8.5v6.2" />
      <path d="M19.12 8.9h-2.16a1.35 1.35 0 0 0 0 2.7h1.08a1.35 1.35 0 0 1 0 2.7h-2.16" />
    </svg>
  )
}
