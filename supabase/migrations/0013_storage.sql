-- 0013 — storage bucket for insurance certificates + a driver charge-dispute
-- policy (so disputes work through the user session, not only service-role).

-- Private bucket; access controlled entirely by the policies below.
insert into storage.buckets (id, name, public)
values ('insurance-certs', 'insurance-certs', false)
on conflict (id) do nothing;

-- Path convention: "<driver_id>/<filename>". A driver may read/write only
-- inside their own folder; ops may do anything in the bucket.
create policy "certs ops all"
  on storage.objects for all to authenticated
  using (bucket_id = 'insurance-certs' and is_ops())
  with check (bucket_id = 'insurance-certs' and is_ops());

create policy "certs driver read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'insurance-certs'
    and (storage.foldername(name))[1] = current_driver_id()::text
  );

create policy "certs driver upload own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'insurance-certs'
    and (storage.foldername(name))[1] = current_driver_id()::text
  );

-- Let a driver dispute their own charge (status flip) through their session.
create policy charges_driver_dispute on charges for update to authenticated
  using (driver_id = current_driver_id() and status in ('received','driver_notified'))
  with check (driver_id = current_driver_id() and status = 'disputed');
