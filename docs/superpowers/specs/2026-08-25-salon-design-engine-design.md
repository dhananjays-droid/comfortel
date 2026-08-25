# Salon Design Engine — design

Turns the Comfortel chat from "render one product into my photo" into "design my
salon and quote it". Seven phases, each shippable on its own.

Date: 2026-08-25

**Granularity.** This document is the shared architecture, not one implementation
plan. Phases 0 and 1 are specified to build now and become the first plan.
Phases 2–6 are sketched here only far enough to prove the architecture carries
them; each gets its own spec and plan when it comes up. Do not try to implement
past Phase 1 from this document.

---

## 1. Why this shape

Today a render is a dead end. The customer gets a JPEG and the pipeline forgets
everything: which products were in it, where they were, what they cost. Every
follow-up ("try it in tan", "add a fourth chair", "what does this come to?")
starts from scratch, and nothing connects the picture to an order.

The fix is one object. A **Design** is stored, edited and re-rendered; the image
becomes an artifact of it rather than the thing itself. Every feature below is
either a producer of a Design, a consumer of one, or a mutation.

This was the decision behind choosing **code-decides-placement** over
model-decides. The image model can arrange a room convincingly, but the
arrangement only ever exists inside a finished image — it cannot be inspected,
costed, corrected or added to. A computed plan can.

---

## 2. Constraints (measured, not assumed)

### Catalogue data

| Field | Coverage | Blocks |
| --- | --- | --- |
| price | 202/202 | — |
| `replaces` | 202/202 | — |
| ≥1 image | 202/202 | — |
| width only | 143/202 | — |
| **full W×D×H** | **72/202 (36%)** | any capacity or fit calculation |
| **placement type** | **119/202** (83 are generic `floor`) | type-aware placement |

`catalog-slim.json` carries no usable category field — every entry reads `none`.
Placement type in `catalog-full.json` is the only classification available.

### Reference images

136 products have more than one photo, but `referenceViews()` only selects extra
views when the **filename** matches `/front|side|back/`. So only 34 products
benefit and **102 products' extra photos are ignored entirely**. This is the
cheapest fidelity win available and it improves every phase below.

### Render model — GPT Image 2 (`gpt-image-2-image-to-image`)

- prompt limit 20,000 chars documented, 6,000 verified against the live API
- 16 input images (room + 15 references)
- `resolution: 1K | 2K | 4K`; 1K is the default
- 6 credits ≈ **$0.03** per render at 1K; failed tasks cost 0
- **80–98s** per render, measured
- product images must be mirrored onto kie storage — it cannot fetch
  `comfortelfurniture.com`
- `gpt-image-2-text-to-image` is available on the account (confirmed), which is
  what makes the no-photo path in Phase 4 possible

### The real ceiling on products-per-image

The 16-image API cap is **not** the binding limit. Per-product fidelity degrades
as more products share one frame — `lineup` already converges silhouettes at 4.
Treat **~6 visible products per image** as the quality ceiling and split beyond
that into zone renders (Phase 3). A 10-product basket is an API non-problem and a
fidelity problem.

---

## 3. The Design object

```
Design
  id
  room        { kind: "photo" | "dimensions" | "none",
                photoUrl?, kieRoomUrl?, dims?, scale? }
  items       [{ productId, qty, zone, position? }]
  plan        { pitch, wallRun, clearances, zones[], warnings[] }
  renders     [{ imageUrl, zone, mode, createdAt }]
  budget?     { ceiling, tier: "good" | "better" | "best" }
```

Who touches what:

| Feature | Relationship to Design |
| --- | --- |
| Quote / BOM | pure function of `items` — price × qty, no new data |
| Iterate in place | mutate one item, re-render, reuse `kieRoomUrl` |
| Multi-product basket | many `items`; planner fills `position` |
| Zone renders | one render per `plan.zones` entry |
| Area fit-out | planner *generates* `items` from `room.dims` |
| Budget-first | planner generates `items` subject to `budget.ceiling` |
| Shareable link | serialise a Design + its renders behind a URL |
| Fit check | `plan.warnings` |

`kieRoomUrl` is why iterate-in-place is cheap: the room is already uploaded, so a
swap is one `createTask`, not a re-upload.

---

## 4. Phases

### Phase 0 — Data foundation

No user-visible feature. Unblocks 2–5 and improves every render.

1. Backfill `dims_cm` W×D×H for the 130 products missing depth or height.
2. Classify the 83 `floor` products into real placement types.
3. Rewrite reference selection so it stops depending on filename spelling.
   Today `referenceViews()` only accepts an extra view when the URL contains
   `front`, `side` or `back`. Replace that with an explicit per-product view
   list in the catalogue, populated during the same pass as 1 and 2 — the
   selector then reads data instead of guessing from a string, and the 102
   products with unused photos contribute their views.

Done when: full dims ≥ 90% of renderable products, no product left as generic
`floor` unless it genuinely is, and `referenceViews()` returns >1 view for
materially more than 34 products.

Risk: 1 and 2 are data entry against the supplier site. Scope them as a
scraping pass plus manual review, not a code task.

### Phase 1 — Design object, quote, iterate-in-place, scale estimation

The spine. Four pieces, deliberately together because they share the object.

**Design object + persistence.** New Supabase table alongside `visualizations`.
Server functions to create, read, mutate.

**Quote / BOM.** Every render gains a line-item table: qty × product × unit
price, discount, total, and one click to `enquiries` carrying the design id, so
sales sees exactly the configuration the customer looked at. No new data — prices
are already 202/202.

**Iterate in place.** "Try the mirror in Sienna" mutates one item and re-renders
from the stored `kieRoomUrl`. Requires the chat marker protocol to learn a
mutation form alongside today's `[RENDER: mode,ids]`.

**Photo scale estimation.** On upload, one Anthropic vision call asks for
**ratios against known objects**, never absolute metres: how many chair-widths is
the styling wall, how many floor tiles across, is the counter standard height. A
salon chair is 60–70cm, tiles are 30 or 60cm, counters ~90cm — rulers already in
frame. Ratio judgements are far more reliable than metric ones.

Three safeguards, because this estimate will sometimes be wrong:

- carry a **range** internally (`wall ≈ 5.0–6.0m`), never a point value
- **never assert a hard refusal** — "four needs about 5.6m at working pitch and
  your wall reads as 5–6m, so four is tight and three is comfortable"
- **show it and let them correct it** — "reading your styling wall as about
  5.5m, tap to change". Not a required question; a correctable assumption.

When the vision call returns low confidence — sharp perspective, plain floor with
no tile grid — the planner must fall back to ordering-and-grouping and publish no
capacity claim. Build that fallback from the start.

Done when: a render carries a correct quote, a one-item swap re-renders without
re-upload, and an uploaded photo yields a correctable scale estimate or an
explicit "couldn't read the scale".

### Phase 2 — Multi-product basket

Select up to 10 products; the planner assigns each a `zone` and `position` from
placement type and dims. Chairs at mirror stations, mirrors on the wall above
benches, trolleys within arm's reach, backwash at the wash bay, reception at the
entrance.

Renders at most ~6 visible products per image (see §2) and defers the overflow to
Phase 3 rather than cramming one frame.

Depends on Phase 0's placement types.

### Phase 3 — Zone renders

One Design, several coherent images: reception / styling / wash / drying, each
rendered from the same plan so the set reads as one salon. ~$0.09 for three.

Two real pieces of work, not a freebie:

- **Parallel rendering.** Three sequential renders is 4.5 minutes. KIE tasks are
  independent, so create all three, then poll them together. Today's client polls
  exactly one `taskId` — this needs a multi-task poller and per-zone progress.
- **Cross-zone consistency.** The same product must look identical across
  images. The identical-instances prompt language from the mirror work applies
  here, but across renders rather than within one, which it has not been tested
  for.

### Phase 4 — Area → auto fit-out

"6m × 4m, four stations" → planner computes capacity from real dims (station
pitch, wall runs, circulation clearance, wash-bay depth), picks a coherent set,
renders it, and states its reasoning: *"four stations at 1.4m pitch fits your 6m
wall with 1.1m circulation."*

Three input paths: explicit dimensions; a photo plus Phase 1's scale estimate; or
nothing at all, in which case `gpt-image-2-text-to-image` generates the salon
from the plan.

Also delivers the **fit check** — `plan.warnings` surfaced as plain language,
including the honest refusals ("this backwash needs 1.1m depth; your alcove reads
as 0.9m").

Depends on Phase 0's dims.

### Phase 5 — Budget-first design

"$15,000 for four stations" → the Phase 4 generator with a price ceiling as a
constraint, offered as good / better / best.

Built after Phase 4 on purpose: it is the same generator plus a constraint, so
building it earlier means building the generator twice.

**Cost guard is mandatory here.** Three tiers × three zones is 9 renders ≈ $0.27
for one question. Render the chosen tier only; present the other two as quotes
without images until asked.

### Phase 6 — Shareable design link

Persist a Design and its renders behind an unguessable URL, so a salon owner can
send it to a partner, a landlord or a bank. Natural lead-capture point: an
enquiry attached to a design id tells sales exactly what was wanted.

**Open decision, not mine to make:** whether a shared link includes the
customer's room photo, or only the renders. A URL containing someone's salon
interior is a privacy question, and "unguessable" is not the same as "private".
Recommend renders-only by default with the room photo opt-in.

---

## 5. Cross-cutting

**Render budget.** Features multiply: zones × tiers × products. Needs a
per-session render cap and an explicit "this will generate 3 images" confirmation
before any fan-out. Without it a single ambitious question can cost a dollar.

**Parallel rendering.** Introduced in Phase 3, then relied on by 4 and 5. Worth
building as a general multi-task poller rather than a zone-specific one.

**Latency honesty.** At 80–98s per render, a 3-image pack is ~2 minutes even in
parallel. The UI must show per-zone progress, not one spinner. The polling window
is already 5 minutes after `c044552`.

**Cost table at 1K:**

| Action | Renders | Cost |
| --- | --- | --- |
| single product | 1 | $0.03 |
| basket (≤6 products) | 1 | $0.03 |
| zone pack | 3 | $0.09 |
| fit-out | 1–3 | $0.03–0.09 |
| budget tiers, chosen tier rendered | 1 | $0.03 |
| budget tiers, all rendered as packs | 9 | $0.27 |

---

## 6. Open questions

1. Phase 0 is data entry against the supplier site. Who does it, and is scraping
   `comfortelfurniture.com` for dimensions acceptable?
2. Shared links: renders only, or room photo included? (§Phase 6)
3. Per-session render cap — what number?
4. Does the 10-product selection limit stay at 10 given the ~6-per-image quality
   ceiling, or does the UI cap at 6 and offer a zone pack beyond that?
