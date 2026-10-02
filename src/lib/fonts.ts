import { Fraunces, Archivo } from 'next/font/google';

// Display: a high-contrast, characterful serif — luxury, editorial, distinctive.
export const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-fraunces',
  display: 'swap',
});

// UI / data: a precise grotesque with tabular figures for dense financial tables.
export const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-archivo',
  display: 'swap',
});
