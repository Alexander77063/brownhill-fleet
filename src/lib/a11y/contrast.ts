/**
 * WCAG 2.1 contrast maths.
 *
 * Every colour in this product is a design token in `globals.css`, so contrast is
 * arithmetic over a known table rather than something that needs a browser. That makes
 * it testable in CI with no flake — see `tests/unit/a11y-contrast.test.ts`.
 *
 * Reference: WCAG 2.1 §1.4.3 (Contrast Minimum, AA) and §1.4.11 (Non-text Contrast, AA).
 */

export type Rgb = { r: number; g: number; b: number };

/** Parse `#rgb`, `#rrggbb`, or `rgba(r, g, b, a)`. Alpha is returned separately. */
export function parseColor(input: string): { rgb: Rgb; alpha: number } {
  const value = input.trim();

  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => Number.parseFloat(p.trim()));
    const [r, g, b, a = 1] = parts;
    return { rgb: { r, g, b }, alpha: a };
  }

  const hex = value.replace(/^#/, '');
  if (hex.length === 3) {
    return {
      rgb: {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      },
      alpha: 1,
    };
  }
  if (hex.length === 6) {
    return {
      rgb: {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      },
      alpha: 1,
    };
  }
  throw new Error(`Unsupported colour format: ${input}`);
}

/**
 * Composite a possibly-translucent foreground over an opaque backdrop.
 * Several of our surface tokens are `rgba(255,255,255,0.04)` overlays, so the effective
 * colour depends on what sits beneath them.
 */
export function flatten(over: string, backdrop: string): string {
  const fg = parseColor(over);
  const bg = parseColor(backdrop);
  if (fg.alpha >= 1) return toHex(fg.rgb);
  const mix = (c: 'r' | 'g' | 'b') => fg.rgb[c] * fg.alpha + bg.rgb[c] * (1 - fg.alpha);
  return toHex({ r: mix('r'), g: mix('g'), b: mix('b') });
}

export function toHex({ r, g, b }: Rgb): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG relative luminance (sRGB). */
export function relativeLuminance(color: string): number {
  const { rgb } = parseColor(color);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG contrast ratio between two opaque colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round to 2dp the way reporting tools do, so assertions read like the ACR. */
export function ratio(a: string, b: string): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}

/** AA threshold for a given text size. Large text = >=18.66px bold, or >=24px. */
export function aaThreshold(kind: 'normal' | 'large' | 'non-text'): number {
  return kind === 'normal' ? 4.5 : 3;
}

export function passesAA(a: string, b: string, kind: 'normal' | 'large' | 'non-text' = 'normal') {
  return contrastRatio(a, b) >= aaThreshold(kind);
}
