-- 0059 — the `owner` portal role.
--
-- A vehicle owner — a policyholder under an insurer's tenant, or an individual
-- on the shared Nigerian instance — signs in and sees their own vehicles. That
-- is a third portal alongside ops and driver, so it is a third `user_role`.
--
-- This file holds only the enum change: a value added to an enum cannot be used
-- in the same transaction that adds it, and the CLI wraps each file in one.
alter type user_role add value if not exists 'owner';
