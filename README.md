# Comfortel chatbot

A product-discovery chatbot for Comfortel salon, barber and spa furniture. The
customer describes the space they're fitting out, the assistant recommends real
SKUs as cards, and from any card they can see the piece rendered into a photo of
their own salon or request a quote.

**→ [GUIDE.md](GUIDE.md) explains how it works** — the request flow, why there
are two catalog files, how the prompt and marker protocol are built, the render
modes and what each costs, and the traps that already bit us.

## Setup

Six environment variables. All read server-side except the two `VITE_` ones,
which are inlined into the client bundle **at build time** — a build without
them ships a broken client that no runtime setting can fix.

| Name                            | Needed by          | Without it                            |
| ------------------------------- | ------------------ | ------------------------------------- |
| `ANTHROPIC_API_KEY`             | server             | chat dead                             |
| `KIE_API_KEY`                   | server             | renders dead                          |
| `SUPABASE_SERVICE_ROLE_KEY`     | server             | quote requests fail; render cache off |
| `SUPABASE_URL`                  | server             | as above                              |
| `VITE_SUPABASE_URL`             | client, build time | every click throws                    |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | client, build time | every click throws                    |

Locally these go in `.env` (gitignored). **Vite reads it once at startup** —
restart the dev server after editing. On Vercel and Lovable, env vars only apply
to deployments built _after_ they were added, so redeploy rather than expecting a
live deployment to pick them up.

```sh
npm i
npm run dev     # http://localhost:8080
```

Before pushing: `npx tsc --noEmit && npx eslint . && npm run build`.

Migrations in `supabase/migrations/` need applying for quote requests to work.

## Theme reference

use this theme :
import { brandMainDetailsStore } from '@/stores/brandMainDetailsStore';
import { generateShades } from '@/utils/generatePalette';

const { brandsMainDetails } = brandMainDetailsStore.getState();

// Neon lime accent (Design reference: #C6F25C)
const defaultPrimaryShades = {
25: '#FAFEE8',
50: '#F4FCCC',
100: '#E9F99C',
200: '#DCF66E',
300: '#C6F25C',
400: '#B5E33D',
500: '#9FCC2B',
600: '#85B01F',
700: '#678818',
800: '#4A6211',
900: '#2F3E0B'
};

const primaryShades =
//@ts-ignore
brandsMainDetails?.colors?.primary?.length > 0
? //@ts-ignore
generateShades(brandsMainDetails?.colors?.primary)
: defaultPrimaryShades;

// v5 design tokens — warm cream canvas (#F7F3EE family), elevated surfaces toward white
// 25/50=surface lift, 100=anchor cream, 200–400=hover/dividers, 500+=border-strong through ink-adjacent neutrals
// Warm neutral canvas scale — anchored at #F7F3EE (light cream)
const neonWhiteShades = {
25: '#FEFCF9',
50: '#FBF7F2',
100: '#F7F3EF',
200: '#EDE8E1',
300: '#E1DAD0',
400: '#D2C9BB',
500: '#B8AC9A',
600: '#918676',
700: '#6B6256',
800: '#443E36',
900: '#211E1A'
};
// const neonWhiteShades = {
// 25: '#FFFFFF',
// 50: '#FFFFFF',
// 100: '#FAFAF8',
// 200: '#F4F1EC',
// 300: '#EAE7E0',
// 400: '#EAE7E0',
// 500: '#D6D2C8',
// 600: '#A8A296',
// 700: '#6B6459',
// 800: '#3A362E',
// 900: '#0F0F0C'
// };

// Dark ink scale — .500 is ink-1 primary text; also serves as accent-ink on lime
const secondaryShades = {
25: '#F4F1EC',
50: '#EAE7E0',
100: '#D6D2C8',
200: '#A8A296',
300: '#6B6459',
400: '#3A362E',
500: '#0F0F0C',
600: '#0A0A08',
700: '#070705',
800: '#030302',
900: '#000000'
};

/** Warm tinted cream — inline chips, toolbar controls “on” resting fill */
const WARM_SURFACE = '#F2F1EB';

// Shared primary icon color for non-Chakra icon libs (lucide/react-icons/etc).
export const ICON_PRIMARY_COLOR = 'var(--chakra-colors-primary-600)';
// Shared primary icon token for Chakra-aware components.
export const ICON_PRIMARY_TOKEN = 'primary.600';
// Shared neutral icon color for non-Chakra icon libs (lucide/react-icons/etc).
export const ICON_COLOR = 'var(--chakra-colors-secondary-300)';
// Shared neutral icon token for Chakra-aware components.
export const ICON_COLOR_TOKEN = 'secondary.300';

// Light warm-gray trendline stroke used on metric tiles' sparkline / direction sketch.
// Sits between `border` (#E1DAD0) and `ink.4` (#A8A296) — visible on `surface` but not loud.
export const SPARKLINE_COLOR = 'var(--chakra-colors-neon_white-500)';
export const SPARKLINE_TOKEN = 'neon_white.500';

// "primary" and "gray" are primary colors, rest of them are secondary colors
export const colors = {
// Override Chakra's built-in `white` so bg='white' components harmonize with the warm cream canvas.
// Without this, 800+ components using bg='white' render as stark #FFFFFF against warm cream bg/surface,
// causing harsh visual contrast after the neonWhiteShades warm shift.
white: neonWhiteShades[25], // #FEFCF9 — warmest near-white, matches surface2
primary: primaryShades,
neon_white: neonWhiteShades,
secondary: secondaryShades,

// ─── Semantic layer ───────────────────────────────────────────────────────
// New components should reference THESE tokens, not raw neon_white/secondary.
// Intent is encoded here — devs stop guessing which shade is a border vs hover.
// When dark mode arrives, only this section flips. Raw scales stay frozen.
//
// Usage: bg='bg' bg='surface' color='ink.1' borderColor='border'
// ─────────────────────────────────────────────────────────────────────────

// Surfaces (light to elevated)
sidebar_bg: '#FFFFFF', // app sidebar background
// Keep sidebar active state intentionally neutral (no primary tint),
// with a very subtle highlight and gray icon/text emphasis.
sidebar_active_bg: primaryShades[100],
sidebar_active_hover_bg: primaryShades[50],
sidebar_active_text: secondaryShades[400],
sidebar_active_indicator: primaryShades[500],
sidebar_inactive_text: secondaryShades[300],
sidebar_row_hover_bg: neonWhiteShades[200],
/** Top app bar — same chrome as sidebar for a continuous left/header edge */
navbar_bg: '#FFFFFF',
bg: neonWhiteShades[100], // page canvas (#FAFAF8)
surface: neonWhiteShades[50], // cards, panels (#FFFFFF)
surface2: neonWhiteShades[25], // modals, popovers, elevated sheets (#FFFFFF — flips in dark mode)

// Paper/print aesthetic — warmer, refined surfaces (Storyboard editor, focused work surfaces)
paper: '#F7F6F1', // warm cream page canvas
paperRaised: '#FAFAF6', // slightly elevated cream (scenes / panels)
warmSurface: WARM_SURFACE, // tinted cream surface (inline pills, soft fills)

/**

- Compact toolbar controls in “on” state (e.g. Discover Live Search next to neutral chips).
- `activeBg` must read clearly on `bg` (cream canvas) — not `warmSurface`-adjacent or the control disappears.
- Uses primary scale indirectly — brand-aware; use these tokens, not `primary.*` in feature UI.
  _/
  toolbarToggle: {
  /_* Resting fill — white chip (same hex as `surface2`); visible edge comes from `activeBorder` _/
  activeBg: neonWhiteShades[25],
  /_* Hover — soft brand wash, still calmer than `primary.100` _/
  activeBgHover: primaryShades[50],
  /_* Resting border — strong enough silhouette on cream _/
  activeBorder: primaryShades[200],
  /_* Hover border _/
  activeBorderHover: primaryShades[300],
  /_* Icon emphasis when active */
  activeIcon: primaryShades[600]
  },

// Dark surface scale — for timeline, code blocks, dark editor surfaces
surfaceDark: {
base: '#131312', // outermost dark canvas (timeline footer)
raised: '#1C1C1A', // ruler row, label column
elevated: '#262624' // blocks, dark buttons
},

// Borders
border: neonWhiteShades[300], // default dividers / card outlines (#EAE7E0)
borderStrong: neonWhiteShades[500], // focus rings, emphasized separators (#D6D2C8)
borderDark: '#2A2A28', // dividers within dark surfaces (timeline tracks)

// Ink (text hierarchy)
ink: {
1: secondaryShades[500], // primary text — headings, labels (#0F0F0C)
2: secondaryShades[400], // body copy (#3A362E)
3: secondaryShades[300], // secondary / meta text (#6B6459)
4: secondaryShades[200] // disabled / placeholder (#A8A296)
},

// Ink on dark surfaces (timeline, code blocks)
inkOnDark: {
1: '#E8E7E1', // primary text on dark
2: '#97968F' // secondary / meta on dark
},

// Accent (brand color — dynamic via white-label, defaults to neon lime)
accent: {
DEFAULT: primaryShades[300], // brand fill (#C6F25C default)
muted: primaryShades[100], // tinted backgrounds, badges (#E9F99C default)
strong: primaryShades[500], // hover / active states (#9FCC2B default)
ink: secondaryShades[500], // text ON accent background (#0F0F0C — always dark)
electric: '#D4FF3F', // electric lime — playhead, eye-catch CTA dot
deep: '#A8D900', // deep lime — active rails, focus indicators
soft: '#ECFFB0' // soft lime — pale tinted background
},

// Slideshow-specific lime palette. Page-local — not part of the white-label
// accent system. Use ONLY on the UGC Slideshow page (per design redesign).
accentLime: {
DEFAULT: primaryShades[300], // primary lime — Generate button bg, brand mark
soft: '#ECFFB0', // pale lime — active tab/pill bg, step pill, hover tint
ink: '#1F1A2E', // near-black for text on lime + filled buttons
deep: '#A8D900' // deep lime — secondary accents on soft backgrounds
},

// Timeline clip type-codes — used as left-edge stripe on dark timeline blocks.
// Each must be vivid enough to read on `surfaceDark.elevated` (#262624).
clip: {
video: '#B5E33D', // lime-400 — primary visual content
image: '#84CAFF', // blue-300 — static image
snapshot: '#7CD4FD', // bluelight-300 — website / web snapshot
audio: '#FD853A', // orange-400 — voiceover / sfx
text: '#B692F6', // violet-400 — text overlay
caption: '#A4BCFD', // indigo-300 — caption track
avatar: '#FAA7E0', // pink-300 — avatar / talent
music: '#FEC84B', // yellow-300 — background music
scene: '#D4FF3F', // electric lime — scene-level duration block
fallback: '#97968F' // inkOnDark.2 — unknown / generic items
},
whiteAlpha: {
100: '#FFFFFF',
200: '#FFFFFF',
300: '#FFFFFF',
400: '#FFFFFF',
500: '#FFFFFF',
600: '#FFFFFF',
700: '#FFFFFF',
800: '#FFFFFF',
900: '#FFFFFF'
},
gray: {
25: '#FCFCFD',
50: '#F9FAFB',
100: '#F2F4F7',
200: '#EAECF0',
300: '#D0D5DD',
400: '#98A2B3',
500: '#667085',
600: '#475467',
700: '#344054',
800: '#1D2939',
900: '#101828'
},
bluegray: {
25: '#FCFCFD',
50: '#F8F9FC',
100: '#EAECF5',
200: '#D5D9EB',
300: '#AFB5D9',
400: '#717BBC',
500: '#4E5BA6',
600: '#3E4784',
700: '#363F72',
800: '#293056',
900: '#101323'
},
bluelight: {
25: '#F5FBFF',
50: '#F0F9FF',
100: '#E0F2FE',
200: '#B9E6FE',
300: '#7CD4FD',
400: '#36BFFA',
500: '#0BA5EC',
600: '#0086C9',
700: '#026AA2',
800: '#065986',
900: '#0B4A6F'
},
blue: {
25: '#F5FAFF',
50: '#EFF8FF',
100: '#D1E9FF',
200: '#B2DDFF',
300: '#84CAFF',
400: '#53B1FD',
500: '#2E90FA',
600: '#1570EF',
700: '#175CD3',
800: '#1849A9',
900: '#194185'
},
indigo: {
25: '#F5F8FF',
50: '#EEF4FF',
100: '#E0EAFF',
200: '#C7D7FE',
300: '#A4BCFD',
400: '#8098F9',
500: '#6172F3',
600: '#444CE7',
700: '#3538CD',
800: '#2D31A6',
900: '#2D3282'
},
violet: {
25: '#FCFAFF',
50: '#F9F5FF',
100: '#F4EBFF',
200: '#E9D7FE',
300: '#D6BBFB',
400: '#B692F6',
500: '#9E77ED',
600: '#7F56D9',
700: '#6941C6',
800: '#53389E',
900: '#42307D'
},
pink: {
25: '#FEF6FB',
50: '#FDF2FA',
100: '#FCE7F6',
200: '#FCCEEE',
300: '#FAA7E0',
400: '#F670C7',
500: '#EE46BC',
600: '#DD2590',
700: '#C11574',
800: '#9E165F',
900: '#851651'
},
rose: {
25: '#FFF5F6',
50: '#FFF1F3',
100: '#FFE4E8',
200: '#FECDD6',
300: '#FEA3B4',
400: '#FD6F8E',
500: '#F63D68',
600: '#E31B54',
700: '#C01048',
800: '#A11043',
900: '#89123E'
},
orange: {
25: '#FFFAF5',
50: '#FFF6ED',
100: '#FFEAD5',
200: '#FDDCAB',
300: '#FEB273',
400: '#FD853A',
500: '#FB6514',
600: '#EC4A0A',
700: '#C4320A',
800: '#9C2A10',
900: '#7E2410'
},
red: {
25: '#FFFBFA',
50: '#FEF3F2',
100: '#FEE4E2',
200: '#FECDCA',
300: '#FDA29B',
400: '#F97066',
500: '#F04438',
600: '#D92D20',
700: '#B42318',
800: '#912018',
900: '#7A271A',
text: '#FF642D'
},
yellow: {
25: '#FFFCF5',
50: '#FFFAEB',
100: '#FEF0C7',
200: '#FEDF89',
300: '#FEC84B',
400: '#FDB022',
500: '#F79009',
600: '#DC6803',
700: '#B54708',
800: '#93370D',
900: '#7A2E0E'
},
green: {
25: '#F6FEF9',
50: '#ECFDF3',
100: '#D1FADF',
200: '#A6F4C5',
300: '#6CE9A6',
400: '#32D583',
500: '#12B76A',
600: '#039855',
700: '#027A48',
800: '#05603A',
900: '#054F31'
},
black: {
100: '#000000',
200: '#000000A3',
300: '#00000029',
400: '#0000000F'
}
};

Build a product discovery chatbot with an AI room-visualization feature.
A customer chats about what they're looking for. The assistant recommends
products from a fixed catalog and renders them as cards. Each card has a
"See it in my room" button — the customer uploads a photo of their space
and gets back an image of that product placed in it.
=== STACK ===
React + Vite + Tailwind + shadcn/ui. Supabase for edge functions and secrets.
Both API keys live in Supabase secrets and are used ONLY inside edge functions.
Never expose ANTHROPIC_API_KEY or KIE_API_KEY to the browser. No API calls
from client code.
Secrets to create: ANTHROPIC_API_KEY, KIE_API_KEY
=== DATA ===
I'm uploading two JSON files. Place them exactly as follows:

1. catalog-slim.json → supabase/functions/_shared/catalog-slim.json
   Array of { id, n, c, p, col, d, v }. Goes into the LLM system prompt.
2. catalog-full.json → src/data/catalog-full.json
   Object keyed by product id. Fields: id, name, price, mrp, url, images[],
   description, specs{}, dims_cm{w,d,h}, placement, in_stock.
   Used by the frontend to render cards, and imported by the visualize
   edge function to build the image prompt. Copy it to
   supabase/functions/_shared/catalog-full.json as well.
   === EDGE FUNCTION 1: /chat ===
   Input: { messages: [{role, content}] }
   Output: { text: string, productIds: string[] }
   Non-streaming. Use a typing indicator on the client instead — streaming adds
   failure modes I don't want for this build.
   Call the Anthropic Messages API:
   POST https://api.anthropic.com/v1/messages
   headers: x-api-key, anthropic-version: 2023-06-01, content-type
   model: "claude-haiku-4-5-20251001"
   max_tokens: 1024
   System prompt as an ARRAY of two blocks:
   Block 1 — the instructions below.
   Block 2 — the full contents of catalog-slim.json as a JSON string, with
   "cache_control": { "type": "ephemeral" } set on this block.
   Instruction block content:
   You are a friendly, knowledgeable shopping assistant for a home furnishing
   brand. You help customers find products from the catalog provided below.
   Rules:

- Only ever recommend products that appear in the catalog. Never invent a
  product, a price, or an id.
- Recommend 2 to 4 products at a time. Never more than 4.
- When you recommend products, end your message with a line in exactly
  this format, on its own line, as the very last line:
  [PRODUCTS: id1, id2, id3]
  Use the exact id values from the catalog. If you are not recommending
  anything specific, omit this line entirely.
- Do not describe the products in list form in your text — the customer
  sees rich cards. Write 2-3 conversational sentences about why these
  suit what they asked for, then the marker line.
- Ask a clarifying question when the request is too vague to search on,
  e.g. no room, no style, no budget signal.
- Keep replies short. Three sentences is usually right.
- If nothing in the catalog fits, say so plainly and suggest the closest
  alternative category.
  Server-side post-processing, in this order:

1. Parse the [PRODUCTS: ...] line out of the response text.
2. Strip that line from the text before returning it.
3. Validate every extracted id against the keys of catalog-full.json.
   Silently drop any id that doesn't exist. This is the hallucination
   guard — do not skip it.
4. Cap at 4 ids.
5. Return { text, productIds }.
   === EDGE FUNCTION 2: /visualize ===
   Input: { productId: string, roomImageBase64: string }
   Output: { imageUrl: string }
   Steps:
6. Look up the product in catalog-full.json. 404 if missing.
7. Build the image prompt (exact logic below).
8. Call kie.ai gpt-image — see the KIE INTEGRATION note.
9. Return the resulting image URL.
   Prompt builder — construct this string from the product record:
   "Place this exact {name} into the uploaded room photograph.
   The product is {col-or-specs.material description}.
   {If dims_cm present: 'It measures approximately {w}cm wide, {d}cm deep
   and {h}cm tall — scale it accurately against the room.'}
   {placement clause, from the placement field:
   floor → 'Position it standing on the floor.'
   wall → 'Mount it on a wall.'
   tabletop → 'Place it on a table or surface.'
   ceiling → 'Suspend it from the ceiling.'
   rug → 'Lay it flat on the floor.'
   null → omit}
   Match the perspective, lighting direction and colour temperature of the
   room. Cast a natural, soft shadow consistent with the existing light.
   Preserve the room's walls, flooring, windows and existing furniture
   exactly as they are. Photorealistic, natural, as if photographed in place."
   Omit any clause whose source field is null. Never substitute a placeholder.
   === KIE INTEGRATION — READ THIS ===
   Isolate the entire kie.ai HTTP call in a single function named
   `callKieImageEdit(roomImageBase64, productImageUrl, prompt)` in its own
   file, with the endpoint URL, request body shape, and response parsing all
   in that one place and clearly commented. I will paste the exact kie API
   spec and replace the body of this function myself — do not spend effort
   guessing the payload format.
   Assume it is asynchronous: submit a task, receive a task id, poll for
   completion. Implement it that way with a 90-second timeout and a 3-second
   poll interval, and surface a clear error if it times out.
   The product's reference image is catalog-full[productId].images[0].
   === CACHING ===
   Before calling kie, compute sha256(productId + roomImageBase64) and check a
   Supabase table `visualizations` (columns: hash text primary key, product_id
   text, image_url text, created_at timestamptz). If a row exists, return the
   stored URL immediately. Otherwise call kie and insert the result.
   This matters — I'll be re-running the same demo path repeatedly and need
   repeats to be instant.
   === FRONTEND ===
   Single page. Centred column, max-width 780px.
   Header: brand name, one-line tagline. Minimal.
   Empty state: a short welcome line and three clickable seed prompts:
   "Show me chairs for a small living room"
   "I need something to brighten up a dark corner"
   "What works with a wooden dining table?"
   Clicking one sends it as a message.
   Chat: standard message list. User messages right-aligned in a subtle tinted
   bubble. Assistant messages left-aligned on plain background, no bubble.
   Typing indicator (three animated dots) while waiting.
   Product cards: when a message has productIds, render a horizontally
   scrollable strip of cards below that message. Each card, ~200px wide:

- product image (images[0]), 4:3, object-cover, rounded top
- name, two lines max with ellipsis
- price, formatted with Indian comma grouping and a ₹ prefix
- strikethrough mrp beside it when mrp > price
- a "See it in my room" button, shown only when the product's slim
  record has v === 1
- clicking the card body opens `url` in a new tab
  Visualize modal: opens on button click.
- shows the selected product thumbnail and name at the top
- a drag-or-click file upload zone (accept image/*, max 10MB)
- client-side: resize the uploaded image so its longest edge is 1024px
  using a canvas, encode as JPEG quality 0.85, then base64. Do this
  BEFORE sending — do not upload full-resolution phone photos.
- preview the uploaded room photo
- "Generate" button → calls /visualize
- while generating: a skeleton placeholder plus rotating status text
  ("Reading your room...", "Matching the lighting...", "Almost there...")
  changing every 6 seconds. It takes 20-40 seconds, the wait needs to
  feel intentional.
- on success: show the result full-width with a Download button and a
  "Try another photo" button
- on error: friendly message plus a Retry button. Never show a raw
  error string or stack trace to the user.
  === DESIGN ===
  Light theme only. White and near-white backgrounds, dark high-contrast text.
  Never a dark theme. Clean, generous whitespace, minimal borders, subtle
  rounded corners. Restrained — this is a premium home brand, not a SaaS
  dashboard. No gradients, no heavy shadows, no emoji anywhere in the UI.
  Must look correct on mobile.
  === ERROR HANDLING ===
- Every edge function wrapped in try/catch, returning a clean JSON error.
- Client shows human-readable messages, never raw errors.
- If /chat fails: "Something went wrong — try that again?" with a retry.
- Disable the send button while a request is in flight.
- Keep the last 12 messages in the conversation history sent to the API,
  not the whole thread.
  === DO NOT BUILD ===
  No auth, no user accounts, no database beyond the visualizations table,
  no cart or checkout, no search or filter UI, no admin panel, no analytics,
  no message persistence across page reloads, no streaming. Keep it tight.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://comfortel.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/591217a1-1719-43fe-95b9-98f3fcbaeaad).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
