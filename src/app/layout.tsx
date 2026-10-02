import type { Metadata, Viewport } from 'next';
import { fraunces, archivo } from '@/lib/fonts';
import { ServiceWorkerRegister } from '@/components/ServiceWorkerRegister';
import { deploymentBrand } from '@/lib/deployment/brand';
import './globals.css';

// Named from the build, not hardcoded: a self-hosted install should not put a
// platform's name in the customer's window title and PWA entry.
const PRODUCT = deploymentBrand().productName;

export const metadata: Metadata = {
  title: {
    default: PRODUCT,
    template: `%s · ${PRODUCT}`,
  },
  description:
    'Fleet, drivers, agreements, money and compliance — in one system.',
  manifest: '/manifest.webmanifest',
  applicationName: PRODUCT,
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: PRODUCT },
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/icons/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a1628',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${fraunces.variable} ${archivo.variable}`}>
      <body className="relative">
        <div className="relative z-10">{children}</div>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
