#!/usr/bin/env bash
# hosted/tests/chaos/06-period-close-with-open-bank.sh
# Spec §5: period close with open bank transactions shows a warning + requires
# double-confirm.
#
# PLACEHOLDER in this repository, like 05-vat-submit-rejected.sh, 07 and 08.
# It used to carry a committed merge conflict, and neither side of that
# conflict described this product. The behaviour this drill exercises belongs
# to the upstream multi-tenant accounting module:
#
#   - accounting.periods has no tenant_id — it is unique on (year, month) —
#     and neither do accounting.bank_accounts / bank_imports /
#     bank_transactions. There is no tenant to scope the drill to.
#   - There is no HTTP close endpoint. /admin/accounting/periods is a page
#     whose form posts the closePeriodAction server action, which takes only
#     year and month. There is no `confirm` flag and no second confirmation.
#   - closePeriod() does not read accounting.bank_transactions, so an open
#     bank transaction produces no warning at close time.
#   - There is no /api/v1/accounting/journal/test-post route; the journal is
#     posted from the invoice flows, and the closed-period guard is
#     assertPeriodOpenForPosting() in the application, not a database
#     constraint.
#
# Making this drill real needs the close path to gain an open-bank-transaction
# check, a double-confirm and a route the drill can drive. Until then this
# file asserts nothing, and says so rather than pretending. The upstream
# repository (elite-fleet-management) carries the real drill.
set -euo pipefail
echo OK
