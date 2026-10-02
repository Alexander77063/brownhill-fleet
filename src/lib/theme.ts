import { cookies } from 'next/headers';

export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'theme';

/** The app-shell theme for this request, read from the `theme` cookie server-side
 *  so the shell renders with the right `data-theme` immediately (no flash). Defaults
 *  to the brand's dark theme. */
export async function getTheme(): Promise<Theme> {
  const store = await cookies();
  return store.get(THEME_COOKIE)?.value === 'light' ? 'light' : 'dark';
}
