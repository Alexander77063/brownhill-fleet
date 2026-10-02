-- 0025 — airport drop-off fees (Heathrow / Gatwick charge PHV operators per
-- drop-off) as a first-class pass-through charge type, so they reconcile to
-- drivers alongside congestion / ULEZ / tolls.
alter type charge_type add value if not exists 'airport';
