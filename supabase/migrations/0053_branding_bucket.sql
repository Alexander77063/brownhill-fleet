-- 0053 — the `branding` bucket, which the app has always written to and nothing ever created.
--
-- ## Why this was invisible
--
-- `uploadLogoAction` has called `storagePut('branding', ...)` since branding shipped, but no
-- migration created the bucket. On Cloudflare R2 that is harmless — a logical "bucket" is only a
-- key prefix, so the write succeeds — and production runs on R2, so nothing complained. The
-- moment anything falls back to Supabase Storage (local dev, CI, an R2 outage, or moving off R2)
-- every logo upload fails with "Bucket not found".
--
-- It stayed hidden for a second reason: the logo uploader degrades gracefully, returning a
-- message to the user and storing nothing, so there was no exception and no log line. A silent
-- failure in a rarely-used admin screen can sit there for months.
--
-- `tests/unit/storage-buckets.test.ts` now fails if a bucket is used without being created here.
--
-- ## Access
--
-- Path convention "<tenant_id>/logo", matching the folder-based policies on the other buckets.
-- Scoped by tenant, not merely by role: `is_ops()` alone would let an ops user of one tenant
-- overwrite another tenant's logo, which is exactly the cross-tenant write #63 went to some
-- trouble to close.
--
-- The bucket stays PRIVATE even though a logo is public-facing. It is served through
-- /api/branding/logo/[tenantId], which reads with the service role and sets its own caching —
-- so the bytes reach browsers without the bucket being world-listable.

insert into storage.buckets (id, name, public)
values ('branding', 'branding', false)
on conflict (id) do nothing;

-- Ops staff manage the logo for their OWN tenant only.
create policy "branding ops own tenant"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'branding'
    and is_ops()
    and (storage.foldername(name))[1] = current_app_tenant()::text
  )
  with check (
    bucket_id = 'branding'
    and is_ops()
    and (storage.foldername(name))[1] = current_app_tenant()::text
  );

-- Any member of the tenant may read it (the app normally serves it via the service role, but a
-- signed URL taken directly by a member should not 403).
create policy "branding member read own tenant"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = current_app_tenant()::text
  );
