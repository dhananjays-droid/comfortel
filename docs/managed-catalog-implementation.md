# Managed WhatsApp catalog — implementation checkpoint

## Not live yet

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
