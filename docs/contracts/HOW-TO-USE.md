# Brownhill Fleet — standard vehicle rental agreement

Two files live in this folder. Send **both** to Brownhill; use whichever fits the
job at hand.

| File | What it is | Use it when |
|------|-----------|-------------|
| `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx` | The agreement itself, as a Word document. Opens in Word, Google Docs, LibreOffice and Pages. | You want to edit the wording, lock in Brownhill's house style, or keep a master copy to reuse. |
| `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html` | The same agreement as a browser form. Fill the boxes, print to PDF. | You want to produce a clean signed PDF quickly without touching Word, or a customer fills it in themselves. |

Both files are generated from **one source of truth**, so the wording is
identical. If you change the wording, change it in the source and rebuild — do
not edit the two outputs independently, or they will drift apart.

---

## 1. The fillable HTML form (quickest route)

1. Open `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html` in any
   browser (Chrome, Edge, Safari, Firefox). It needs no internet connection and
   nothing is uploaded anywhere — the page is entirely offline.
2. Fill in the **COMPLETE THESE DETAILS** panel at the top. Every box is
   highlighted in the agreement below as you type.
3. Click **Print / Save as PDF**. In the print dialogue choose *Save as PDF* as
   the destination.
4. The printed copy has **no form styling** — the boxes, the grey shading and
   the panel disappear, leaving clean A4 pages with a footer showing the
   agreement reference and page numbers.
5. Sign the printed PDF (or send it for e-signature).

**Clear all fields** empties the form so you can start again for the next
customer.

> The "on return" column in Schedule 2 is deliberately **not** in the fill-in
> panel. That column is completed at the end of the hire, by Brownhill, in the
> same document.

## 2. The Word document (full editing)

1. Open `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx` in Word.
2. Replace the placeholders. Every placeholder is in square brackets and in
   capitals, e.g. `[CUSTOMER'S FULL NAME]`, `[WEEKLY RENT, INCLUDING VAT]`.
3. To replace them one at a time: `Ctrl+H` (Find and Replace), type the
   bracketed placeholder in **Find what**, type the value in **Replace with**,
   then **Replace All**. Do them one placeholder at a time — replacing all at
   once would overwrite every field with the same text.
4. Delete the bracketed instructions where a clause offers a choice. Clause 2.2
   says *"Complete one only — delete the other."*
5. Save as a new file per customer, e.g.
   `AGR-000123-Brownhill-Rental-Agreement.docx`, so the master template stays
   clean.

**Tip:** the placeholders are bold and shaded grey, so they are easy to spot.
`Ctrl+H` with *Find what* set to `[` finds the next one.

---

## What the agreement covers

19 numbered clauses plus two schedules:

- **1–2** Definitions, term of the hire and how it ends
- **3–5** Rent and VAT, deposit, mileage
- **6** Insurance, licensing and the risk
- **7–10** Fuel and cleaning, breakdown, servicing and MOT, damage and fair wear and tear
- **11–15** Penalty notices, the Customer's obligations, the Lessor's rights of entry, ending the agreement, returning the vehicle
- **16–19** Data protection, notices, general terms, signatures
- **Schedule 1** Particulars of the hire (the completed detail table)
- **Schedule 2** Handover and return record

### The two points Brownhill asked for

**1. The renter insures the vehicle, not Brownhill.**
Clause 6 is written around the Customer holding their own UK motor insurance
for the whole of the hire:

- 6.1 — the Vehicle is insured by the Customer, not by the Lessor; the Lessor
  carries no motor insurance for the Customer's use, and the cost of the
  Customer's insurance is not included in the Rent.
- 6.2 — the policy must be comprehensive or better, cover third-party
  liability to at least the statutory minimum, and **must not** be
  third-party-only.
- 6.3 — the policy schedule and certificate of motor insurance must be provided
  **before the vehicle is taken**, with insurer, policy number, expiry date and
  evidence date recorded in Schedule 1.
- 6.4 — cancellation, withdrawal of cover or licence revocation must be
  notified in writing within 7 days.
- 6.5 — no driving unless insured to the standard in 6.2; the Customer bears
  their own excess per claim, and bears the whole Loss if the vehicle is
  uninsured or under-insured.
- 6.6 — the Customer must hold a current licence of the type stated in
  Schedule 1 and produce it on request.
- 6.8 — Brownhill remains the **registered keeper** and stays responsible for
  the MOT certificate and road tax (clause 9). The Customer must tell their
  insurer that Brownhill is the registered keeper.

**2. The renter may end the contract on one month's notice.**

- The notice period is a field (`[CUSTOMER'S NOTICE PERIOD TO TERMINATE
  (ONE MONTH = 4 WEEKS)]`) and defaults to **one month (4 weeks)**. It can be
  changed per agreement.
- **Clause 2.3** — the Customer may end the agreement at any time by giving at
  least that written notice; notice takes effect only when Brownhill actually
  receives it, and only if given so as to expire at the end of a rental week.
- **Clause 2.5** — because the Customer insures the vehicle in their own name
  and at their own cost (clause 6), they may end the agreement on that notice
  **without paying any early termination charge**. They must still return the
  vehicle under clause 15 and pay every charge already due.
- **Clause 14.1** — the Customer may end the agreement by giving the notice
  required by clause 2.3.
- **Clause 14.2(d)** — the Lessor may end the agreement if the Customer drives
  uninsured, or lets their insurance lapse, is cancelled or is withdrawn, and
  does not put that right within 7 days of a written demand.

The two work together: the one-month notice is what makes the renter-managed
insurance workable, and the insurance-lapse ground is what makes the
renter-managed arrangement enforceable.

### Fields you must complete every time

The agreement carries **53 placeholders** in total. 48 of them are fill-in
fields, grouped as **Lessor**, **Customer**, **Agreement**, **Vehicle**,
**Term**, **Rent and charges**, **Insurance and excess**, and **Handover** —
the HTML form shows these in that order, and the Word document spreads them
through the clauses and Schedule 1. The other 5 are the "on return" column of
Schedule 2, completed at the end of the hire.

Check before sending that these are all filled:

- Agreement reference, date of agreement
- Lessor legal name, trading name, registered address, company number, contact
  email and phone
- Customer full name, address, date of birth, telephone, email
- Vehicle make, model, registration, VIN, colour, model year, fuel type, list
  price, odometer at handover
- Start date, end date, term in weeks, notice period
- Weekly rent gross / net / VAT and the VAT rate, deposit, included mileage,
  excess mile rate, payment method, first payment date, late-payment interest
  rate, breakdown assistance number
- Customer's insurer, policy number, expiry date, evidence date, excess per
  claim, licence type and licence number
- Handover date, fuel/charge level at handover, keys and equipment provided,
  condition notes at handover

---

## Rebuilding the files

If the wording needs to change, edit the source and rebuild — do not hand-edit
the outputs.

```bash
node scripts/contracts/build-rental-agreement.mjs
```

The source lives in `scripts/contracts/`:

- `rental-agreement-content.mjs` — the clause text, the field definitions and
  the schedules. **This is the only place the wording lives.**
- `build-rental-agreement.mjs` — the renderer. Writes the `.docx` (hand-built
  OOXML) and the `.html`.

The build fails if a clause references a field that does not exist, and it
reports any field that is defined but never used, so a typo in a placeholder
cannot slip through.

---

## Before you use it

This template was written for Brownhill Fleet's standard vehicle rental
agreement and reflects the arrangements Brownhill has asked for. It is a
practical starting point, **not a substitute for legal review**. Before it is
used with a customer, have it checked by a solicitor or the firm's legal
adviser, in particular:

- clause 3.4 (business customers / Unfair Terms in Consumer Contracts
  Regulations 2009) and the whole of clause 18 if you hire to businesses;
- the insurance requirements in clause 6 against the cover actually offered by
  a typical renter's policy, and the interaction with clause 6.8 and Brownhill's
  own keeper cover;
- the rent, deposit, interest and mileage figures in Schedule 1 against the
  pricing Brownhill actually charges;
- the termination terms in clauses 2.3, 2.5 and 14 against Brownhill's
  commercial position and fleet utilisation.

It is drafted for England and Wales (clause 18.5).
