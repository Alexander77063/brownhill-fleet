// src/lib/sign/handover-photo.ts
// Pure helpers for the vehicle-handover photo rule. The /sign/[token]
// flow asks the driver to photograph the vehicle before / after
// handover; this module pins the allowed kinds and the minimum-photo
// gate so the UI shows the same set everywhere.

export type HandoverPhotoKind =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'interior'
  | 'dashboard'
  | 'other';

export const HANDOVER_PHOTO_KINDS: ReadonlyArray<HandoverPhotoKind> = [
  'front', 'back', 'left', 'right', 'interior', 'dashboard', 'other',
];

export const HANDOVER_PHOTO_LABELS: Readonly<Record<HandoverPhotoKind, string>> = {
  front: 'Front',
  back: 'Back',
  left: 'Left side',
  right: 'Right side',
  interior: 'Interior',
  dashboard: 'Dashboard',
  other: 'Other',
};

export const MIN_HANDOVER_PHOTOS = 4;

export function isValidHandoverPhotoKind(s: string): s is HandoverPhotoKind {
  return (HANDOVER_PHOTO_KINDS as ReadonlyArray<string>).includes(s);
}

/** The four-exterior walkaround the UI prompts for by default. */
export function suggestedHandoverKinds(): ReadonlyArray<HandoverPhotoKind> {
  return ['front', 'back', 'left', 'right'];
}

/**
 * Has the driver uploaded enough photos for the handover to count as
 * recorded? Counts distinct kinds, not raw rows — four photos of the
 * front bumper is not a complete walkaround.
 */
export function isCompleteHandover(present: ReadonlyArray<string>): boolean {
  const distinct = new Set(present.filter(isValidHandoverPhotoKind));
  return distinct.size >= MIN_HANDOVER_PHOTOS;
}