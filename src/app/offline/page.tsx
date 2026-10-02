import { deploymentBrand } from '@/lib/deployment/brand';

export const metadata = { title: 'Offline' };

export default function Offline() {
  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-dvh flex-col items-center justify-center p-8 text-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="h-14 w-14" />
      <div className="gold-rule my-5" />
      <h1 className="font-display text-2xl text-cream">You&apos;re offline</h1>
      <p className="mt-2 max-w-sm text-sm text-muted">
        {deploymentBrand().productName} needs a connection for live fleet data. Reconnect and we&apos;ll
        pick up where you left off.
      </p>
    </main>
  );
}
