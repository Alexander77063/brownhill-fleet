// tests/unit/a11y-contrast-maths.test.ts
//
// The contrast arithmetic, pinned to the WCAG reference values.
//
// WHY THIS TEST EXISTS
// --------------------
// `src/lib/a11y/contrast.ts` is the maths every contrast assertion in this
// repository rests on. It shipped with no importer and no test: the test file
// it names in its own docstring — `tests/unit/a11y-contrast.test.ts` — did
// not exist, so nothing had ever exercised it.
//
// That matters more than it sounds. The token gate asks "does this colour
// clear 4.5:1?", and the answer comes out of this library. A library that
// returned 21 for every pair would make every token gate pass, forever, and
// the failure would look exactly like success.
//
// So the library is pinned to values that can be checked by hand — the
// canonical greys from the WCAG success-criteria examples, black and white,
// and the alpha compositing that the surface tokens depend on.

import { describe, expect, it } from 'vitest';
import {
  aaThreshold,
  contrastRatio,
  flatten,
  parseColor,
  passesAA,
  ratio,
  relativeLuminance,
  toHex,
} from '@/lib/a11y/contrast';

describe('parseColor', () => {
  it('reads a six-digit hex', () => {
    expect(parseColor('#1a2438')).toEqual({ rgb: { r: 26, g: 36, b: 56 }, alpha: 1 });
  });

  it('reads a three-digit hex by doubling each digit', () => {
    expect(parseColor('#abc')).toEqual({ rgb: { r: 170, g: 187, b: 204 }, alpha: 1 });
  });

  it('reads rgba, keeping the alpha separate', () => {
    expect(parseColor('rgba(16, 24, 40, 0.12)')).toEqual({
      rgb: { r: 16, g: 24, b: 40 },
      alpha: 0.12,
    });
  });

  it('treats rgb() as fully opaque', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ rgb: { r: 1, g: 2, b: 3 }, alpha: 1 });
  });

  it('refuses a colour it does not understand', () => {
    // A silent NaN would poison every ratio computed from it.
    expect(() => parseColor('not-a-colour')).toThrow(/Unsupported colour format/);
    expect(() => parseColor('#12345')).toThrow(/Unsupported colour format/);
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('is between the two, and rises with lightness', () => {
    const mid = relativeLuminance('#767676');
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(relativeLuminance('#a0a0a0')).toBeGreaterThan(mid);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for a colour on itself', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('matches the greys in the WCAG worked examples', () => {
    // #767676 on white is the canonical "smallest grey that passes AA for
    // body text"; #777777 is the canonical one that does not. If the
    // arithmetic drifts, these two move apart and the token gate's verdicts
    // become fiction.
    expect(ratio('#767676', '#ffffff')).toBe(4.54);
    expect(ratio('#777777', '#ffffff')).toBe(4.48);
  });

  it('does not care which way round the pair is written', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#767676'),
      10,
    );
  });

  it('is never below 1', () => {
    expect(contrastRatio('#5f6a7c', '#5f6a7c')).toBeGreaterThanOrEqual(1);
  });
});

describe('flatten', () => {
  it('leaves an opaque colour alone', () => {
    expect(flatten('#123456', '#abcdef')).toBe('#123456');
  });

  it('returns the backdrop when the foreground is fully transparent', () => {
    expect(flatten('rgba(0, 0, 0, 0)', '#123456')).toBe('#123456');
  });

  it('returns the foreground when the foreground is fully opaque', () => {
    expect(flatten('#123456', 'rgba(0, 0, 0, 0)')).toBe('#123456');
  });

  it('mixes a translucent foreground towards the backdrop', () => {
    const mixed = flatten('rgba(255, 255, 255, 0.5)', '#000000');
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
    // Half white over black lands in the middle.
    const value = parseInt(mixed.slice(1), 16);
    const r = (value >> 16) & 255;
    expect(r).toBeGreaterThan(120);
    expect(r).toBeLessThan(136);
  });

  it('stays closer to the backdrop the more transparent the foreground', () => {
    const barely = flatten('rgba(255, 255, 255, 0.1)', '#000000');
    const mostly = flatten('rgba(255, 255, 255, 0.9)', '#000000');
    const lightness = (hex: string) => parseInt(hex.slice(1, 3), 16);
    expect(lightness(barely)).toBeLessThan(lightness(mostly));
  });
});

describe('toHex', () => {
  it('pads a channel to two digits', () => {
    expect(toHex({ r: 0, g: 5, b: 255 })).toBe('#0005ff');
  });

  it('clamps a channel that is out of range', () => {
    expect(toHex({ r: -20, g: 300, b: 128 })).toBe('#00ff80');
  });
});

describe('ratio', () => {
  it('rounds to two decimal places, the way reporting tools do', () => {
    expect(ratio('#767676', '#ffffff')).toBe(4.54);
    expect(ratio('#000000', '#ffffff')).toBe(21);
  });
});

describe('aaThreshold', () => {
  it('is 4.5 for normal text and 3 for large text and non-text', () => {
    expect(aaThreshold('normal')).toBe(4.5);
    expect(aaThreshold('large')).toBe(3);
    expect(aaThreshold('non-text')).toBe(3);
  });
});

describe('passesAA', () => {
  it('separates the passing grey from the failing one at body-text size', () => {
    expect(passesAA('#767676', '#ffffff')).toBe(true);
    expect(passesAA('#777777', '#ffffff')).toBe(false);
  });

  it('lets the failing grey through at large-text size', () => {
    expect(passesAA('#777777', '#ffffff', 'large')).toBe(true);
  });

  it('holds a non-text component to the same 3:1 bar', () => {
    expect(passesAA('#949494', '#ffffff', 'non-text')).toBe(true);
    expect(passesAA('#a0a0a0', '#ffffff', 'non-text')).toBe(false);
  });
});
