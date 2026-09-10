# Comfortel on WhatsApp — Go-Live Runbook

Everything between "the bot works on the Meta test number" and "any customer can
message it." Follow this top to bottom on your own; each step names the exact
screen and what to type into it.

Written 7 September 2026, against the build as it stands. The code is done — the
only code change in this whole document is one environment variable in Step 6.
Everything else is Meta paperwork.

---

## Where we are, and what "done" looks like

Today the number is Meta's **test number**. A test number can only exchange
messages with up to five recipient numbers you add by hand. Anyone else who
sends "Hi" gets nothing at all — Meta drops it silently, with no error anywhere
you can see. That is the entire reason strangers can't reach the bot right now.

Done means: a real phone number is registered to the WhatsApp Business Account,
the business is verified, and a stranger who has the number can message it and
get the full flow.

### One thing to understand before you start

**The number you register as the business number leaves WhatsApp forever.** Once
it's on the Cloud API it cannot be used in the WhatsApp app or the WhatsApp
Business app on any phone. Conversations live in Meta's Inbox and in our
`wa_messages` table, not on a handset.

This is different from what you're doing today. Right now you add *your* number
as a **recipient** so you can message the test number from your phone — your
number stays completely normal. Do not confuse the two, and do not register your
personal number as the business number.

---

## Effort

| Step | Your time | Waiting on Meta |
|---|---|---|
| 1. Get a clean spare number | 30 min – 3 days | — |
| 2. Register it on the WABA | 15 min | minutes |
| 3. Display name review | 5 min | minutes – 2 days |
| 4. Business verification | 1–2 hrs gathering documents | 1–3 days typical, up to 2 weeks on rejection |
| 5. Permanent access token | 20 min | — |
| 6. Swap env vars, redeploy | 5 min | — |
| 7. Verify end to end | 15 min | — |

**Realistic total: 3–7 days, of which roughly 3 hours is actual work.** The long
pole is business verification, and that is queue time, not effort. The single
most common cause of delay is document mismatch — see Step 4.

---

## Step 1 — Get a phone number that is not on WhatsApp

Requirements for the number:

- Not currently registered to WhatsApp, on any device.
- Can receive **one** SMS or **one** voice call, once, for a 6-digit code.
- Mobile or landline both work. Twilio and similar VoIP numbers usually work,
  though Meta rejects some ranges — if it fails, a physical SIM always works.
- You keep control of it long term. If it lapses, you lose the number on the WABA.

Cheapest reliable route: buy a prepaid SIM.

If you want to use a number that **already has WhatsApp** on it, you must delete
its WhatsApp account first: WhatsApp app → Settings → Account → Delete my
account. This wipes that number's chat history and cannot be undone. Wait a few
minutes afterwards before registering it on the API.

> Do not use your personal number. Do not use the number the sales team answers
> calls on unless you're happy for it to stop working in the WhatsApp app.

---

## Step 2 — Register the number on the WhatsApp Business Account

Go to **WhatsApp Manager**:

- https://business.facebook.com/wa/manage/phone-numbers/

(If that deep link redirects, start at https://business.facebook.com/settings and
pick WhatsApp Accounts → your WABA → Phone numbers. Meta moves these URLs around;
the entry point is always `business.facebook.com`.)

Click **Add phone number**, then fill in:

| Field | What to put |
|---|---|
| Display name | The business name customers will see, e.g. `Comfortel` |
| Category | Closest match, e.g. Shopping & Retail |
| Business description | One line about the business |
| Website | The Comfortel site |
| Phone number | The number from Step 1, with country code |
| Verification method | SMS or voice call |

Enter the 6-digit code when it arrives.

Then **set a two-step verification PIN** when prompted. Write the PIN down
somewhere permanent. You need it to re-register the number later, and recovering
a lost PIN means an 8-day lockout.

Official reference:
- https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/add-a-phone-number

After this succeeds, note the new **Phone number ID** shown on the number's row.
You need it in Step 6. It is a long numeric string — not the phone number itself.

---

## Step 3 — Display name review

This starts automatically once Step 2 completes. Meta checks that the display
name plausibly relates to the business. `Comfortel` is fine. Anything like
`Test`, `Bot`, or a name unrelated to the website gets rejected.

Guidelines:
- https://www.facebook.com/business/help/757569725593362

Status shows on the phone number's row in WhatsApp Manager: Pending → Approved.
Usually minutes; occasionally up to two days. You can continue to Step 4 while
this is pending.

---

## Step 4 — Business verification

This is the step that actually gates a public launch, and the slow one.

**Decide first whose business is verifying.** Comfortel's entity, or 88 Ventures
US, LLC? Whichever you pick, every document must belong to that entity and the
WABA must sit under that Business Manager. Getting this wrong means starting
over, so settle it before uploading anything.

Go to **Security Centre**:

- https://business.facebook.com/settings/security

Click **Start Verification**. You'll be asked for:

1. **Legal business name, address, phone, website** — must match your documents
   character for character, not approximately.
2. **A business registration document** — certificate of incorporation, business
   licence, or equivalent for the entity's jurisdiction.
3. **A document proving the address** — utility bill, bank statement, or tax
   document, dated recently, showing the *same* legal name and the *same*
   address as the registration document.
4. **A verification code** sent to the business phone or a domain-matched email.

Requirements in full:
- https://www.facebook.com/business/help/159334372093366

**The single biggest cause of rejection is address mismatch** — "Suite 4" on one
document and "Ste. 4" on the other is enough. Read both documents side by side
before uploading, and type the address exactly as the registration document
writes it.

Typical turnaround is 1–3 business days. A rejection puts you back in the queue,
which is how this becomes a two-week problem.

### About messaging limits

While the business is unverified there's a cap on how many unique customers you
can reach per rolling 24 hours. Verification lifts it, and the tier scales up
from there with good quality ratings.

Your **current, actual limit** is displayed on the phone number's row in
WhatsApp Manager. Read it there rather than trusting any number quoted in a doc
or a blog post — Meta changes these tiers regularly.

Reference: https://developers.facebook.com/docs/whatsapp/messaging-limits

### You do not need template approval to launch

A customer messaging us first opens a 24-hour service window, and everything the
bot does happens inside it — a render takes about 90 seconds. Message templates
only matter for cold-messaging a customer who hasn't written to us. Skip that
entirely for now.

---

## Step 5 — Permanent access token

**This is genuinely blocking and is outstanding right now.** The token currently
in Vercel is a temporary one that expires within about 24 hours. Production will
stop working the first morning nobody happens to be watching.

Go to **System Users**:

- https://business.facebook.com/settings/system-users

1. **Add** → name it something like `comfortel-wa-bot` → role **Admin**.
2. On that system user, click **Add Assets** → your WhatsApp Business Account →
   grant **Full control**.
3. Click **Generate new token**.
4. Select the Comfortel app.
5. Set **Token expiration: Never**.
6. Tick these permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
7. Generate, then **copy the token immediately** — it is shown exactly once.

Paste it straight into Vercel in Step 6. Don't put it in a file, a chat message,
or a commit.

---

## Step 6 — Swap the environment variables and redeploy

Only two values change. Everything else — app secret, verify token, webhook URL,
session secret, encryption key — stays exactly as it is, because it's the same
app and the same WABA.

In Vercel → Project → Settings → Environment Variables:

| Variable | New value |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | The Phone number ID from Step 2 |
| `WHATSAPP_ACCESS_TOKEN` | The permanent token from Step 5 |

Read by `src/lib/wa-client.server.ts`.

Then **redeploy** — Vercel does not pick up new environment variables on a
running deployment. Deployments → latest → ⋯ → Redeploy.

### Full list of what must be set, for reference

`ANTHROPIC_API_KEY`, `CRON_SECRET`, `KIE_API_KEY`, `KIE_IMAGE_RESOLUTION`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SALES_NOTIFICATION_EMAIL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_ACCESS_TOKEN`,
`WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_ENC_KEY`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_SESSION_SECRET`, `WHATSAPP_VERIFY_TOKEN`.

### Re-subscribe the app to the WABA

Moving to a new number can drop the app↔WABA subscription — the one that isn't
visible anywhere in the dashboard UI and that cost us a day last time. Confirm it:

```
curl -s "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
```

If the list is empty, subscribe:

```
curl -s -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
```

Expect `{"success":true}`.

---

## Step 7 — Verify it actually works

1. From a phone that has **never** been on the test recipient list, send `Hi` to
   the new number.
2. You should get the greeting with three buttons — Visualize, Build, Ask.
3. Tap **Visualize**, send a room photo, and confirm a render comes back in
   roughly 90 seconds.
4. Check Vercel logs for `200` responses on `/api/webhooks/whatsapp`.
5. Check the `wa_messages` and `wa_render_jobs` tables in Supabase for the rows.

Using a phone that was never on the allow-list is the point of the test — it's
the only way to prove the number is genuinely public.

---

## Step 8 — Let people find it

Verification makes the number **reachable**, not **discoverable**. Nobody has it.

- **Direct link:** `https://wa.me/<number, digits only, with country code>` —
  works immediately, no setup.
- **QR code and prefilled message:** https://business.facebook.com/wa/manage/message-qr-code/
- **Website button:** a "Chat on WhatsApp" link on the Comfortel site, pointing
  at the `wa.me` link.
- **Click-to-WhatsApp ads:** if you want paid traffic straight into the bot.

The first two are free and take minutes. The website button is a small piece of
work whenever you want it.

---

## Gotchas, collected

- **The number leaves WhatsApp.** Registering it to the Cloud API means no app
  access, ever. Decide before, not after.
- **Save the two-step PIN.** Losing it means an 8-day lockout on re-registration.
- **Address must match exactly** across both verification documents.
- **Vercel does not hot-reload environment variables.** Always redeploy.
- **The app↔WABA subscription is invisible in the UI.** If messages stop arriving
  and everything looks correct, check it with the curl above before debugging
  anything else. This has already bitten us once.
- **An unpublished app receives no production webhooks**, even for admins. The app
  is published; don't unpublish it.
- **Test number recipients don't transfer.** The five allow-listed numbers are a
  property of the test number and become irrelevant.

---

## Still open on the engineering side

Neither of these blocks launch.

- **Self-trigger for render jobs.** Renders are currently picked up by a cron
  tick roughly every minute, so a customer can wait up to ~120 seconds for a
  90-second render. Triggering the worker directly when a job is enqueued would
  remove most of that. Roughly an hour of work.
- **Duplicate React keys in `Markdown.tsx`** — cosmetic, web only.
