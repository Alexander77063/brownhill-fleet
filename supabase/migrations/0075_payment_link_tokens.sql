-- 0075 -- payment_link_tokens.
--
-- Ops-generated single-use links the customer pays in. Created by
-- ops at /ops/billing (per-row "Send payment link to driver" button).
-- Sent to the driver over SMS. Walked by the driver opening the link
-- and hitting /pay/<token>, which redirects them into /driver/payments
-- pre-highlighting the agreement. The token itself is never tied to
-- a payment processor: v1 has no in-app payment flow; ops marks the
-- invoice paid by hand once the driver's bank transfer clears.
--
-- used_at is set on first walk; expires_at is set at create time
-- (PAYMENT_LINK_TTL_HOURS = 72). Both gates are enforced server-side;
-- the pure helpers in @/lib/billing/payment-link-token pin the policy.

set search_path = public;

create table payment_link_tokens (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique,
  agreement_id  uuid not null,
  driver_id     uuid not null,
  tenant_id     uuid not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  sms_status    text,
  created_at    timestamptz not null default now(),
  used_ip       inet,
  used_user_agent text,
  check (used_at is null or used_at >= created_at)
);

create index payment_link_tokens_agreement_idx on payment_link_tokens (agreement_id, created_at desc);
create index payment_link_tokens_driver_idx on payment_link_tokens (driver_id, created_at desc);
create index payment_link_tokens_active_idx on payment_link_tokens (token) where used_at is null;

alter table payment_link_tokens enable row level security;

-- Driver side: drivers may SELECT their own tokens (so the deep-link
-- page can read what agreement it points at before redirecting).
create policy driver_self_select on payment_link_tokens for select to authenticated
  using (
    driver_id in (
      select driver_id from public.profiles where id = auth.uid()
    )
  );

-- Tenant side: ops/admin read+write their tenant's tokens.
-- is_tenant_member(tenant_id) is the 0016 helper every other tenant-scoped
-- table uses; there is no current_tenant() function to call.
create policy tenant_select on payment_link_tokens for select to authenticated
  using (is_tenant_member(tenant_id));
create policy tenant_insert on payment_link_tokens for insert to authenticated
  with check (is_tenant_member(tenant_id));
create policy tenant_update on payment_link_tokens for update to authenticated
  using (is_tenant_member(tenant_id))
  with check (is_tenant_member(tenant_id));