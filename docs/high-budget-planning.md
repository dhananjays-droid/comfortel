# Large equipment proposals

The WhatsApp `plan_salon` tool now supports fixed counts up to 60, or explicit
`objective: "max_stations"`. The latter enumerates counts using the same
service, stock, finish and mirror-layout filters as the returned proposal.
`stations`/`max_stations` act as upper bounds in capacity mode. This is not
permission to add stations when the user asked for a fixed count.

`equipment_quantities` accepts explicit wash/trolley/stool/reception/waiting
counts, including zero for existing equipment. Defaults are editable assumptions:
one trolley per station, one shared stool per three stations, wash units per
three stations (none for dedicated makeup/brows), one reception/waiting item.
Existing optional enhancements never override explicit counts. Island mirror
quantities continue using documented double-sided units.

Planning/session/intake limits are separate from image generation. The existing
20-per-product render limit is unchanged; quote quantities must not be truncated
to make an image feasible. No additional AI or image call is introduced.

## Pricing boundary

These remain provisional catalog estimates, not verified configured quotes.
The current catalog does not encode a validated parent/option bill of materials.
Do not invent included bases/lifts/plumbing, import historical prices, or apply
historical discounts. The proposal explicitly requests configuration checks.
Before purchase-ready quoting, the catalog needs verified option IDs,
compatibility, included-versus-paid components and current pricing. A large
unspent balance on a fixed-size plan is valid, not a reason to add random stock.

## Verification

Run `WRITE_PLAN_REPORT=1 npm run test:run` for ten offline scenarios plus the
regression suite. The generated `outputs/high-budget-plans/REPORT.md` contains
every request, SKU selection, quantity and subtotal. One intentionally excessive
wash-heavy basket must disclose its shortfall without changing quantities.
The mocked conversation adapter also checks one-call proposal persistence above
20 stations, session reload and no render enqueue. No live LLM, inventory, room
fit, PDF delivery or customer WhatsApp messaging is claimed by these tests.
