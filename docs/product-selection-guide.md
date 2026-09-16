# Comfortel product selection: evidence and operating rules

Updated 16 September 2026. Local implementation; not a production deployment or client approval.

## What salon infrastructure changes about selection

Start with services, staff/station count, equipment budget, room dimensions and fixed utilities—not an expensive furniture list. Account for the client's path through reception, styling, washing and checkout, plus staff circulation, chair rotation/recline, tool storage and maintenance access. A chair's width is not its complete operating footprint. Review layout and local requirements with qualified installers/designers.

[Keller International's salon floor-planning guidance](https://keller4salon.com/en-ca/blogs/keller-international-blog/salon-floor-plans-layouts-and-space-planning-to-optimize-the-client-experience) supports this approach. It is general planning guidance, not a model-specific specification or a legal clearance standard.

## Practical selection distinctions

| Need | Selection logic | What still needs checking |
| --- | --- | --- |
| Everyday hair cutting/styling | Prefer products marketed as hair-styling chairs. Do not upgrade to a beauty-treatment chair merely because its price is higher. | Exact base/lift, seat-height range, assembled load rating, operating footprint. |
| Dedicated makeup/brow services | Use chairs explicitly marketed for those services, including documented recline where needed. Do not automatically add hair-washing infrastructure. | Practitioner requirements and head/client support for the actual procedure. |
| Barber services | Use documented barber chairs; do not assume every reclining beauty chair is a barber chair. | Recline/rotation clearance, head support, base and capacity. |
| Wall stations | Wall-mounted mirrors keep the central area available for circulation, subject to room shape and mounting suitability. | Wall construction/fixing, dimensions and separate work surface where none is documented. |
| Island stations | Use documented double-sided products and count actual working faces. Three chairs may use two double-sided mirrors, with an unused face; that is not permission to add a fourth chair. | Floor/ceiling fixing, both-sided circulation, utilities and whether the advertised configuration contains both mirrors. |
| Colour-focused service | Prefer documented daylight mirror lighting when the client has not requested a conflicting feature. | CRI is unknown unless published. Kelvin alone does not guarantee colour accuracy, and overall salon lighting still matters. |
| Work surface required | Prefer mirrors explicitly described with a bench/work surface. A decorative mirror does not imply a shelf is included. | Size, mounting and actual included configuration. |
| Compact station | Use a published compact/narrow design as a shortlist signal, not proof that it fits. | Full measurements, chair rotation, operator and access clearances. |
| Wash area | Complete wash lounge/system, not basin or hose accessories. | Plumbing, maintenance access, power for electric features and service demand. |
| Extra budget | Suggest relevant optional display/storage/service-area scope and ask before adding. | Actual business need, room fit, product availability and costs outside equipment. |

Mirror shape is primarily a design/space preference, not a universal quality ranking. Do not label round, arched or LED mirrors inherently better for every salon.

## Product evidence that changed the implementation

- [Claudia](https://comfortelfurniture.com/shop/salon-furniture-equipment/makeup-all-purpose-salon-chairs/claudia-reclining-salon-chair-stone/) is marketed for makeup and beauty services such as brows/threading. It is no longer the automatic expensive chair for an ordinary styling plan.
- [Chloe Tan](https://comfortelfurniture.com/shop/salon-furniture-equipment/styling-chairs/chloe-tan-styling-chair-with-footrest/) documents hair styling, adjustable height and hair-trap-related design. These are useful service/maintenance signals, not an invented durability score.
- [Circa LED](https://comfortelfurniture.com/shop/salon-furniture-equipment/styling-stations-mirrors/circa-led-round-salon-mirror/) publishes dimming and 6000K daylight lighting. Its Australian/NZ electrical wording is NOT US electrical approval.
- [Villa II with Pole Frame White](https://comfortelfurniture.com/shop/salon-furniture-equipment/styling-stations-mirrors/villa-ii-with-pole-frame-white/) describes a double-sided island configuration. Do not count every such unit as a single wall station.
- [Harlow wash lounge](https://comfortelfurniture.com/shop/salon-furniture-equipment/shampoo-area-backwash-systems/harlow-tan-electric-recline-wash-lounge/) is a different operational zone from styling seating, with electrical/plumbing implications.

## The new field and source of truth

The bot's product facts now include a structured **selection_profile**: primaryUse, documentedFeatures, mirrorLayout, sourceUrl, checkedAt, evidenceStatus, missingFacts and checks. Internally the profile also retains evidence excerpts and mirror face counts. It is derived in `src/lib/product-selection.ts` from the current product plus `src/data/product-selection-evidence.json`.

This is NOT a newly deployed Supabase column. The existing managed catalog remains authoritative for price, stock, product identity, images and saved specifications. The separate evidence layer is keyed by exact product ID/name/URL and guarded against changed descriptions/categories. It supports the current managed-catalog runtime without requiring duplicate manual product entry. Changed identity/configuration descriptions invalidate the website overlay until refreshed. New/unmatched products retain catalog-only evidence status.

The 201 product pages were checked automatically at low concurrency: 200 passed primary ID and title checks; the Zippy Textured Black Wash Lounge With White Basin URL (346173) returned 404. Review that product before refreshing or replacing its URL. A successful page check is not certification that every field is complete. Many original description gaps remain; the published feature/use blocks add selection evidence, not fabricated replacement specifications.

Existing specification values win on conflicts. Product dimensions are not inferred from shipping tables; prices, stock and rendering dimensions are not rewritten. Optional bases/lifts remain options, not default inclusions. Statements in webpage content are reference data, never bot instructions.

## How selection uses the field

1. Respect requested service, layout, finish and explicit features first.
2. Filter products using affirmative documented evidence; unknown features do not count as a match.
3. Apply the existing budget allocator inside that suitable set. Price remains a cost, not a quality score.
4. Show why a chair/mirror matches and what needs confirmation.
5. Keep selected IDs/quantities authoritative; expansion choices are separate until agreed.

Search also reads product-use/feature evidence rather than only names/categories. Explicit LED, compact and reclining searches require corresponding evidence. Full evidence is not injected into every model turn; compact product context remains in use.

## Remaining limits and client review

- Comfortel should confirm assembled load ratings, exact variant/base/lift mapping, US installation/electrical details, and missing operating dimensions.
- Source assertions are not independent testing. No claim of universal comfort, safety certification, durability or best-in-class performance is derived from marketing text.
- The allocator still uses price within eligible candidates. Identical needs can correctly return identical products; variety must come from genuine preference/service differences, not random rotation.
- Dedicated makeup planning is not a mixed-service salon plan. Ask before changing that scope.
- Rendering fidelity issues from the previous test are separate; this enrichment does not certify that a generated image exactly matches every item.
- Runtime/profile routing is tested offline; no new paid model evaluation or generation is included here.

## Refresh and review

Run `node scripts/enrich-product-selection.mjs` to refresh evidence (24-hour local cache, two workers, no AI calls). It writes the sourced evidence file and `docs/product-selection-audit.json`. Network errors retain prior records rather than erase valid evidence; use timestamps and the audit to identify stale/unavailable pages. The parser rejects changed titles and wrong product IDs for review. Review the resulting diff and run tests before deploying.
