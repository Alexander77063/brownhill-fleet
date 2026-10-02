-- 0049 — align the catalogue plan prices with the live Stripe prices.
--
-- The prices were set directly in the Stripe dashboard (Starter £25 / Growth £35 /
-- Scale £45), but plans.base_price_pence still held the original seed (£99/£249/£499).
-- Platform MRR/analytics read base_price_pence, so they overstated revenue while the
-- landing page (which reads Stripe) showed the real figures. Correct the catalogue
-- price so analytics match what tenants are actually charged.
--
-- Billing is unaffected: the Stripe price IDs (plans.stripe_price_id / STRIPE_PRICE_*)
-- remain the source of truth for what is charged — this only fixes the display/MRR
-- figure. If prices change again, update them here (or via the platform catalogue).

update plans set base_price_pence = 2500 where key = 'starter';
update plans set base_price_pence = 3500 where key = 'growth';
update plans set base_price_pence = 4500 where key = 'scale';
