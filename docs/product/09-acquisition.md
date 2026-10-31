# 9 — User acquisition plan

**This is a decision document, not a finished plan.** The unresolved question
is stated first. Everything after is conditional on explicitly stated
assumptions.

*Status: blocked as of 2026-10-30. Blocking gate: Brown's list of existing
customers and the channel that reaches them.*

---

## 1. The unresolved question

> **Who are the first hundred users, and how does Brownhill reach them?**

There is no answer to this in the repository, and there should not be: it is a
fact about Brownhill's business, not about its software.

**What would settle it:**

1. **The existing customer list.** Brownhill rents vehicles today. The people
   already renting are the cheapest possible users of a rent-to-buy product —
   they know the business, they have a vehicle, and a rent-to-buy is an
   upgrade to a relationship that already exists.
2. **The channel.** Brownhill already has a way of reaching those customers.
   Whatever it is — a phone call, a branch, an email list, a broker — is the
   acquisition channel. A new one would be a cost with no evidence behind it.
3. **Who else.** Whether Brownhill wants to reach people it does not already
   serve, and if so, whether that is brokers, fleet operators, or the
   public.

## 2. The assumption this document proceeds on

> **Assumption A — Brownhill's existing renters are the first hundred.**

This is the cheapest, highest-converting, lowest-risk population available: a
business that already rents to someone has a relationship, a payment history,
and a vehicle that a rent-to-buy could apply to.

**If Assumption A is wrong**, the acquisition question is a completely
different one and most of §3 below does not apply. The parts that survive are
§4 (the cost of a user) and §5 (the measurement).

## 3. Who the users are, by portal

The product has five portals and they are not the same kind of user. Assuming
Brownhill's existing renters are the first hundred, the shape of the first
hundred is:

| Portal | Who they are | Roughly how many |
| --- | --- | --- |
| `/driver` | The rentees — Brownhill's existing customers | The large majority |
| `/ops` | The operations staff who write the deals | Tens |
| `/accounts` | The finance staff and the directors | Under ten |
| `/investor` | The people funding the book | A handful |
| `/owner` | Vehicle owners | A handful |

**The acquisition problem is not "how do we get users" — it is "how do we get
the operations staff to write rent-to-buy deals in this system instead of a
spreadsheet".**

That is the honest shape of it. A rentee does not choose Brownhill Fleet;
Brownhill Fleet is how the rentee is served. The rentee's experience matters
— they must be able to see their equity, their documents and their charges —
but they are not acquired.

## 4. The cost of a user

### 4.1 What this repository can tell us

| Cost | Where it lands |
| --- | --- |
| **Deployment** | One VPS, sized at 2 vCPU / 4 GB / 80 GB for "a few dozen vehicles"; 6 GB as the dataset grows. A fixed monthly cost, not per user |
| **Backups** | A Backblaze B2 bucket, nightly dumps, 7-day local and 90-day off-host retention. Proportional to data volume, not to user count |
| **Domain and TLS** | One domain, one Let's Encrypt certificate. Fixed |
| **Metered integrations** | DVLA lookups, SMS, telematics, AI. **Per user, per interaction** |
| **Support** | The operator's time. The real marginal cost |

### 4.2 The cost per user is therefore near zero, and that is the point

The marginal cost of one more rentee on the deployment is a few database rows
and some metered API calls. **The cost per *user* is not a software cost at
all — it is the cost of the vehicle, the finance and the servicing.** Which is
why the cost per user belongs in the [monetisation](./07-monetisation.md)
document rather than here.

What this document can say is the **acquisition cost of a rent-to-buy deal**,
which is the operational effort to convert a renter into a rent-to-buy
customer, and that number is not in this repository either.

## 5. How it is measured

The system already emits the events. What it does not yet do is retain them.

| Measure | Where it comes from | Exists today |
| --- | --- | --- |
| Rent-to-buy agreements written | `agreements` where `type='rtb'` | **Yes** |
| Deals per month | `agreements.created_at` | **Yes** |
| Cost of a car per deal | `agreements.agreed_vehicle_cost_pence` | **Yes** |
| Yield per deal | `companyYieldPct` | **Yes** |
| Conversion: renter → rent-to-buy | Requires knowing how many renters exist | **No** — the denominator is not recorded |
| Time from first rental to first RTB deal | Requires agreement history joined on driver | **No** |
| Where a rentee heard about it | Requires a capture field | **No** |

**The measurement gap is the denominator.** The system knows how many
rent-to-buy agreements exist; it does not know how many rental agreements
exist for the same period, so it cannot compute a conversion rate. Adding
that is a small change — the data is already there — and it is the difference
between "we wrote 14 rent-to-buy deals" and "we converted 11% of our renters".

**This is the one acquisition-related piece of work this product should do
next**, and it is a reporting change, not a marketing one.

## 6. The channel, once Brownhill names it

| Channel | What it needs from the product |
| --- | --- |
| **Existing renter, in person or by phone** | The calculator and the agreement form. Nothing else |
| **Broker** | A way for a broker to price a deal without an ops login. **Does not exist** — the calculator is behind `requireRole` |
| **Website / inbound** | A marketing surface. **Does not exist**, and the landing page is the public marketing site, not a lead funnel |
| **Email to the existing list** | The report's own send button is the closest thing. It sends the *board pack*, not a customer offer |

## 7. The first hundred, by name

**This section cannot be written yet**, and writing it with invented names
would be worse than leaving it empty. It needs:

1. Brown's list of existing renters, with the vehicle each one holds.
2. The date each agreement started (already in the system).
3. The spread to apply: which renters get offered a rent-to-buy, and which
   get asked first.

**Gate:** a named list, reviewed by Brownhill, with a date against each entry.
Until then, the honest first-hundred list is "Brownhill's existing renters,
in the order Brownhill decides", and the software already supports every
one of them.

## 8. What this product must not do

The temptation, with a fleet product, is to add marketing surfaces. The cut
line in [03-mvp-scope](./03-mvp-scope.md) holds:

- **No public marketing site.** The landing page is not a lead funnel.
- **No self-serve rent-to-buy signup.** A customer does not apply for credit
  in this system.
- **No broker portal.** The broker channel would need a pricing surface with
  no PII and no write access — a real piece of work, not a nav entry.
- **No referral codes.** There is no second population to refer.

Every one of these is a deliberate exclusion. A product that tries to be the
marketing site and the fleet system at once serves neither well.
