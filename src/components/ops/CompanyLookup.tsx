"use client";

/** Company-number lookup-to-fill — enter a company number → "Look up" → the
 *  Companies House record fills the sibling legal_name + address inputs in the
 *  same branding form for you to confirm. Degrades gracefully to manual entry
 *  when the lookup is dormant (no Companies House key). Mirrors VehicleEntry. */
import { useRef, useState } from "react";
import { Button } from "@/components/ui";

const inputCls =
  "rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none";

export function CompanyLookup({ defaultValue }: { defaultValue?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function lookup() {
    const q = inputRef.current?.value.trim() ?? "";
    if (!q) return;
    setLooking(true);
    setNote(null);
    try {
      const res = await fetch(`/api/lookups/company?number=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (res.ok && json.company) {
        const c = json.company;
        const form = inputRef.current?.form;
        if (form) {
          const legal = form.elements.namedItem("legal_name") as HTMLInputElement | null;
          const addr = form.elements.namedItem("address") as (HTMLInputElement | HTMLTextAreaElement) | null;
          if (legal && c.name != null) legal.value = c.name;
          if (addr && c.address != null) addr.value = c.address;
        }
        setNote(`Found ${c.name} — legal name + address filled below, please confirm.`);
      } else if (res.status === 503) {
        setNote("Company lookup isn't set up (add a Companies House key) — enter details manually.");
      } else {
        setNote(json.error ?? "No match — enter details manually.");
      }
    } catch {
      setNote("Lookup failed — enter details manually.");
    } finally {
      setLooking(false);
    }
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">Company number</span>
      <div className="flex items-center gap-2">
        <input ref={inputRef} name="company_number" defaultValue={defaultValue} className={`${inputCls} w-full`} />
        <Button type="button" variant="outline" size="sm" onClick={lookup}>
          {looking ? "Looking…" : "Look up"}
        </Button>
      </div>
      {note ? (
        <span className="mt-1 block text-[11px] text-parchment">{note}</span>
      ) : (
        <span className="mt-1 block text-[11px] text-muted">look up to fill legal name + address</span>
      )}
    </label>
  );
}
