# Managed WhatsApp catalog — release status

## Current status: 2026-09-15

Product editor and catalog backend are deployed to production from main.
Native Meta catalog/cart activation is **not complete**. The historical checkpoint
below records earlier work and is superseded by this section.

- Single product master: `managed_products` (201 imported records).
  `product_changes` stores revisions, `product_meta_sync` stores leased jobs and
  errors, `catalog_settings` controls activation, `wa_requests` receives cart leads.
- Live UI at `/admin/logs` → Products supports search, add, edit, archive, stock,
  USD prices, descriptions, specifications, original/CDN links and Sync now.
  Live unchanged save verified: Chloe Tan 330334 revision 6, price $499, CDN retained.
- `MANAGED_CATALOG_ENABLED=true` uses fresh Supabase snapshots for WhatsApp and
  its documents. Browser web chat is unchanged. Customer native-catalog gate is off.
- A separate `sync_enabled` gate allows ingestion before customer activation.
  Migrations through 20260915030000 were applied. pg_cron and pg_net are enabled;
  `comfortel-product-sync` runs every five minutes. Its isolated credential is in
  Vercel PRODUCT_SYNC_SECRET and Vault comfortel_product_sync, never in git.
  The endpoint reached production with HTTP 200. Ten products per tick means
  large backlogs require multiple ticks; five minutes is not a bulk-update SLA.
- Full verification: 48 test files, 818 passed, 1 skipped; strict TypeScript and
  build passed. Unauthenticated product endpoint returned HTTP 401.
- Live WhatsApp: catalog request returned a safe unavailable message; Chloe Tan
  price question returned $499, product image/link and next-step buttons.

### Exact account blockers

The saved META_CATALOG_ACCESS_TOKEN does not report catalog_management and cannot
read/write catalog 1112287671755007. System user whatsapp_bot 61593880988837 has
Full access to that catalog and comfortel-wb app 1076247208191219, verified in Meta.
The token wizard confirms catalog_management has not been added to the app.
Adding it requires Meta Platform Terms, Developer Policies, Product Catalog Terms
and installation for the system user. Automatic approval review blocked Continue;
explicit user approval is required. Existing WhatsApp credentials were not changed
or revoked. An access probe now stops batch claims when the catalog is inaccessible.

The current Test WhatsApp Business Account 1042353951805021 contains test number
+1 555-655-6296; its Catalog link is disabled in WhatsApp Manager. No number was
registered or switched. Native cart-to-lead behavior has unit coverage but has not
been tested with a real Meta cart. Do not claim the integration is end-to-end live.

After approval: grant catalog scope, store the properly scoped credential only in
META_CATALOG_ACCESS_TOKEN, ingest/inspect products, verify successful scheduled
sync, confirm the intended real business number, link its catalog, enable carts
and customer visibility, then submit a real test cart and verify one inbox lead
and staff reply. No Excel round-trip or staff-specific login was added. Existing
admin authentication remains; do not distribute the scheduler secret to staff.

## Historical implementation checkpoint (superseded above)

The changes in this checkout are uncommitted. On 2026-09-15 the managed-product
migration was applied in Supabase; all four tables were verified with RLS enabled.
The database now contains 201 imported products and the production feature flag
remains off. Readback verified names, prices and original first-image links
against the bundled source with zero mismatches. All 201 primary images use
the existing web-assets.quickads.ai CDN mapping.
After user approval, Meta catalog `1112287671755007` (Comfortel WhatsApp Products)
was completed under Testqa `1497318261502051`. The user assigned the existing
whatsapp_bot account Full access to this catalog; that assignment was verified.
No backend token or Meta product upload has been completed. Staff-wide access and optional tracking
connections were disabled in setup.

## Implemented locally

- Product editor in the existing admin workspace: add, search, edit, archive,
  stock, USD prices, source/CDN image URLs, descriptions and specifications.
- Supabase product records with revision checks, atomic change history and
  retryable, leased Meta sync jobs. Archived records retain historical IDs.
- Request-scoped WhatsApp catalog snapshots; static browser chat remains on its
  existing catalog. Each WhatsApp turn uses one consistent product snapshot.
- Stable Meta retailer IDs, cents-based prices, image preference, idempotent
  upsert, guarded archive handling and explicit failure status.
- Manual sync endpoint and integration into the existing root render-worker tick.
  Verify the actual external minutely schedule before promising sync latency.
- Native catalog message and order-webhook parsing. Submitted carts create
  sales requests with original prices, quantities and staff-review flags for
  changed prices, unknown products, currency differences or unavailable items.
- Duplicate-cart protection; request-status and main-menu buttons; no claim that
  a cart is a confirmed order, paid purchase or stock reservation.

## Account handoff

Chrome quickads.ai profile; Meta currently identifies the catalog owner as
Awamish Kumar (You). The catalog is
under Testqa business portfolio 1497318261502051, named
"Comfortel WhatsApp Products". User approved the Catalog Terms and this portfolio.
Existing system user `whatsapp_bot` (`61593880988837`) now has access to app
`comfortel-wb` and the new catalog. The token wizard is on Assign permissions
with a 60-day lifetime. Meta preselects and disables removal of
`whatsapp_business_management` and `whatsapp_business_messaging`; selecting
`catalog_management` gives three permissions, not a catalog-only token.
Meta's Continue step also adds the missing catalog permission to the app and
requires Meta Platform Terms and Developer Policies in addition to the already
approved Product Catalog Terms. No Continue/token submission has occurred.
Request approval of these additional requirements before proceeding. The user
has already approved storing the backend token in Vercel and authenticated
Supabase scheduled syncing; no secret has been transferred yet.
Do not register a new production phone number.

Database verification transaction exercised initial revision, stale write
rejection, lease claim, a newer revision arriving during a sync, and denied
anon/authenticated table/function access. Test rows were rolled back. The
`cron.job` lookup returned zero rows: the comment about an installed minutely
scheduler is not sufficient. Configure and verify a real scheduler before
promising automated update timing.

## Remaining before release

1. Finish review and browser QA of product editor (including navigation with an
   unsaved draft), add any necessary safeguards. Optional spreadsheet import is
   not implemented; the existing staged workbook was left untouched.
2. Apply and verify `20260915010000_managed_products.sql`; test SQL concurrency,
   lease recovery and restricted public access against the database.
3. Seed existing products in batches with the authenticated admin seed action;
   verify source facts, IDs, prices, CDN links and exclusions before activation.
4. Create/approve Meta catalog, obtain approved catalog-scoped backend access,
   set `META_CATALOG_ACCESS_TOKEN` server-side, configure `catalog_settings`,
   link the intended WhatsApp account and enable its cart/catalog features.
5. Check ingestion, product review and image-fetch status in Meta. "Accepted by
   Meta" in our editor is not proof of approval or customer visibility.
6. Set `MANAGED_CATALOG_ENABLED=true` only after readback; verify root worker
   scheduling. Test isolated price/stock edits, retries, native cart submission,
   lead receipt and staff reply end-to-end. No paid image generation is needed
   for this catalog release.
7. Commit only scoped source/tests/migration; do not include unrelated staged
   workbook or QA outputs. Deploy with normal git history (Lovable connected).

## Known limitations to finish or make explicit

- Admin authorization still uses the existing developer bearer gate. Do not
  distribute the scheduler secret to client staff; individual staff login and
  permissions must be configured before a client-facing rollout.
- No Excel round-trip import/export or image upload UI in this change yet.
- Meta review/caching means visible updates cannot be guaranteed instantaneous.
- Full existing descriptions may be absent: export falls back to the existing
  compact summary or product name, never invented technical details.

## Verification so far

Production build and TypeScript passed during implementation. Added tests cover
product validation, serialization, parallel request isolation, currency precision,
Meta success/failure handling, cart deduplication, unavailable database behavior,
admin authentication and edit conflicts. These are local tests, not live Meta or
WhatsApp end-to-end proof. Re-run the full suite before deployment.

Local browser QA on 2026-09-15 verified product search, imported fields, image
preview, missing-image validation and a valid unchanged save. Chloe Tan remained
$499.00 and retained the original/CDN links. Two simultaneous unchanged API
saves were tested to require one success and one stale-revision rejection.
The HTTP concurrency test uncovered a real PostgREST retry loop caused by our
custom SQLSTATE 40001. Applied `20260915020000_product_conflict_response.sql`
to use PT409 and updated server/tests. Verified a direct stale RPC returns 409
in 386 ms; the concurrent local API test then returned [200,409] with price 499
unchanged. The earlier SQL-only test did not expose this transport-layer issue.
Unsaved product drafts now prompt before switching admin sections. The local
dev server used 127.0.0.1:4317 with a local-only QA credential, not the
production admin secret. Live customer behavior remains unchanged.
