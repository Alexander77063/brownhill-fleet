// tests/unit/handover-photo-kind.test.ts
// Pure-function tests for the vehicle-handover photo rule. The /sign/[token]
// flow asks the driver to photograph the vehicle before / after handover;
// this rule pins the allowed kinds and the minimum-photo gate so the
// UI shows the same set everywhere and the "incomplete" state has one
// definition, not five.

import { describe, expect, it } from 'vitest';
import {
  isValidHandoverPhotoKind,
  HANDOVER_PHOTO_KINDS,
  isCompleteHandover,
  MIN_HANDOVER_PHOTOS,
  suggestedHandoverKinds,
} from '@/lib/sign/handover-photo';

describe('HANDOVER_PHOTO_KINDS', () => {
  it('contains the four exterior sides + interior + dashboard + other', () => {
    expect(HANDOVER_PHOTO_KINDS).toEqual([
      'front', 'back', 'left', 'right', 'interior', 'dashboard', 'other',
    ]);
  });
});

describe('MIN_HANDOVER_PHOTOS', () => {
  it('is 4 (exterior 4-corner walkaround is the minimum)', () => {
    expect(MIN_HANDOVER_PHOTOS).toBe(4);
  });
});

describe('isValidHandoverPhotoKind', () => {
  it('accepts each kind in the allow-list', () => {
    for (const k of HANDOVER_PHOTO_KINDS) {
      expect(isValidHandoverPhotoKind(k)).toBe(true);
    }
  });
  it('rejects unknown kinds', () => {
    expect(isValidHandoverPhotoKind('roof')).toBe(false);
    expect(isValidHandoverPhotoKind('')).toBe(false);
    expect(isValidHandoverPhotoKind('FRONT')).toBe(false);
  });
});

describe('suggestedHandoverKinds', () => {
  it('returns the first four kinds (the exterior walkaround) by default', () => {
    expect(suggestedHandoverKinds()).toEqual(['front', 'back', 'left', 'right']);
  });
});

describe('isCompleteHandover', () => {
  it('returns false when no photos supplied', () => {
    expect(isCompleteHandover([])).toBe(false);
  });
  it('returns false with below the minimum count, even when kinds are unique', () => {
    expect(isCompleteHandover(['front', 'back', 'left'])).toBe(false);
  });
  it('returns true at the minimum count', () => {
    expect(isCompleteHandover(['front', 'back', 'left', 'right'])).toBe(true);
  });
  it('returns true above the minimum', () => {
    expect(isCompleteHandover(['front', 'back', 'left', 'right', 'dashboard'])).toBe(true);
  });
  it('counts distinct kinds, not raw rows (four front photos is NOT complete)', () => {
    expect(isCompleteHandover(['front', 'front', 'front', 'front'])).toBe(false);
  });
});