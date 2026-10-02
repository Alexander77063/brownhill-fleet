'use client';

/** Postcode → address lookup-to-fill. Enter a postcode → "Find address" → pick from
 *  the matches → the sibling `address` textarea in the same form is filled for you to
 *  confirm. Degrades gracefully to manual entry when dormant (no getAddress key).
 *  Mirrors CompanyLookup / VehicleEntry. */
import { useRef, useState } from 'react';
import { Button } from '@/components/ui';

const inputCls =
  'rounded-md border border-hair bg-[var(--surface)] px-2.5 py-1.5 text-sm text-cream focus:border-gold-bright focus:outline-none';

export function PostcodeLookup() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [looking, setLooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<string[]>([]);

  async function lookup() {
    const q = inputRef.current?.value.trim() ?? '';
    if (!q) return;
    setLooking(true);
    setNote(null);
    setAddresses([]);
    try {
      const res = await fetch(`/api/lookups/postcode?postcode=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (res.ok && json.result?.addresses?.length) {
        setAddresses(json.result.addresses as string[]);
        setNote(`${json.result.addresses.length} addresses found — pick yours below.`);
      } else if (res.status === 503) {
        setNote("Address lookup isn't set up (add a getAddress key) — type your address manually.");
      } else {
        setNote(json.error ?? 'No addresses for that postcode — type manually.');
      }
    } catch {
      setNote('Lookup failed — type your address manually.');
    } finally {
      setLooking(false);
    }
  }

  function pick(value: string) {
    if (!value) return;
    const form = inputRef.current?.form;
    const addr = form?.elements.namedItem('address') as HTMLInputElement | HTMLTextAreaElement | null;
    if (addr) {
      addr.value = value;
      setNote('Address filled below — please confirm.');
      setAddresses([]);
    }
  }

  return (
    <label className="block sm:col-span-2">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-parchment">
        Find address by postcode
      </span>
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          placeholder="e.g. UB6 7JJ"
          className={`${inputCls} w-full`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              lookup();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" onClick={lookup}>
          {looking ? 'Finding…' : 'Find address'}
        </Button>
      </div>
      {addresses.length > 0 && (
        <select
          className={`${inputCls} mt-2 w-full`}
          defaultValue=""
          onChange={(e) => pick(e.target.value)}
        >
          <option value="" disabled>
            Select your address…
          </option>
          {addresses.map((a, i) => (
            <option key={i} value={a}>
              {a}
            </option>
          ))}
        </select>
      )}
      {note ? (
        <span className="mt-1 block text-[11px] text-parchment">{note}</span>
      ) : (
        <span className="mt-1 block text-[11px] text-muted">optional — fills the address field below</span>
      )}
    </label>
  );
}
