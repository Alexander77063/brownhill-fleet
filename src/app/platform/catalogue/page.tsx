import { requirePlatformAdmin } from "@/lib/auth/context";
import {
  PageHeader,
  Card,
  CardTitle,
  Button,
  Badge,
  Table,
  Th,
  Td,
} from "@/components/ui";
import { listCatalogue, listPlanOneOffs } from "@/lib/catalogue/manage";
import { regionOf } from "@/lib/catalogue/region";
import { isUnpriced, isUnpricedItem } from "@/lib/collection/pricing";
import { FEATURE_KEYS } from "@/lib/entitlements";
import { formatMoney } from "@/lib/money";
import { deploymentProfile } from "@/lib/deployment/profile";
import { regionProvider } from "@/lib/region";
import { createServiceClient } from "@/lib/supabase/server";
import {
  createPlanAction,
  updatePlanAction,
  createAddonAction,
  updateAddonAction,
} from "@/lib/actions/platform";

export const dynamic = "force-dynamic";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

const INTERVAL_LABEL: Record<string, string> = { month: "month", half_year: "6 months", year: "year" };
const AUDIENCE_LABEL: Record<string, string> = { all: "everyone", business: "fleets & insurers", individual: "individuals" };
const ADDITIONS_LABEL: Record<string, string> = { immediate: "charge at once", monthly_batch: "monthly batch" };

/** A per-vehicle plan at 0 has not been priced yet; say so instead of "₦0.00".
 *  The predicate lives in src/lib/collection/pricing.ts — the same one that
 *  refuses to invoice — so the console and the money can never disagree. */
function price(p: {
  base_price_pence: number;
  per_vehicle: boolean;
  region: string | null;
}) {
  if (isUnpriced(p)) return "unpriced";
  const amount = formatMoney(p.base_price_pence, { region: regionOf(p) });
  return p.per_vehicle ? `${amount} / vehicle` : amount;
}

function itemPrice(a: { unit_price_pence: number; region: string | null }) {
  return isUnpricedItem(a) ? "unpriced" : formatMoney(a.unit_price_pence, { region: regionOf(a) });
}

export default async function CataloguePage() {
  // A layout is not an authorisation boundary in the App Router: the page
  // segment renders regardless. Every console page checks for itself.
  await requirePlatformAdmin();
  const sb = createServiceClient();
  // The global catalogue lists EVERY market — this is the only place a plan can
  // be edited, so hiding the other region's rows would hide them from the
  // console entirely. Tenant-facing pickers filter by region and audience instead.
  const [{ plans, addons }, pf, oneOffsOf] = await Promise.all([
    listCatalogue(sb),
    sb.from("plan_features").select("plan_id, feature_key"),
    listPlanOneOffs(sb),
  ]);
  const featuresOf = new Map<string, Set<string>>();
  for (const r of pf.data ?? []) {
    if (!featuresOf.has(r.plan_id)) featuresOf.set(r.plan_id, new Set());
    featuresOf.get(r.plan_id)?.add(r.feature_key);
  }
  const defaultRegion = deploymentProfile().region;
  const oneOffItems = addons.filter((a) => a.kind === "one_off");
  const recurring = addons.filter((a) => a.kind !== "one_off");
  const unpricedActive = [
    ...plans.filter((p) => p.active && isUnpriced(p)).map((p) => p.name),
    ...oneOffItems.filter((a) => a.active && isUnpricedItem(a)).map((a) => a.name),
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Catalogue"
        title="Plans, one-off items & add-ons"
        subtitle="The global product catalogue every tenant subscribes to. Prices are integer minor units — pence for uk, kobo for ng — and VAT-exclusive. Nothing here is hardcoded: a plan at 0 is unpriced and cannot be invoiced."
      />

      {unpricedActive.length > 0 && (
        <div role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-parchment">
          <strong>Unpriced and active:</strong> {unpricedActive.join(", ")}. No invoice can be raised against these until a price is set.
        </div>
      )}

      {/* Plans */}
      <Card>
        <CardTitle>Plans</CardTitle>
        <Table caption="Plans">
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Name</Th>
              <Th>Region</Th>
              <Th>Sold to</Th>
              <Th>Price</Th>
              <Th>Term</Th>
              <Th>Additions</Th>
              <Th>Active</Th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <Td>{p.key}</Td>
                <Td>{p.name}</Td>
                <Td>{regionOf(p)}</Td>
                <Td>{AUDIENCE_LABEL[p.audience] ?? p.audience}</Td>
                <Td>{price(p)}</Td>
                <Td>{INTERVAL_LABEL[p.interval] ?? p.interval}</Td>
                <Td>{p.per_vehicle ? (ADDITIONS_LABEL[p.additions_billing] ?? p.additions_billing) : "—"}</Td>
                <Td>
                  {p.active ? (
                    <Badge>active</Badge>
                  ) : (
                    <span className="text-muted">off</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {/* Edit-in-place, one collapsed form per plan */}
      {plans.map((p) => {
        const region = regionOf(p);
        const itemsForRegion = oneOffItems.filter((a) => regionOf(a) === region);
        return (
          <details key={p.id} className="rounded-lg border border-hair">
            <summary
              className="cursor-pointer px-4 py-2 text-sm text-parchment"
              aria-label={`Edit plan ${p.key}`}
            >
              Edit {p.name} <span className="text-muted">({p.key})</span>
            </summary>
            <form action={updatePlanAction} className="space-y-3 p-4">
              <input type="hidden" name="id" value={p.id} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Name">
                  <input
                    name="name"
                    defaultValue={p.name}
                    className={`${inputCls} w-full`}
                  />
                </Field>
                <Field
                  label={`Price (${regionProvider(region).currency.minorName}${p.per_vehicle ? ", per vehicle" : ""}, ex VAT)`}
                  hint="Integer minor units. 0 on a per-vehicle plan means unpriced."
                >
                  <input
                    name="base_price_pence"
                    type="number"
                    min="0"
                    defaultValue={p.base_price_pence}
                    className={`${inputCls} w-full`}
                  />
                </Field>
                <Field label="Term">
                  <select
                    name="interval"
                    defaultValue={p.interval}
                    className={`${inputCls} w-full`}
                  >
                    <option value="month">month</option>
                    <option value="half_year">6 months</option>
                    <option value="year">year</option>
                  </select>
                </Field>
                <Field label="Region">
                  <select
                    name="region"
                    defaultValue={region}
                    className={`${inputCls} w-full`}
                  >
                    <option value="uk">uk</option>
                    <option value="ng">ng</option>
                  </select>
                </Field>
                <Field label="Sold to" hint="Dedicated instances see business plans; the shared instance sees individual plans.">
                  <select name="audience" defaultValue={p.audience} className={`${inputCls} w-full`}>
                    <option value="all">everyone</option>
                    <option value="business">fleets & insurers</option>
                    <option value="individual">individuals</option>
                  </select>
                </Field>
                <Field label="Vehicles added mid-term" hint="Charge at once (individuals pay now) or batch into one pro-rata invoice a month (B2B).">
                  <select name="additions_billing" defaultValue={p.additions_billing} className={`${inputCls} w-full`}>
                    <option value="immediate">charge at once</option>
                    <option value="monthly_batch">monthly batch</option>
                  </select>
                </Field>
                <label className="flex items-center gap-1.5 text-xs text-parchment">
                  <input
                    type="checkbox"
                    name="per_vehicle"
                    defaultChecked={p.per_vehicle}
                  />{" "}
                  Per vehicle
                </label>
                <label className="flex items-center gap-1.5 text-xs text-parchment">
                  <input type="checkbox" name="active" defaultChecked={p.active} />{" "}
                  Active
                </label>
              </div>
              <Field label="Features">
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {FEATURE_KEYS.map((f) => (
                    <label
                      key={f}
                      className="flex items-center gap-1.5 text-xs text-parchment"
                    >
                      <input
                        type="checkbox"
                        name={`feat_${f}`}
                        defaultChecked={featuresOf.get(p.id)?.has(f) ?? false}
                      />{" "}
                      {f}
                    </label>
                  ))}
                </div>
              </Field>
              {itemsForRegion.length > 0 && (
                <Field
                  label="One-off items charged per vehicle when it joins this plan"
                  hint="Hardware and installation. Invoiced once, never prorated, never counted as recurring revenue."
                >
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {itemsForRegion.map((a) => (
                      <label key={a.id} className="flex items-center gap-1.5 text-xs text-parchment">
                        <input
                          type="checkbox"
                          name={`oneoff_${a.id}`}
                          defaultChecked={oneOffsOf.get(p.id)?.has(a.id) ?? false}
                        />{" "}
                        {a.name} <span className="text-muted">({itemPrice(a)})</span>
                      </label>
                    ))}
                  </div>
                </Field>
              )}
              <Button type="submit" variant="primary" size="sm">
                Save {p.name}
              </Button>
            </form>
          </details>
        );
      })}

      <Card className="max-w-2xl">
        <CardTitle>New plan</CardTitle>
        <form action={createPlanAction} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <input
                name="key"
                required
                placeholder="pro"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Name">
              <input
                name="name"
                required
                placeholder="Pro"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Base price (minor units, ex VAT)">
              <input
                name="base_price_pence"
                type="number"
                min="0"
                defaultValue="0"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Term">
              <select
                name="interval"
                defaultValue="year"
                className={`${inputCls} w-full`}
              >
                <option value="month">month</option>
                <option value="half_year">6 months</option>
                <option value="year">year</option>
              </select>
            </Field>
            <Field label="Region">
              <select
                name="region"
                defaultValue={defaultRegion}
                className={`${inputCls} w-full`}
              >
                <option value="uk">uk</option>
                <option value="ng">ng</option>
              </select>
            </Field>
            <Field label="Sold to">
              <select name="audience" defaultValue="all" className={`${inputCls} w-full`}>
                <option value="all">everyone</option>
                <option value="business">fleets & insurers</option>
                <option value="individual">individuals</option>
              </select>
            </Field>
            <Field label="Vehicles added mid-term">
              <select name="additions_billing" defaultValue="immediate" className={`${inputCls} w-full`}>
                <option value="immediate">charge at once</option>
                <option value="monthly_batch">monthly batch</option>
              </select>
            </Field>
            <label className="flex items-center gap-1.5 self-end text-xs text-parchment">
              <input type="checkbox" name="per_vehicle" /> Per vehicle
            </label>
          </div>
          <Field label="Features">
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {FEATURE_KEYS.map((f) => (
                <label
                  key={f}
                  className="flex items-center gap-1.5 text-xs text-parchment"
                >
                  <input type="checkbox" name={`feat_${f}`} /> {f}
                </label>
              ))}
            </div>
          </Field>
          <Button type="submit" variant="primary" size="sm">
            Create plan
          </Button>
        </form>
      </Card>

      {/* One-off items: hardware, installation, replacement */}
      <Card>
        <CardTitle>One-off items</CardTitle>
        <p className="mb-3 text-sm text-muted">
          Charged once — a tracker, its installation, a replacement. Attach an item to a plan above so every vehicle joining that tier is
          invoiced for it; raise ad-hoc items from a subscriber&apos;s page. 0 means unpriced.
        </p>
        <Table caption="One-off items">
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Name</Th>
              <Th>Region</Th>
              <Th>Price (ex VAT)</Th>
              <Th>Cost</Th>
              <Th>Creates job</Th>
              <Th>Active</Th>
            </tr>
          </thead>
          <tbody>
            {oneOffItems.map((a) => (
              <tr key={a.id}>
                <Td>{a.key}</Td>
                <Td>{a.name}</Td>
                <Td>{regionOf(a)}</Td>
                <Td>{itemPrice(a)}</Td>
                <Td>{a.job_kind ? <Badge tone="neutral">{a.job_kind}</Badge> : <span className="text-muted">—</span>}</Td>
                <Td>{a.unit_cost_pence ? formatMoney(a.unit_cost_pence, { region: regionOf(a) }) : "—"}</Td>
                <Td>
                  {a.active ? (
                    <Badge>active</Badge>
                  ) : (
                    <span className="text-muted">off</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {oneOffItems.map((a) => (
        <details key={a.id} className="rounded-lg border border-hair">
          <summary className="cursor-pointer px-4 py-2 text-sm text-parchment" aria-label={`Edit one-off item ${a.key}`}>
            Edit {a.name} <span className="text-muted">({a.key})</span>
          </summary>
          <form action={updateAddonAction} className="space-y-3 p-4">
            <input type="hidden" name="id" value={a.id} />
            <input type="hidden" name="kind" value="one_off" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Name">
                <input name="name" defaultValue={a.name} className={`${inputCls} w-full`} />
              </Field>
              <Field label="Description">
                <input name="description" defaultValue={a.description ?? ""} className={`${inputCls} w-full`} />
              </Field>
              <Field label={`Price (${regionProvider(regionOf(a)).currency.minorName}, ex VAT)`} hint="0 means unpriced.">
                <input name="unit_price_pence" type="number" min="0" defaultValue={a.unit_price_pence} className={`${inputCls} w-full`} />
              </Field>
              <Field label="Unit cost (minor units)" hint="for margin analysis">
                <input name="unit_cost_pence" type="number" min="0" defaultValue={a.unit_cost_pence} className={`${inputCls} w-full`} />
              </Field>
              <Field label="Region">
                <select name="region" defaultValue={regionOf(a)} className={`${inputCls} w-full`}>
                  <option value="uk">uk</option>
                  <option value="ng">ng</option>
                </select>
              </Field>
              <Field label="Creates job when paid" hint="NG-3: a fitting, replacement, removal or service visit per vehicle.">
                <select name="job_kind" defaultValue={a.job_kind ?? ""} className={`${inputCls} w-full`}>
                  <option value="">none (charge only)</option>
                  <option value="install">install</option>
                  <option value="replace">replace</option>
                  <option value="remove">remove</option>
                  <option value="service">service</option>
                </select>
              </Field>
              <label className="flex items-center gap-1.5 self-end text-xs text-parchment">
                <input type="checkbox" name="active" defaultChecked={a.active} /> Active
              </label>
            </div>
            <Button type="submit" variant="primary" size="sm">
              Save {a.name}
            </Button>
          </form>
        </details>
      ))}

      <Card className="max-w-2xl">
        <CardTitle>New one-off item</CardTitle>
        <form action={createAddonAction} className="space-y-3">
          <input type="hidden" name="kind" value="one_off" />
          <input type="hidden" name="pricing_model" value="per_device" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <input name="key" required placeholder="ng_dashcam_device" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Name">
              <input name="name" required placeholder="Dashcam (device)" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Description">
              <input name="description" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Feature it relates to">
              <select name="feature_key" defaultValue="gps.hardware" className={`${inputCls} w-full`}>
                {FEATURE_KEYS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Price (minor units, ex VAT)">
              <input name="unit_price_pence" type="number" min="0" defaultValue="0" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Unit cost (minor units)">
              <input name="unit_cost_pence" type="number" min="0" defaultValue="0" className={`${inputCls} w-full`} />
            </Field>
            <Field label="Region">
              <select name="region" defaultValue={defaultRegion} className={`${inputCls} w-full`}>
                <option value="uk">uk</option>
                <option value="ng">ng</option>
              </select>
            </Field>
            <Field label="Creates job when paid">
              <select name="job_kind" defaultValue="install" className={`${inputCls} w-full`}>
                <option value="">none (charge only)</option>
                <option value="install">install</option>
                <option value="replace">replace</option>
                <option value="remove">remove</option>
                <option value="service">service</option>
              </select>
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm">
            Create one-off item
          </Button>
        </form>
      </Card>

      {/* Recurring add-ons (UK SaaS) */}
      <Card>
        <CardTitle>Recurring add-ons</CardTitle>
        <Table caption="Recurring add-ons">
          <thead>
            <tr>
              <Th>Key</Th>
              <Th>Feature</Th>
              <Th>Pricing</Th>
              <Th>Unit price</Th>
              <Th>Deposit</Th>
              <Th>Active</Th>
            </tr>
          </thead>
          <tbody>
            {recurring.map((a) => (
              <tr key={a.id}>
                <Td>{a.key}</Td>
                <Td>{a.feature_key}</Td>
                <Td>{a.pricing_model}</Td>
                <Td>{formatMoney(a.unit_price_pence, { region: regionOf(a) })}</Td>
                <Td>{a.deposit_pence ? formatMoney(a.deposit_pence, { region: regionOf(a) }) : "—"}</Td>
                <Td>
                  {a.active ? (
                    <Badge>active</Badge>
                  ) : (
                    <span className="text-muted">off</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="max-w-2xl">
        <CardTitle>New recurring add-on</CardTitle>
        <form action={createAddonAction} className="space-y-3">
          <input type="hidden" name="kind" value="recurring" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Key">
              <input
                name="key"
                required
                placeholder="gps_hardware"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Name">
              <input
                name="name"
                required
                placeholder="GPS Hardware"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Feature key">
              <select name="feature_key" className={`${inputCls} w-full`}>
                {FEATURE_KEYS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pricing model">
              <select
                name="pricing_model"
                defaultValue="flat"
                className={`${inputCls} w-full`}
              >
                <option value="flat">flat</option>
                <option value="metered_per_unit">metered_per_unit</option>
                <option value="per_device">per_device</option>
              </select>
            </Field>
            <Field label="Unit price (minor units)">
              <input
                name="unit_price_pence"
                type="number"
                min="0"
                defaultValue="0"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Unit cost (minor units)" hint="for margin analysis">
              <input
                name="unit_cost_pence"
                type="number"
                min="0"
                defaultValue="0"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Deposit (minor units)" hint="refundable, platform hardware">
              <input
                name="deposit_pence"
                type="number"
                min="0"
                defaultValue="0"
                className={`${inputCls} w-full`}
              />
            </Field>
            <Field label="Region">
              <select name="region" defaultValue={defaultRegion} className={`${inputCls} w-full`}>
                <option value="uk">uk</option>
                <option value="ng">ng</option>
              </select>
            </Field>
          </div>
          <Button type="submit" variant="primary" size="sm">
            Create add-on
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-muted">{hint}</span>
      )}
    </label>
  );
}
