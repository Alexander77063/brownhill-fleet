"use client";

/** "Lookup-to-fill" vehicle entry — the reusable template for identifier-driven
 *  data entry. Enter a registration → "Look up" → the DVLA record pre-fills the
 *  form → confirm/edit → Add. Degrades gracefully to a plain manual form when
 *  the lookup is dormant (no DVLA key). Copy this shape for driver-licence,
 *  company-number, and postcode lookups. */
import { useState } from "react";
import { Card, CardTitle, Button } from "@/components/ui";
import { createVehicle } from "@/lib/actions/ops";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

const FUELS = ["phev", "ev", "petrol", "diesel", "hybrid"] as const;
const STATUSES = ["available", "on_hire", "off_road", "sold"] as const;

type Fields = {
  make: string;
  model: string;
  colour: string;
  model_year: string;
  fuel: string;
  co2_gkm: string;
  list_value: string;
  status: string;
};

const EMPTY: Fields = {
  make: "",
  model: "",
  colour: "",
  model_year: "",
  fuel: "phev",
  co2_gkm: "",
  list_value: "",
  status: "available",
};

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-parchment">{label}</span>
      {children}
    </label>
  );
}

export function VehicleEntry() {
  const [reg, setReg] = useState("");
  const [f, setF] = useState<Fields>(EMPTY);
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function lookup() {
    const q = reg.trim();
    if (!q) return;
    setLooking(true);
    setNote(null);
    try {
      const res = await fetch(`/api/lookups/vehicle?reg=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (res.ok && json.vehicle) {
        const v = json.vehicle;
        setF((prev) => ({
          ...prev,
          make: v.make ?? prev.make,
          colour: v.colour ?? prev.colour,
          fuel: v.fuel ?? prev.fuel,
          model_year: v.modelYear ? String(v.modelYear) : prev.model_year,
          co2_gkm: v.co2 != null ? String(v.co2) : prev.co2_gkm,
        }));
        setNote(
          `Found ${[v.make, v.colour, v.modelYear].filter(Boolean).join(" ")} — confirm below and add the model + list value.`,
        );
      } else if (res.status === 503) {
        setNote("Vehicle lookup isn't set up yet (add a DVLA key) — enter the details manually below.");
      } else {
        setNote(json.error ?? "No match — enter the details manually below.");
      }
    } catch {
      setNote("Lookup failed — enter the details manually below.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <Card>
      <CardTitle>Add a vehicle</CardTitle>
      <p className="mt-1 text-xs text-muted">
        Enter the registration and press Look up — the DVLA record fills the details for you to confirm.
      </p>

      <form action={createVehicle} className="mt-3 space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Labelled label="Registration (VRM)">
            <input
              name="registration"
              value={reg}
              onChange={(e) => setReg(e.target.value.toUpperCase())}
              required
              className={`${inputCls} font-mono uppercase`}
              placeholder="AB12 CDE"
            />
          </Labelled>
          <Button type="button" variant="outline" size="sm" onClick={lookup}>
            {looking ? "Looking…" : "Look up"}
          </Button>
        </div>

        {note && <p className="text-xs text-parchment">{note}</p>}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Labelled label="Make">
            <input name="make" value={f.make} onChange={set("make")} className={inputCls} />
          </Labelled>
          <Labelled label="Model">
            <input name="model" value={f.model} onChange={set("model")} className={inputCls} />
          </Labelled>
          <Labelled label="Colour">
            <input name="colour" value={f.colour} onChange={set("colour")} className={inputCls} />
          </Labelled>
          <Labelled label="Year">
            <input name="model_year" value={f.model_year} onChange={set("model_year")} inputMode="numeric" className={inputCls} />
          </Labelled>
          <Labelled label="Fuel">
            <select name="fuel" value={f.fuel} onChange={set("fuel")} className={inputCls}>
              {FUELS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="CO₂ (g/km)">
            <input name="co2_gkm" value={f.co2_gkm} onChange={set("co2_gkm")} inputMode="numeric" className={inputCls} />
          </Labelled>
          <Labelled label="List value (£)">
            <input name="list_value" value={f.list_value} onChange={set("list_value")} inputMode="decimal" required className={inputCls} />
          </Labelled>
          <Labelled label="Status">
            <select name="status" value={f.status} onChange={set("status")} className={inputCls}>
              {STATUSES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </Labelled>
        </div>

        <Button type="submit" variant="primary" size="sm">
          Add vehicle
        </Button>
      </form>
    </Card>
  );
}
