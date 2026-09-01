# Moving the assistant to WhatsApp

The step-by-step for taking the Comfortel assistant from the website chat to a
WhatsApp business number: what is already done, what Meta has to approve, what
still has to be built, and what it costs.

Written 1 September 2026. Every figure and link was checked on that date. Meta
changes both often — re-check anything you are about to act on.

---

## 1. The finding that decides the plan

**WhatsApp's image compression does not hurt the renders.** This was the
go/no-go, because the entire product is "does this chair look right in my
salon", and WhatsApp re-compresses every photo it carries.

It is a non-issue for a structural reason: `resize-image.ts` already downscales
every room photo to **1024 px, JPEG q0.85** before it reaches the render host.
WhatsApp delivers at **≤1600 px, JPEG ~q75** — more than we keep. Its cap never
binds, so the only new loss is one extra JPEG generation, applied *above* our
own target and then partly averaged out when we downscale.

Measured, worst case (photos under 1600 px, so no attenuating downscale):

| Room  | WhatsApp q75      | WhatsApp q60 (pessimistic) |
| ----- | ----------------- | -------------------------- |
| room1 | 33.8 dB / SSIM 0.9983 | 32.8 dB / SSIM 0.9980  |
| room2 | 40.9 dB / SSIM 0.9995 | 37.3 dB / SSIM 0.9979  |

Four renders were then run through the real pipeline — each room via the normal
web path and via the pessimistic q60 WhatsApp path, same prompt, same product
references, the room photo the only variable. All four preserved the room
correctly (marble floor, wood door, ceiling lights in room1; slat wall,
decorative screen, LED strips, waiting sofa in room2) and all four placed the
full 4 chairs / 4 mirrors / 2 trolleys. The differences are ordinary
render-to-render variation, not compression damage.

**Do not "fix" this.** Asking customers to send photos as a Document to dodge
compression would cost more in drop-off than it could possibly buy.

---

## 2. What is already built

| Piece | Where | State |
| --- | --- | --- |
| Platform limits (buttons, list rows, caps) | `src/lib/whatsapp.ts` | Done |
| Scripted menu — greeting, browse, plan, handoff | `src/lib/wa-flow.ts` | Done, pure, tested |
| WhatsApp-accurate preview surface | `src/components/WhatsAppView.tsx` | Done, behind `WHATSAPP_MODE_ENABLED` |
| Server-side session store | `src/lib/session.ts`, `session.functions.ts`, `supabase/migrations/…_sessions.sql` | Done |
| WhatsApp session key (HMAC of phone) | `src/lib/session.server.ts` | Done |

The session store is the piece that mattered. Until it existed, "the
conversation" was a React tree that only the page that built it could see, and a
webhook arriving with a phone number and nothing else had no way to find it.
Now the browser holds a key and the server holds the state, so both channels can
drive the same row.

`WHATSAPP_MODE_ENABLED` in `src/routes/index.tsx` is `false`. Flip it to see the
preview.

### Still to build

1. **The webhook route** — `GET` for verification, `POST` for messages, with
   `X-Hub-Signature-256` validation. Must acknowledge in seconds.
2. **A job queue.** Renders take 80–98 s. The webhook cannot hold the request
   open, so it replies "working on it" and the render posts back when done.
3. **Durable render hosting.** kie serves from an expiring tempfile CDN
   (`ROOM_TTL_MS` is 15 minutes). Renders must be persisted before they are sent,
   and converted to JPEG under the 5 MB send limit.
4. **Outbound message builders** — turning a reply into text / buttons / list,
   held to the caps in `whatsapp.ts`.
5. **Markdown stripping.** WhatsApp supports `*bold*`, `_italic_`, `~strike~`
   and monospace. No headings, no tables, no links. The model is currently told
   light markdown is fine.
6. **Scope guard on the system prompt** — see §6, this is a policy requirement.

---

## 3. Meta setup, in order

Each step gates the next. Steps 1 and 6 are the slow ones — start them first.

### Step 1 — Meta Business Account, then Business Verification

- Create/confirm at **<https://business.facebook.com/>**
- Verify at **<https://business.facebook.com/settings/security>** → Security Centre → Start Verification

You upload business documents (registration, address, phone). Takes days,
sometimes weeks, and it gates your messaging limits — unverified accounts are
capped hard. **Begin this before anything else.**

### Step 2 — Create the app

- **<https://developers.facebook.com/apps>** → Create App → **Business** type → add the **WhatsApp** product
- Guide: **<https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/>**

A test WhatsApp Business Account and test number are created automatically, with
relaxed limits and no payment method — enough to build the whole integration
before any of the approvals below land.

### Step 3 — Add the real phone number

In **WhatsApp → API Setup**. The number must **not** be registered on the
consumer WhatsApp app or the WhatsApp Business app. If it is, delete that
account first and wait — the number is unusable until the old registration
clears.

A number can only ever belong to one WABA. Use a fresh one.

### Step 4 — System User and a permanent token

- **<https://business.facebook.com/latest/settings/system_users>** → Add → assign the app → Generate token

Grant exactly these:

| Permission | What it is for |
| --- | --- |
| `whatsapp_business_messaging` | Send and receive messages. The one that actually carries traffic. |
| `whatsapp_business_management` | Manage the WABA: phone numbers, message templates. |
| `business_management` | Manage the business assets themselves. Needed for the catalog path. |

The temporary token in the API Setup panel expires in 24 hours. The System User
token does not — it is what production uses.

**App Review is probably not needed.** Advanced Access is only required if your
app touches WhatsApp accounts **owned by someone else** — the BSP / multi-client
model. Messaging from your own number on Standard Access needs no review. If you
ever do need it: App Dashboard → App Review → Permissions and Features, and
expect a video walkthrough and 24–72 hours.

### Step 5 — Webhook

- Guide: **<https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks>**
- App Dashboard → WhatsApp → Configuration → Edit
- Subscribe to the **`messages`** field

You provide an HTTPS callback URL and a verify token you invent. Meta sends a
`GET` with `hub.challenge` — echo it back. Then validate every `POST` against
`X-Hub-Signature-256` using your app secret. **Do not skip the signature check**:
without it anyone who learns the URL can drive your bot.

### Step 6 — Display name approval

WhatsApp Manager → Phone Numbers → the name customers see. Reviewed separately,
and rejections are common when the name does not match the verified business.
Use "Comfortel". Start this early — it is slow and it blocks going live.

### Step 7 — Message templates

- **<https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates>**
- Created in WhatsApp Manager or via the API; approved per template, per language

You need these to say anything outside the 24-hour window. Minimum useful set:
one re-engagement ("your salon render is ready"), one handoff confirmation.
Utility-category templates are cheaper than marketing and approve more easily.

### Step 8 — Product catalog (optional, but the best fit for the plan tray)

- **<https://business.facebook.com/commerce/>** → create a catalog → connect it to the WABA

This is the one WhatsApp primitive that genuinely replaces the plan tray: a
native cart with per-item quantities, up to 30 products in a multi-product
message. It needs Commerce Manager setup and a commerce policy review, so treat
it as phase two — ship with list messages first.

---

## 4. What the caps do to the UI

From `src/lib/whatsapp.ts`, which `carrierFor(n)` uses to pick the primitive:

| Primitive | Cap |
| --- | --- |
| Reply buttons | 3 per message, 20-char labels |
| List message | 10 rows total, 24-char titles, 72-char descriptions |
| Multi-product message | 30 products, needs a synced catalog |
| Body / footer | 1024 / 60 characters |

Maps cleanly: the 3-mode picker onto 3 reply buttons; a 10-piece plan onto
exactly one list message (`MAX_REFERENCES` is 10, which is also the list cap —
raising it silently forces the heavier catalog path); the 80–98 s render onto a
medium where waiting is normal.

Does not survive: the product carousel, the live-subtotal plan tray, the
before/after slider. Those are web affordances. Plan for the cart, or for a
"your plan so far" text summary after each change.

---

## 5. Cost

**This changed on 1 October 2026 — one month from now.**

Service messages (free-form replies inside the 24-hour customer service window)
and utility messages inside that window **stop being free** and are billed at
the utility rate for the recipient's country. They had been free since late 2024.

So the old plan of "keep everything inside the 24-hour window and pay nothing"
no longer holds. Budget per message, not per conversation.

- Current rates: **<https://developers.facebook.com/docs/whatsapp/pricing>**
- Renders remain roughly **$0.03** each on kie, unchanged by any of this.

A BSP (360dialog, Gupshup, Interakt, Twilio) adds a markup on top but removes
most of the approval friction. Worth it for a first launch; revisit once volume
justifies going direct.

---

## 6. The policy risk — read this one

**Meta banned general-purpose AI assistants on the WhatsApp Business Platform on
15 January 2026.** Anyone who registered on or after 15 October 2025 was subject
immediately.

Banned: an LLM bot that holds open-domain conversation on any topic and is not
restricted to a specific business process.

Explicitly still allowed: structured, task-oriented assistants — customer
service, FAQ, order and product enquiries, appointment management.

The Comfortel assistant is task-specific salon-furniture sales, so it sits on the
allowed side. **But that is a property of how it behaves, not of what we call
it.** It currently runs a general model against a catalogue prompt with no
refusal path, so a customer asking it to write their marketing copy would get an
answer — and that is the exact behaviour the ban describes.

Before going live, `SYSTEM_INSTRUCTIONS` in `src/lib/chat.functions.ts` needs an
explicit scope guard: decline anything not about Comfortel products, a fit-out,
or an order, and steer back. Cheap to add, and it is the difference between a
compliant bot and a banned number.

Policy: **<https://business.whatsapp.com/policy>**

---

## 7. Order of work

1. Add the scope guard to the system prompt (§6). Small, and it gates everything.
2. Start Business Verification and display name approval (§1, §6) — the slow queues.
3. Build the webhook + queue against the free test number (§2).
4. Persist renders to durable storage, drop the tempfile dependency.
5. Outbound builders held to the caps; strip markdown.
6. Templates for the out-of-window cases.
7. Ship on list messages. Add the catalog cart once it is earning its keep.

---

## 8. Environment

```
WHATSAPP_SESSION_SECRET=      # HMAC key for phone -> session key. Rotating it orphans every session.
WHATSAPP_VERIFY_TOKEN=        # you invent this; Meta echoes it during webhook setup
WHATSAPP_APP_SECRET=          # for X-Hub-Signature-256 validation
WHATSAPP_ACCESS_TOKEN=        # the System User permanent token
WHATSAPP_PHONE_NUMBER_ID=     # from the API Setup panel
SUPABASE_SERVICE_ROLE_KEY=    # already required; the session store needs it
```

Never commit these. `WHATSAPP_SESSION_SECRET` is what keeps phone numbers out of
the database — the session key is an HMAC, so a leaked table is not a leaked
contact list.

---

## 9. Two traps that will cost you a day each

**Media URLs expire in 5 minutes.** An inbound photo arrives as a media *ID*.
You exchange it for a URL via the Graph API, and that URL needs your auth token
and dies in about five minutes. Download it inside the webhook handler, straight
away — do not queue the ID and fetch it later.
Reference: **<https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media>**

**A number belongs to one WABA, forever-ish.** Registering the wrong number, or
one already on the consumer app, is the single most common way a launch slips a
week. Check before you register, not after.
