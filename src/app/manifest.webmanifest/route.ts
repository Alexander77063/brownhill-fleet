import { deploymentBrand } from '@/lib/deployment/brand';

/**
 * The web app manifest, generated from the build's own brand.
 *
 * This used to be a static file at public/manifest.webmanifest with the
 * product name hardcoded to "Elite Fleet Management". Everything else in the
 * app — the window title, the application name, the sign-in panel — is named
 * from `deploymentBrand()`, so a Brownhill build called its own window
 * "Brownhill Fleet" while the install prompt on the operator's phone still
 * said "Elite Fleet Management".
 *
 * The static file has to go: Next serves `public/` ahead of an App Router
 * route on the same path, so the two would fight and the static one would
 * win.
 */

// The brand is fixed at build time (DEPLOYMENT_PROFILE / NEXT_PUBLIC_PRODUCT_NAME
// are inlined by the compiler), so this can be a static route.
export const dynamic = 'force-static';

const ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
];

export function GET(): Response {
  const { productName } = deploymentBrand();

  const manifest = {
    name: productName,
    short_name: productName,
    description: 'Fleet, drivers, agreements, money and compliance — in one system.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#060b14',
    theme_color: '#0a1628',
    categories: ['business', 'finance', 'productivity'],
    icons: ICONS,
  };

  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      'content-type': 'application/manifest+json',
      'cache-control': 'public, max-age=3600',
    },
  });
}
