'use client';

import { useRef, useState } from 'react';

export interface SessionView {
  reference: string;
  status: 'partner_review' | 'driver_sign' | 'signed' | 'declined' | 'cancelled';
  weekly_gross_pence: number;
  deposit_pence: number;
  vehicle_value_pence: number | null;
  per_mile_pence: number;
  start_mileage: string | null;
  partner_name: string | null;
  driver_name: string | null;
  driver_signed_at: string | null;
}

const gbp = (pence: number | null | undefined) =>
  pence == null ? '' : (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0 = (pence: number | null | undefined) =>
  pence == null ? '' : Math.round(pence / 100).toLocaleString('en-GB');

export function SignClient({
  token,
  role,
  session,
  operator,
}: {
  token: string;
  role: 'partner' | 'driver';
  session: SessionView;
  /** The operator the signer is contracting with — never the software vendor. */
  operator: string;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="sign-wrap">
      <style>{CSS}</style>
      <div className="card">
        <header className="hd">
          <div className="brand">ELITE FLEET MANAGEMENT</div>
          {/* The document name is the page's heading. It was a <div>, which left the
              most legally significant screen in the product with no heading at all —
              a screen-reader user landing here had nothing to orient on. */}
          <h1 className="doc">Vehicle Rental Agreement</h1>
          <div className="ref">{session.reference}</div>
        </header>
        {session.status === 'signed' ? (
          <Signed session={session} />
        ) : role === 'partner' ? (
          <PartnerFlow token={token} session={session} />
        ) : (
          <DriverFlow token={token} session={session} operator={operator} />
        )}
      </div>
      <p className="foot">Secured by {operator} · your link is private to you</p>
    </main>
  );
}

function Terms({ s }: { s: SessionView }) {
  return (
    <dl className="terms">
      <Row k="Weekly rent (gross)" v={`£${gbp(s.weekly_gross_pence)}`} />
      <Row k="Security deposit" v={`£${gbp(s.deposit_pence)}`} />
      <Row k="Vehicle value" v={s.vehicle_value_pence ? `£${gbp0(s.vehicle_value_pence)}` : '—'} />
      <Row k="Excess mileage" v={`£${gbp(s.per_mile_pence)} / mile`} />
      <Row k="Starting mileage" v={s.start_mileage?.trim() ? `${s.start_mileage} mi` : '—'} />
    </dl>
  );
}
const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="trow">
    <dt>{k}</dt>
    <dd>{v}</dd>
  </div>
);

// ── Partner: confirm/edit the figures, then hand off to the driver ───────────
function PartnerFlow({ token, session }: { token: string; session: SessionView }) {
  const [f, setF] = useState({
    weeklyRent: gbp(session.weekly_gross_pence),
    deposit: gbp(session.deposit_pence),
    vehicleValue: session.vehicle_value_pence ? gbp0(session.vehicle_value_pence) : '',
    perMile: gbp(session.per_mile_pence),
    startMileage: session.start_mileage ?? '',
    partnerName: session.partner_name ?? '',
  });
  const [state, setState] = useState<'edit' | 'saving' | 'done'>(
    session.status === 'partner_review' ? 'edit' : 'done',
  );
  const [driverUrl, setDriverUrl] = useState('');
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function approve() {
    if (!f.partnerName.trim()) return setError('Please enter your name.');
    setState('saving');
    setError('');
    const res = await fetch(`/api/sign/${token}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(f),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Something went wrong.');
      setState('edit');
      return;
    }
    setDriverUrl(data.driverUrl);
    setState('done');
  }

  if (state === 'done' || session.status !== 'partner_review') {
    return (
      <section className="body">
        <div className="badge ok">Approved</div>
        <p className="lead">Thanks{f.partnerName ? `, ${f.partnerName}` : ''} — you've confirmed the terms.</p>
        {driverUrl ? (
          <>
            <p className="muted">Send this link to the driver to sign:</p>
            <CopyLink url={driverUrl} />
          </>
        ) : (
          <p className="muted">The driver has been sent their signing link.</p>
        )}
      </section>
    );
  }

  return (
    <section className="body">
      <p className="lead">Please check the deal terms, adjust anything that's wrong, then approve to send to the driver.</p>
      <div className="fields">
        <Field label="Weekly rent (gross)" prefix="£" value={f.weeklyRent} onChange={set('weeklyRent')} />
        <Field label="Security deposit" prefix="£" value={f.deposit} onChange={set('deposit')} />
        <Field label="Vehicle value" prefix="£" value={f.vehicleValue} onChange={set('vehicleValue')} />
        <Field label="Excess mileage (per mile)" prefix="£" value={f.perMile} onChange={set('perMile')} />
        <Field label="Starting mileage" value={f.startMileage} onChange={set('startMileage')} placeholder="e.g. 24,500" />
        <Field label="Your name" value={f.partnerName} onChange={set('partnerName')} placeholder="Partner name" />
      </div>
      <div role="alert" aria-live="assertive">
        {error && <p className="err">{error}</p>}
      </div>
      <button className="btn" onClick={approve} disabled={state === 'saving'}>
        {state === 'saving' ? 'Approving…' : 'Approve & send to driver'}
      </button>
    </section>
  );
}

// ── Driver: review the locked terms and sign ────────────────────────────────
function DriverFlow({
  token,
  session,
  operator,
}: {
  token: string;
  session: SessionView;
  operator: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  const [name, setName] = useState(session.driver_name ?? '');
  const [state, setState] = useState<'sign' | 'saving' | 'done'>('sign');
  const [error, setError] = useState('');
  /* Drawing on a canvas is pointer-only, which would make it impossible for a keyboard
     or switch user to execute a contract (WCAG 2.1.1 Keyboard, Level A). Offering a
     typed signature as an equal alternative is the standard accessible e-signature
     pattern; both paths produce the same PNG data URL, so the API is unchanged. */
  const [sigMode, setSigMode] = useState<'draw' | 'type'>('draw');
  const [typedSig, setTypedSig] = useState('');

  if (session.status === 'partner_review') {
    return (
      <section className="body">
        <div className="badge wait">Awaiting partner</div>
        <p className="lead">This agreement is still being confirmed by {operator}. You&apos;ll be able to sign once it&apos;s ready.</p>
      </section>
    );
  }

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  }
  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#10233f';
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    inked.current = true;
  }
  function end() {
    drawing.current = false;
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    inked.current = false;
  }

  /** Render a typed signature to the same 520×170 PNG the drawn path produces. */
  function renderTypedSignature(text: string): string {
    const c = document.createElement('canvas');
    c.width = 520;
    c.height = 170;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#10233f';
    ctx.font = 'italic 56px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, c.width / 2, c.height / 2, c.width - 40);
    return c.toDataURL('image/png');
  }

  async function submit() {
    if (!name.trim()) return setError('Please type your full name.');
    if (sigMode === 'draw' && !inked.current) return setError('Please draw your signature in the box.');
    if (sigMode === 'type' && !typedSig.trim()) return setError('Please type your signature.');
    setState('saving');
    setError('');
    const signature =
      sigMode === 'type' ? renderTypedSignature(typedSig.trim()) : canvasRef.current!.toDataURL('image/png');
    const res = await fetch(`/api/sign/${token}/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ driverName: name.trim(), signature }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Something went wrong.');
      setState('sign');
      return;
    }
    setState('done');
  }

  if (state === 'done') {
    return (
      <section className="body">
        <div className="badge ok">Signed</div>
        <p className="lead">Thank you, {name}. Your agreement is signed and a copy has been sent to {operator}.</p>
      </section>
    );
  }

  return (
    <section className="body">
      <p className="lead">Please review your agreement terms and sign below.</p>
      <Terms s={session} />
      <label className="lbl" htmlFor="driver-full-name">
        Your full name
      </label>
      <input
        id="driver-full-name"
        className="in"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Full legal name"
        autoComplete="name"
      />

      <fieldset className="sigset">
        <legend className="lbl">Signature</legend>
        <div className="sigmodes" role="group" aria-label="How would you like to sign?">
          <button
            type="button"
            className="modebtn"
            aria-pressed={sigMode === 'draw'}
            onClick={() => {
              setSigMode('draw');
              setError('');
            }}
          >
            Draw it
          </button>
          <button
            type="button"
            className="modebtn"
            aria-pressed={sigMode === 'type'}
            onClick={() => {
              setSigMode('type');
              setError('');
            }}
          >
            Type it
          </button>
        </div>

        {sigMode === 'draw' ? (
          <div className="sig">
            <canvas
              ref={canvasRef}
              width={520}
              height={170}
              aria-label="Signature drawing area. If you cannot use a pointer, choose “Type it” to enter your signature with the keyboard."
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerLeave={end}
            />
            <button type="button" className="clear" onClick={clear}>
              Clear
            </button>
          </div>
        ) : (
          <>
            <label className="lbl" htmlFor="typed-signature">
              Type your signature
            </label>
            <input
              id="typed-signature"
              className="in sigtype"
              value={typedSig}
              onChange={(e) => setTypedSig(e.target.value)}
              placeholder="Your name, as your signature"
              autoComplete="name"
            />
            <p className="muted">
              Typing your name here has the same legal effect as drawing your signature.
            </p>
          </>
        )}
      </fieldset>

      {/* Validation feedback must be announced: submission is blocked without focus
          moving, so a silent <p> leaves screen-reader users stuck (WCAG 4.1.3). */}
      <div role="alert" aria-live="assertive">
        {error && <p className="err">{error}</p>}
      </div>
      <button className="btn" onClick={submit} disabled={state === 'saving'}>
        {state === 'saving' ? 'Signing…' : 'Sign & submit'}
      </button>
    </section>
  );
}

function Signed({ session }: { session: SessionView }) {
  const when = session.driver_signed_at ? new Date(session.driver_signed_at).toLocaleString('en-GB') : '';
  return (
    <section className="body">
      <div className="badge ok">Signed</div>
      <p className="lead">
        This agreement was signed{session.driver_name ? ` by ${session.driver_name}` : ''}
        {when ? ` on ${when}` : ''}.
      </p>
      <Terms s={session} />
    </section>
  );
}

function Field({
  label,
  prefix,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  prefix?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="lbl">{label}</span>
      <span className="inwrap">
        {prefix && <span className="pfx">{prefix}</span>}
        <input className="in" value={value} onChange={onChange} placeholder={placeholder} inputMode="decimal" />
      </span>
    </label>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy">
      <input readOnly aria-label="Driver signing link" value={url} onFocus={(e) => e.target.select()} />
      <button
        onClick={() => {
          navigator.clipboard?.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

const CSS = `
  .sigset{border:0;padding:0;margin:0}
  .sigset legend{padding:0}
  .sigmodes{display:inline-flex;gap:6px;margin:2px 0 10px}
  .modebtn{border:1px solid #d8cfb8;background:#fffdf8;color:#3d4a5e;border-radius:999px;
    padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer}
  .modebtn[aria-pressed="true"]{background:#12223c;color:#f3efe4;border-color:#12223c}
  .sigtype{font-family:Georgia,"Times New Roman",serif;font-style:italic;font-size:22px}
  /* Focus ring — this page renders its own CSS, so it does not inherit the app shell's
     global :focus-visible treatment (WCAG 2.4.7 Focus Visible). */
  .sign-wrap :focus-visible{outline:2px solid #12223c;outline-offset:2px}
  .sign-wrap{min-height:100dvh;background:#0f1a2e;color:#12223c;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:14px;padding:24px;font-family:system-ui,-apple-system,sans-serif}
  .card{width:100%;max-width:560px;background:#fffdf8;border-radius:16px;overflow:hidden;
    box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}
  .hd{background:#12223c;color:#f3efe4;padding:22px 26px;border-bottom:3px solid #e9c96a}
  .hd .brand{font-family:Georgia,serif;letter-spacing:.14em;font-size:13px;color:#e9c96a}
  /* now an <h1>: reset the UA margin/weight so the layout is unchanged */
  .hd .doc{font-family:Georgia,serif;font-size:22px;font-weight:500;margin:4px 0 0}
  .hd .ref{font-family:ui-monospace,monospace;font-size:12px;color:#9fb0c4;margin-top:6px}
  .body{padding:24px 26px 28px}
  .lead{font-size:15px;color:#3d4a5e;margin:0 0 18px}
  .muted{color:#6b7686;font-size:14px;margin:14px 0 8px}
  .terms{margin:0 0 20px;border:1px solid #ece3cf;border-radius:10px;overflow:hidden}
  .trow{display:flex;justify-content:space-between;padding:10px 14px;border-top:1px solid #f0e9d6}
  .trow:first-child{border-top:0}
  .trow dt{color:#5b6472;font-size:14px}
  .trow dd{margin:0;font-weight:600;font-variant-numeric:tabular-nums}
  .fields{display:grid;gap:12px;margin-bottom:18px}
  .field{display:flex;flex-direction:column;gap:5px}
  /* #7a8494 was 3.72:1 on the card — every field label on the signing page failed AA. */
  .lbl{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#68717f;font-weight:600}
  .inwrap{display:flex;align-items:center;border:1px solid #d6cbb0;border-radius:9px;overflow:hidden;background:#fff}
  .inwrap:focus-within{border-color:#c9a94a;box-shadow:0 0 0 3px rgba(201,169,74,.15)}
  .pfx{padding:0 4px 0 12px;color:#8a8577}
  .in{flex:1;border:0;outline:0;padding:11px 12px;font-size:15px;background:transparent;width:100%;color:#12223c}
  input.in{border:1px solid #d6cbb0;border-radius:9px}
  .inwrap .in{border:0}
  .btn{width:100%;background:linear-gradient(#e9c96a,#c9a94a);color:#12223c;border:0;border-radius:10px;
    padding:14px;font-size:15px;font-weight:700;cursor:pointer;margin-top:6px}
  .btn:hover{filter:brightness(1.05)}
  .btn:disabled{opacity:.6;cursor:default}
  .sig{position:relative;border:1px dashed #c9a94a;border-radius:10px;background:#fffef9;margin-bottom:6px}
  .sig canvas{width:100%;height:170px;touch-action:none;display:block;cursor:crosshair}
  .sig .clear{position:absolute;top:8px;right:8px;background:#fff;border:1px solid #e0d7bf;border-radius:6px;
    padding:4px 10px;font-size:12px;cursor:pointer;color:#7a6a2a}
  .badge{display:inline-block;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;
    text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
  /* were 4.31:1 and 3.44:1 on their own tinted backgrounds */
  .badge.ok{background:#e6f0e6;color:#256b42}
  .badge.wait{background:#f6ecd6;color:#8a5e12}
  .err{color:#b0432c;font-size:14px;margin:4px 0 10px}
  .copy{display:flex;gap:8px;margin-top:8px}
  .copy input{flex:1;border:1px solid #d6cbb0;border-radius:9px;padding:11px;font-size:13px;
    font-family:ui-monospace,monospace;color:#12223c;background:#fff}
  .copy button{background:#12223c;color:#f3efe4;border:0;border-radius:9px;padding:0 18px;font-weight:600;cursor:pointer}
  /* #5c6a82 was 3.18:1 on the dark page background; #9fb0c4 is already used by .hd .ref */
  .foot{color:#9fb0c4;font-size:12px;font-family:ui-monospace,monospace}
  .lbl{margin-top:6px}
`;
