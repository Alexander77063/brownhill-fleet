# Brownhill Fleet — the agreements

Three agreements, each shipped in two formats. Six files in this folder.

| Agreement | Word document | Fillable form | Fields |
|---|---|---|---|
| **Standard hire — company insured** | `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement.docx` | `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Fillable.html` | 53 |
| **Standard hire — self insured** | `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured.docx` | `Brownhill-Fleet-Standard-Vehicle-Rental-Agreement-Self-Insured-Fillable.html` | 54 |
| **Rent-to-buy** | `Brownhill-Fleet-Rent-to-Buy-Agreement.docx` | `Brownhill-Fleet-Rent-to-Buy-Agreement-Fillable.html` | 69 |

The **company-insured** edition is the default: Brownhill insures the vehicle
under its own fleet policy and the Customer pays the excess on a claim. The
**self-insured** edition is for a hirer who brings their own policy — the
Customer's insurer, policy number and expiry appear on the document, and the
Customer bears their own excess. The application picks the edition for you
from the insurance certificate on file; see below.

The rent-to-buy has no company-insured edition and never will: Brownhill does
not carry a fleet policy on a vehicle the Customer may buy.

Every file is generated from **one source of truth**, so the wording is
identical. If you change the wording, change it in the source and rebuild — do
not edit the two outputs independently, or they will drift apart. A test fails
the build if they ever do; see "The gate that keeps them honest".

---

## 1. Generating an agreement from the application (the usual route)

Open the agreement in the operations console — **Operations → Agreements** —
pick one — and press **Open & edit contract**. The application reads the
agreement, the vehicle, the driver and the insurance certificate out of the
database and fills every box it can.

There is a **Download** button next to it, which saves the same document as a
file (`?download=1`) rather than opening it in the browser. The driver's own
**Documents** page links to the same document, so a customer can be sent
straight to it.

Two things happen before you get a document, and both are deliberate:

**The identity gate.** A contract carries the **Lessor's** legal identity —
legal name, trading name, registered address, company number, VAT number,
contact details — and those come from the tenant's **Branding** settings
(**Admin → Branding**). If any of them is missing, the application refuses to
issue a contract and shows you what is missing and where to set it. It will
not issue a document bearing the platform's own details, because that would put
the wrong company on a legal document.

**The outstanding list.** Above the agreement the application tells you what is
still blank, under two headings:

- *Still to be completed before this agreement is signed* — the particulars only
  a person can supply.
- *Completed at handover* — the readings taken when the vehicle changes hands.

When everything is filled, it says **Ready to issue** instead. The list is
hidden when the page is printed or downloaded: it is a note to the operator, not
part of the contract.

### What the application fills, and what it cannot

The application fills everything that is in the database: the parties, the
vehicle, the term, the rent, the deposit, the mileage allowance, the charges,
the option credit and the buyout figures.

It deliberately leaves blank the things it has no way of knowing:

| Blank on | Why | Who fills it |
|---|---|---|
| The odometer at handover | There is no odometer column on a vehicle — the reading is taken when the vehicle changes hands | Operator, at handover |
| Handover date, fuel level, keys, condition notes | The same | Operator, at handover |
| Return date, mileage, fuel level, keys, condition notes | The same | Operator, when the vehicle comes back |
| **The insurance excess — on the self-insured edition and the rent-to-buy** | Clause 6.5 of the standard hire, and clause 8.5 of the rent-to-buy, make the Customer responsible for the excess on **their own** policy, and the platform does not hold it. A certificate of motor insurance carries the insurer, the policy number and the dates — **not** the excess | Operator, from the policy, before signing |

That last one matters. The company-insured edition quotes Brownhill's published
£1,000 excess, because that is Brownhill's fleet policy and the figure is
known. The self-insured and rent-to-buy editions leave it blank on purpose:
quoting Brownhill's fleet excess as the excess on a customer's own policy
would be a false statement in a contract. Read it off the policy and write it
in.

## 2. Filling the HTML by hand (no application)

The fillable form is a single offline file. Open it in any browser; it needs no
internet connection and nothing is uploaded anywhere.

1. Fill in the **COMPLETE THESE DETAILS** panel at the top. Every box is
   highlighted in the agreement below as you type.
2. Click **Print / Save as PDF**. Choose *Save as PDF* as the destination.
3. The printed copy has **no form styling** — the boxes, the grey shading and
   the panel disappear, leaving clean A4 pages with a footer showing the
   agreement reference and page numbers.
4. Sign the printed PDF (or send it for e-signature).

**Clear all fields** empties the form so you can start again for the next
customer.

> The "on return" column in Schedule 2 is deliberately **not** in the fill-in
> panel. That column is completed at the end of the hire, by Brownhill, in the
> same document.

## 3. The Word document (full editing)

1. Open the `.docx` in Word.
2. Replace the placeholders. Every placeholder is in square brackets and in
   capitals, e.g. `[CUSTOMER'S FULL NAME]`, `[WEEKLY RENT, INCLUDING VAT]`.
3. To replace them one at a time: `Ctrl+H` (Find and Replace), type the
   bracketed placeholder in **Find what**, type the value in **Replace with**,
   then **Replace All**. Do them one placeholder at a time — replacing all at
   once would overwrite every field with the same text.
4. Save as a new file per customer, e.g.
   `AGR-000123-Brownhill-Rental-Agreement.docx`, so the master template stays
   clean.

**Tip:** the placeholders are bold and shaded grey, so they are easy to spot.
`Ctrl+H` with *Find what* set to `[` finds the next one.

---

## What each agreement covers

### The standard hire — 19 clauses and two schedules

Both editions share clauses 1–5, 7–19 and the schedules. **Only clause 6 and
three rows of Schedule 1 differ**, because the difference is the insurance
arrangement and everything that follows from it.

- **1–2** Definitions, term of the hire and how it ends
- **3–5** Rent and payment, deposit, mileage
- **6** Insurance, licensing and the risk — *the edition's own clause*
- **7–10** Fuel and cleaning, breakdown, servicing and MOT, damage and fair wear and tear
- **11–15** Penalty notices, the Customer's obligations, the Lessor's rights of entry, ending the agreement, returning the vehicle
- **16–19** Data protection, notices, general terms, signatures
- **Schedule 1** Particulars of the hire (the completed detail table)
- **Schedule 2** Handover and return record

**Clause 6, company-insured edition.** The vehicle is hired with motor
insurance arranged by Brownhill under its fleet policy; the Customer pays the
**£1,000** excess on any claim; the Customer must comply with the policy's
conditions; and Brownhill handles claims on the Customer's behalf.

**Clause 6, self-insured edition.** The vehicle is hired **exclusive of
insurance**. The Customer must hold comprehensive UK motor insurance for hire
and reward with at least £5,000,000 third-party liability, naming Brownhill as
an interested party, and must produce the certificate and schedule before
taking the vehicle. The Customer bears the excess on their own claims, and
bears the whole loss if the vehicle is uninsured or under-insured.

**The renter may end the standard hire on one month's notice.** The notice
period is a field and defaults to **one month (4 weeks)**. Clause 2.3 lets the
Customer end the agreement at any time on that written notice; clause 14.1
carries it; and clause 2.5 gives a **14-day cooling-off period** from signing,
with the Deposit refunded in full.

### The rent-to-buy — 21 clauses and three schedules

- **1–2** Definitions, term of the agreement
- **3–4** The Monthly Payment and how it is billed, the Deposit
- **5** The Option Credit and the Equity
- **6** The Option to purchase the vehicle
- **7–12** Mileage, insurance and the risk, fuel, breakdown, servicing, condition
- **13–17** Charges, obligations, rights of entry, ending the agreement, return
- **18–21** Data protection, notices, general, signatures
- **Schedule 1** Particulars of the agreement
- **Schedule 2** Handover and return record
- **Schedule 3** Equity and option statement — completed by Brownhill as the
  Option Credit accrues

**The money, and the one thing to get right.** The Customer signs a **monthly**
agreement; the system bills **weekly**; the Option Credit is **part of** each
weekly payment. So the credit accrues weekly — `£162.50` a week of the `£850.00`
net weekly fee — and the Equity at the end of the term is the Deposit plus
those credits, counted week by week.

That is not a detail to be careful about: the Equity is what the customer has
paid towards the car, and the Buyout Price is the agreed residual. The balance
to buy out is **the residual less the Equity**, and if the credit were counted
monthly instead of weekly the customer's own statement and the directors'
report would disagree with each other, on a figure the customer is asked to
sign. All three now compute it the same way, to the penny, and a test holds
them to that.

The rent-to-buy also carries its own published terms: **£75.00 per day** late
after a 24-hour grace period, seven consecutive days of arrears ending the
agreement, a **£5,000** deposit, 50,000 miles a year pro rata at **15p** per
mile over, 156 weeks / 36 months, and an early-termination fee of eight
weeks' hire with forfeiture of the Option Credits.

### Brownhill's published terms, and where they live

The figures that are the same on every agreement are in
`src/lib/contract-terms.ts`, and the documents are generated from them — so
the rate quoted in the application is the rate on the document.

| | Standard hire | Rent-to-buy |
|---|---|---|
| Mileage included | 3,200 a month / 800 a week, pro rata | 50,000 a year, pro rata (962 a week) |
| Charge per mile over | £1.00 | £0.15 |
| Insurance excess | £1,000 (Brownhill's fleet policy) | The Customer's own policy — filled by the operator |
| Late payment | £20.00 per day | £75.00 per day after a 24-hour grace period |
| Late return | £118.00 per day | — |
| Cooling-off | 14 days | — |
| Deposit refunded | 14 days after the end date | — |

---

## Rebuilding the files

If the wording needs to change, edit the source and rebuild — do not hand-edit
the outputs.

```bash
node scripts/contracts/build-rental-agreement.mjs     # both standard-hire editions
node scripts/contracts/build-rent-to-buy-agreement.mjs  # the rent-to-buy
```

The source lives in `scripts/contracts/`:

- `rental-agreement-content.mjs` — the standard hire's clause text, field
  definitions and schedules. **The only place its wording lives.**
- `rent-to-buy-content.mjs` — the same for the rent-to-buy.
- `render-contract.mjs` — the shared renderer: the `.docx` (hand-built OOXML),
  the `.html`, and the audit that fails the build on a clause naming a field
  that does not exist.
- `build-rental-agreement.mjs` and `build-rent-to-buy-agreement.mjs` — one per
  agreement. They write no words; they hand the content to the renderer.

The rental and rent-to-buy are separate content modules and separate build
scripts on purpose. They are two documents with two different legal
characters; they share a renderer, not a template.

## The gate that keeps them honest

`tests/unit/contract-drift.test.ts` runs on every build. It holds that:

1. **The shipped document is exactly what the content module builds** — the
   same bytes for the HTML, and the same clauses for the Word file. A
   hand-edit to a shipped document is a defect, because the next build
   silently reverts it.
2. **No clause names a field the document does not define**, so no raw
   `{{token}}` can reach a customer.
3. **The application and the document agree** — every value the application
   computes has a box, and every particular left blank is one the operator
   completes later or one with a written reason.

The gate carries its own negative control, so it cannot degrade into comparing
nothing and passing every document.

---

## Before you use it

These templates reflect the arrangements Brownhill has asked for. They are a
practical starting point, **not a substitute for legal review**. Before an
agreement is used with a customer, have it checked by a solicitor or the
firm's legal adviser, in particular:

- clause 3.4 (business customers / Unfair Terms in Consumer Contracts
  Regulations 2009) and the whole of clause 18 if you hire to businesses;
- the insurance requirements in clause 6 against the cover actually offered by
  a typical renter's policy, and the interaction with clause 6.8 and Brownhill's
  own keeper cover;
- the rent, deposit, interest and mileage figures in Schedule 1 against the
  pricing Brownhill actually charges;
- the termination terms in clauses 2.3, 2.5 and 14 against Brownhill's
  commercial position and fleet utilisation;
- **on the rent-to-buy**: clause 5 (the Option Credit and the Equity), clause 6
  (the Option and the Buyout Price), the APR disclosure, and the Consumer
  Credit Act treatment of a hire with a repayment obligation.

The standard hire is drafted for England and Wales (clause 18.5).
