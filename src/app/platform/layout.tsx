import Link from "next/link";
import { isPlatformAdmin } from "@/lib/auth/context";
import { PageHeader, Card } from "@/components/ui";
import { deploymentProfile } from "@/lib/deployment/profile";
import { collectionReadiness } from "@/lib/collection/readiness";
import { escalationConfigured } from "@/lib/requests";

export const dynamic = "force-dynamic";

/** Platform super-admin console (SP-A) — global catalogue + cross-tenant tools.
 *  Gated distinctly from the tenant `/admin`: only platform admins get in. */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isPlatformAdmin())) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <PageHeader eyebrow="Platform" title="Platform console" />
        <Card>
          <p className="text-sm text-muted">Platform admin access required.</p>
        </Card>
      </div>
    );
  }

  // Only builds with vehicle owners run the escalation ladder; on those, an
  // instance that cannot reach anyone must say so on every console page.
  const profile = deploymentProfile();
  const ownerBuild = profile.ownerPortal;
  const [readiness, collection] = await Promise.all([
    ownerBuild ? escalationConfigured().catch(() => null) : null,
    // NG-2: a pay-first instance that cannot issue or take payment says so on every page.
    profile.subscriptionBilling ? collectionReadiness().catch(() => null) : null,
  ]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      {readiness?.broken && (
        <p role="alert" className="mb-4 rounded-md border border-[var(--color-loss)] px-3 py-2 text-sm text-[var(--color-loss)]">
          Escalation is not configured — emergencies are not reaching anyone.{" "}
          <Link href="/platform/oncall" className="underline">
            Fix the on-call roster
          </Link>
          .
        </p>
      )}
      {collection?.applies && !collection.ok && (
        <p role="alert" className="mb-4 rounded-md border border-amber-500/60 px-3 py-2 text-sm text-parchment">
          Collection is not ready: {collection.reasons.join(" ")}{" "}
          <Link href="/platform/settings" className="underline">
            Settings
          </Link>
          {" · "}
          <Link href="/platform/catalogue" className="underline">
            Catalogue
          </Link>
        </p>
      )}
      <header className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-hair-soft pb-4">
        <span className="font-display text-lg text-cream">
          Elite Fleet Management
        </span>
        <span className="eyebrow">Platform Console</span>
        <nav className="ml-auto flex flex-wrap gap-4 text-sm">
          <Link href="/platform" className="text-muted transition hover:text-cream">
            Overview
          </Link>
          <Link href="/platform/subscribers" className="text-muted transition hover:text-cream">
            Subscribers
          </Link>
          <Link href="/platform/requests" className="text-muted transition hover:text-cream">
            Requests
          </Link>
          <Link href="/platform/analytics" className="text-muted transition hover:text-cream">
            Analytics
          </Link>
          <Link href="/platform/catalogue" className="text-muted transition hover:text-cream">
            Catalogue
          </Link>
          {collection?.applies && (
            <Link href="/platform/collections" className="text-muted transition hover:text-cream">
              Collections
            </Link>
          )}
          {profile.subscriptionBilling && (
            <Link href="/platform/settings" className="text-muted transition hover:text-cream">
              Settings
            </Link>
          )}
          {ownerBuild && (
            <>
              <Link href="/platform/owners" className="text-muted transition hover:text-cream">
                Owners
              </Link>
              <Link href="/platform/assistance" className="text-muted transition hover:text-cream">
                Assistance
              </Link>
              <Link href="/platform/oncall" className="text-muted transition hover:text-cream">
                On-call
              </Link>
              <Link href="/platform/hardware" className="text-muted transition hover:text-cream">
                Hardware
              </Link>
            </>
          )}
          <Link href="/platform/copilot" className="text-muted transition hover:text-cream">
            Copilot
          </Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
