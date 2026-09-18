# High-budget salon planning — 10 offline scenarios

Branch: codex/high-budget-salon-plans, based on origin/main e569b7a. No deployment, paid model calls, image generations or production writes.

These are deterministic planner/adapter tests using the checked-in catalog, not live WhatsApp/LLM tests. Catalog prices and availability have not been refreshed. Exact base/lift/footrest/plumbing configurations require verification; excluded accessories can increase the final price. Delivery, tax, installation and building work are excluded. Maximum stations means financial capacity under these assumptions, not proof that the room can fit them.

Nine scenarios fit their budgets; the deliberately demanding wash-heavy case reports a shortfall. Historical orders informed the scenarios, but historical prices, coupons, returns and test payments were not imported.

| Case | Request | Stations | Equipment subtotal | Remaining / shortfall |
|---|---|---:|---:|---:|
| 1 | $18k / 8-station starter | 8 | $17,714 | $286 |
| 2 | $25k / 12 stations, 4 washes, 12 trolleys, 3 stools | 12 | $24,541 | $459 |
| 3 | $35k / 20 stations, double mirrors, 5 washes | 20 | $32,164 | $2,836 |
| 4 | $45k / 29 stations, 17 washes | 29 | $49,150 | $4,150 shortfall |
| 5 | $45k / maximum stations | 31 | $44,513 | $487 |
| 6 | $65k / maximum stations | 45 | $63,243 | $1,757 |
| 7 | $65k / maximum island stations, limit 30 | 30 | $64,999 | $1 |
| 8 | $65k / fixed 5 stations (do not waste balance) | 5 | $16,569 | $48,431 |
| 9 | $65k / 24-station colour salon with LED mirrors | 24 | $50,843 | $14,157 |
| 10 | $65k / 30-station expansion, existing wash/reception/waiting | 30 | $43,245 | $21,755 |

## 1. $18k / 8-station starter

Requested inputs:

```json
{
  "budget": 18000,
  "stations": 8
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 8 | $599 | $4,792 |
| Tuscany Salon Mirror | 8 | $399 | $3,192 |
| Tan Saddle Salon Stool with Aluminium Base | 3 | $159 | $477 |
| Club Sand Wash Lounge with White Basin | 3 | $1,399 | $4,197 |
| Mova Salon Trolley – Bronze | 8 | $479 | $3,832 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 1 | $425 | $425 |

**Catalog equipment subtotal: $17,714. Remaining: $286.**

Assumes wall-based stations, with one chair per station. Support quantities are editable: 3 stool, 3 wash, 8 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 2. $25k / 12 stations, 4 washes, 12 trolleys, 3 stools

Requested inputs:

```json
{
  "budget": 25000,
  "stations": 12,
  "equipment_quantities": {
    "wash": 4,
    "trolley": 12,
    "stool": 3
  }
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 12 | $599 | $7,188 |
| Verona Arch Salon Mirror Black | 12 | $359 | $4,308 |
| Tan Saddle Salon Stool with Aluminium Base | 3 | $159 | $477 |
| Club Sand Wash Lounge with White Basin | 4 | $1,399 | $5,596 |
| Mova Salon Trolley – Bronze | 12 | $479 | $5,748 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 1 | $425 | $425 |

**Catalog equipment subtotal: $24,541. Remaining: $459.**

Assumes wall-based stations, with one chair per station. Support quantities are editable: 3 stool, 4 wash, 12 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 3. $35k / 20 stations, double mirrors, 5 washes

Requested inputs:

```json
{
  "budget": 35000,
  "stations": 20,
  "mirror_layout": "island",
  "equipment_quantities": {
    "wash": 5,
    "trolley": 20,
    "stool": 5
  }
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Blake Styling Chair Midnight | 20 | $499 | $9,980 |
| Halo Double Salon Mirror | 10 | $459 | $4,590 |
| Tan Saddle Salon Stool with Aluminium Base | 5 | $159 | $795 |
| Zippy Textured Black Wash Lounge With Black Basin | 5 | $1,199 | $5,995 |
| Mova Salon Trolley – Bronze | 20 | $479 | $9,580 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 1 | $425 | $425 |

**Catalog equipment subtotal: $32,164. Remaining: $2,836.**

Assumes island stations; mirror quantities account for documented faces where consistent, with one chair per station. Support quantities are editable: 5 stool, 5 wash, 20 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 4. $45k / 29 stations, 17 washes

Requested inputs:

```json
{
  "budget": 45000,
  "stations": 29,
  "mirror_layout": "island",
  "equipment_quantities": {
    "wash": 17,
    "trolley": 29,
    "stool": 8
  }
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Rosie Blush Styling Chair | 29 | $389 | $11,281 |
| Halo Double Salon Mirror | 15 | $459 | $6,885 |
| Blush Salon Stool | 8 | $119 | $952 |
| Zippy Stone Wash Lounge With White Basin | 17 | $899 | $15,283 |
| Mova Salon Trolley – Bronze | 29 | $479 | $13,891 |
| Maverick Reception Desk | 1 | $489 | $489 |
| Cloud Waiting Sofa | 1 | $369 | $369 |

**Catalog equipment subtotal: $49,150. Over budget by $4,150; quantities preserved, not presented as affordable.**

Assumes island stations; mirror quantities account for documented faces where consistent, with one chair per station. Support quantities are editable: 8 stool, 17 wash, 29 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 5. $45k / maximum stations

Requested inputs:

```json
{
  "budget": 45000,
  "objective": "max_stations"
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Rosie Blush Styling Chair | 31 | $389 | $12,059 |
| Arch LED Salon Mirror | 31 | $179 | $5,549 |
| Blush Salon Stool | 11 | $119 | $1,309 |
| Zippy Stone Wash Lounge With White Basin | 11 | $899 | $9,889 |
| Mova Salon Trolley – Bronze | 31 | $479 | $14,849 |
| Maverick Reception Desk | 1 | $489 | $489 |
| Cloud Waiting Sofa | 1 | $369 | $369 |

**Catalog equipment subtotal: $44,513. Remaining: $487.**

Budget-based capacity draft, searched up to 60 stations; NOT verified room capacity. Assumes wall-based stations, with one chair per station. Support quantities are editable: 11 stool, 11 wash, 31 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 6. $65k / maximum stations

Requested inputs:

```json
{
  "budget": 65000,
  "objective": "max_stations"
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Rosie Blush Styling Chair | 45 | $389 | $17,505 |
| Arch LED Salon Mirror | 45 | $179 | $8,055 |
| Blush Salon Stool | 15 | $119 | $1,785 |
| Zippy Stone Wash Lounge With White Basin | 15 | $899 | $13,485 |
| Mova Salon Trolley – Bronze | 45 | $479 | $21,555 |
| Maverick Reception Desk | 1 | $489 | $489 |
| Cloud Waiting Sofa | 1 | $369 | $369 |

**Catalog equipment subtotal: $63,243. Remaining: $1,757.**

Budget-based capacity draft, searched up to 60 stations; NOT verified room capacity. Assumes wall-based stations, with one chair per station. Support quantities are editable: 15 stool, 15 wash, 45 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 7. $65k / maximum island stations, limit 30

Requested inputs:

```json
{
  "budget": 65000,
  "objective": "max_stations",
  "max_stations": 30,
  "mirror_layout": "island"
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 30 | $599 | $17,970 |
| Arch LED with Pole Frame Black | 15 | $857 | $12,855 |
| Tan Saddle Salon Stool with Aluminium Base | 10 | $159 | $1,590 |
| Harriet Connect Tan II Electric Recline Wash Lounge With Massage | 10 | $1,699 | $16,990 |
| Mova Salon Trolley – Bronze | 30 | $479 | $14,370 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 1 | $425 | $425 |

**Catalog equipment subtotal: $64,999. Remaining: $1.**

Budget-based capacity draft, searched up to 30 stations; NOT verified room capacity. Assumes island stations; mirror quantities account for documented faces where consistent, with one chair per station. Support quantities are editable: 10 stool, 10 wash, 30 trolley, 1 reception, 1 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 8. $65k / fixed 5 stations (do not waste balance)

Requested inputs:

```json
{
  "budget": 65000,
  "stations": 5
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 5 | $599 | $2,995 |
| Verona Grande Blanco Terrazzo Salon Mirror – Single | 5 | $633 | $3,165 |
| Tan Saddle Salon Stool with Aluminium Base | 2 | $159 | $318 |
| Harlow Textured Black Electric Recline Wash Lounge With Massage | 3 | $1,899 | $5,697 |
| Studio 4 Drawer Steel Locking Salon Trolley Black | 5 | $549 | $2,745 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 2 | $425 | $850 |

**Catalog equipment subtotal: $16,569. Remaining: $48,431.**

Assumes wall-based stations, with one chair per station. Support quantities are editable: 2 stool, 3 wash, 5 trolley, 1 reception, 2 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 9. $65k / 24-station colour salon with LED mirrors

Requested inputs:

```json
{
  "budget": 65000,
  "stations": 24,
  "service_focus": "colour",
  "mirror_feature": "led",
  "equipment_quantities": {
    "wash": 8,
    "trolley": 24,
    "stool": 6
  }
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 24 | $599 | $14,376 |
| Oval LED Salon Mirror | 24 | $299 | $7,176 |
| Tan Saddle Salon Stool with Aluminium Base | 6 | $159 | $954 |
| Harlow Textured Black Electric Recline Wash Lounge With Massage | 8 | $1,899 | $15,192 |
| Mova Salon Trolley – Bronze | 24 | $479 | $11,496 |
| Walker Reception Desk | 1 | $799 | $799 |
| Ivy Waiting Sofa II Sage Green | 2 | $425 | $850 |

**Catalog equipment subtotal: $50,843. Remaining: $14,157.**

Assumes wall-based stations, with one chair per station. Support quantities are editable: 6 stool, 8 wash, 24 trolley, 1 reception, 2 waiting. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.

## 10. $65k / 30-station expansion, existing wash/reception/waiting

Requested inputs:

```json
{
  "budget": 65000,
  "stations": 30,
  "equipment_quantities": {
    "wash": 0,
    "reception": 0,
    "waiting": 0,
    "trolley": 10,
    "stool": 5
  }
}
```

| Equipment | Qty | Catalog unit price | Subtotal |
|---|---:|---:|---:|
| Oakley Styling Chair Tan | 30 | $599 | $17,970 |
| Verona Grande Blanco Terrazzo Salon Mirror – Single | 30 | $633 | $18,990 |
| Tan Saddle Salon Stool with Aluminium Base | 5 | $159 | $795 |
| Studio 4 Drawer Steel Locking Salon Trolley Black | 10 | $549 | $5,490 |

**Catalog equipment subtotal: $43,245. Remaining: $21,755.**

Assumes wall-based stations, with one chair per station. Support quantities are editable: 5 stool, 10 trolley. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.
