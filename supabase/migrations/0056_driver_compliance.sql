-- 0056 — driver documents, driven by the region pack.
--
-- 0051 unified driver paperwork into one table, but froze the vocabulary of what
-- a document can BE into a CHECK constraint written in United Kingdom terms:
-- pco_licence, dvla_check, driving_licence, right_to_work, proof_of_address,
-- other. A Nigerian operator has none of those. They need a National
-- Identification Number, an FRSC driver's licence and — in Lagos — a LASDRI
-- card, and today the only way to file any of them is `other` with a typed
-- label, which the compliance sweep cannot grade and the renewal reminders
-- cannot see.
--
-- 0055 already answered this question for vehicles: the vocabulary belongs to
-- the region pack, and pinning it in SQL means a migration every time a country
-- is added. `vehicle_compliance.obligation_key` is free text for exactly that
-- reason. `driver_documents.kind` becomes free text on the same grounds, and for
-- the same reason it is not a free-for-all: the application validates every kind
-- against the active region's `driverCompliance` list plus the handful of
-- universally-applicable kinds, so an unknown kind is refused before it is
-- stored.
alter table driver_documents drop constraint if exists driver_documents_kind_check;

-- A blocking counterpart to `driver_document_expiry`.
--
-- The generic type from 0051 is advisory: it surfaces an expiring document
-- without stopping the driver being dispatched, which is right for proof of
-- address and wrong for a driver's licence. The region pack already marks which
-- documents are mandatory, so — exactly as 0055 did for vehicles — mandatory
-- ones get a type that appears in BLOCKING_TYPES and optional ones keep the
-- advisory type. Added as a value only; nothing references it until application
-- code runs in a later transaction, which is what Postgres requires.
alter type obligation_type add value if not exists 'driver_compliance_expiry';

-- Some documents are a number, not a scan.
--
-- A Nigerian NIN is eleven digits issued once and never renewed; there is often
-- no certificate to photograph. Requiring a file would mean an operator either
-- cannot record the NIN at all or invents a photograph to satisfy the form —
-- and an invented attachment is worse than none, because it looks like evidence.
-- So a document may now be a reference without a file. The application still
-- requires one or the other; a row with neither carries no information.
alter table driver_documents alter column doc_path drop not null;

comment on column driver_documents.kind is
  'Matches a key in the active region pack''s driverCompliance list, or one of the '
  'universal kinds (right_to_work, proof_of_address, dvla_check, other). Free text '
  'because the vocabulary belongs to the region pack — see 0055 for the same '
  'decision on vehicle_compliance.obligation_key. Validated in the application.';

comment on column driver_documents.doc_path is
  'Path inside the private driver-docs bucket. Null for reference-only records — '
  'a Nigerian NIN is a number with nothing to scan.';
