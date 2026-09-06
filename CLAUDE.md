# CLAUDE.md

## Project Overview
"Panchos Bodega" — e-commerce storefront for The Invisible Panchos (band/brand). Single cart sells three product types: physical apparel (self-fulfilled via Shippo, or print-on-demand via Printful), digital downloads (music/art, signed download links), and free ($0, email-gated) downloads. One hidden admin panel (`?mode=admin`) handles product CRUD, inventory, and fulfillment. No test suite.

## Tech Stack & Architecture
- **Frontend**: Vanilla JS (ES modules), Vite `^8.0.12`. Single-page `index.html`; storefront vs. admin is DOM show/hide, no router, no framework.
- **Backend**: Supabase — Postgres (RLS-locked), Deno Edge Functions (`supabase/functions/*`), Storage (`bodega-images`, `audio-vault` buckets).
- **Payments**: `@stripe/stripe-js ^9.14.0`. Stripe Checkout Sessions with dynamic `price_data` — no persisted Stripe Prices; price is always read live from `products.price_cents`. Stripe Address Element (shipping) backed by Google Maps Platform autocomplete.
- **Shipping**: Shippo API (self-fulfilled) + Printful API (print-on-demand), rates fetched in parallel and summed into one Stripe shipping line. A cart can mix both.
- **DB client**: `@supabase/supabase-js ^2.108.2`.
- **Styling**: Plain CSS (`src/style.css` + inline `<style>`/`style=""` in `index.html`). No preprocessor, no utility framework.
- **Hosting**: Netlify (static `dist/`), auto-deploys `main`. Edge Functions deploy independently via Supabase CLI.

## Directory Structure
```
index.html                 storefront + admin markup (single file, ~1900 lines)
success.html / success.js  post-checkout confirmation + digital download page
src/
  main.js                  admin logic + storefront rendering + checkout entry (~1050 lines)
  cart.js                  cart state, localStorage, mixed-cart shipping resolution
  style.css                global styles
  counter.js, assets/javascript.svg, assets/vite.svg   unused Vite template leftovers — ignore
public/                    static passthrough (favicon, sprite icons, enter-overlay image)
supabase/
  functions/               one dir per Deno Edge Function (index.ts + deno.json)
    create-checkout-session    builds Stripe session; re-validates price/shipping/inventory
    create-stripe-link         admin "Generate" — bare Stripe Product (+Price/Payment Link unless skipPaymentLink)
    get-shipping-rates         combined Shippo + Printful rate quoting
    purchase-shipping-label    buys Shippo label post-payment
    stripe-webhook             order creation, email receipt, Printful order submission, inventory decrement
    secure-download / free-download   signed digital-file delivery (paid / $0)
  migrations/               chronological, timestamp-prefixed; several are throwaway debug/test-data probes (kept for history, not reverted)
  config.toml
netlify.toml                build command + secrets-scanner opt-outs for VITE_ public keys
.env                        VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (local dev; anon key only, RLS-protected)
```

## Core Commands
```bash
npm install                              # install deps
npm run dev                              # Vite dev server, localhost:5173
npm run build                            # -> dist/
npm run preview                          # serve production build locally
npx supabase functions deploy <name>     # deploy one edge function
npx supabase db push                     # apply pending migrations
```
No test/lint command exists.

## Coding Standards & Conventions
- **Naming**: kebab-case HTML element IDs, camelCase JS vars/functions, snake_case Postgres columns/JSON metadata keys.
- **State management**: none framework-level. Admin form state lives in module-level `let`s in `main.js`, reset explicitly on modal open/close/submit. Cart state lives in `cart.js`, persisted to `localStorage`.
- **Styling**: class-based CSS in `style.css` for reusable patterns; ad hoc inline `style=""` for one-off admin UI — an accepted convention here, not something to "fix" on sight.
- **Data fetching**: `supabase.functions.invoke(name, { body })` for all edge function calls. Edge functions always re-validate price/inventory/shipping server-side — never trust client-sent amounts. Client table reads use the anon key + RLS; writes to `products`/`orders` happen only inside edge functions (service role key).
- **File input gotcha**: `<input type="file" multiple>` replaces (doesn't append to) its FileList on each reopen — accumulate selections in a JS array, reset `input.value = ''` after each `change`. See `uploadNewImageFiles`/`uploadNewDigitalFiles` in `main.js`.
- **Render-time self-healing**: prefer deriving display state from source data at render time over relying on write-time bookkeeping alone (e.g. the product card derives its audio player from `download_files` if `tracklist_snippets` is empty, and clamps `description` to `MAX_DESCRIPTION_LENGTH` regardless of what's stored). This means old rows fixed by a logic change don't need a data migration or a re-save through the admin UI.

## Deployment Protocol
- Frontend: Netlify, auto-deploys `main`. Build = `npm run build`, publish = `dist`.
- `netlify.toml` disables `SECRETS_SCAN_SMART_DETECTION_ENABLED` — every `VITE_`-prefixed key is intentionally inlined into the client bundle; never give a genuinely secret key (e.g. `service_role`) a `VITE_` prefix.
- Edge functions: not part of the Netlify build — `npx supabase functions deploy <name>` per function after any `supabase/functions/**` change. Docker warning on deploy is expected/harmless.
- Migrations: `npx supabase db push`.
- **Standing permission**: push to `origin/main` without asking first, in this repo. Still confirm before force-push, history rewrites, or destructive DB ops.

## Known Quirks & Critical Context
- **Landing page slots**: `products.landing_slot` drives the page shown right after the Enter gate — `featured` (carousel, up to 3), `latest_release`, `pancho_pick`, or null. The two single-occupancy slots are enforced by a partial unique index, so `resolveLandingSlot` in `main.js` demotes the previous holder before saving rather than letting the insert fail; the 3-featured cap can't be expressed in the DB and is checked there too. The landing page is a DOM section (`#landing-view`), not a route — `showLanding()`/`showStore(filter)` toggle it against `#store-grid`, and `applyFilter` is module-scoped so landing boxes can jump straight into a category. If no product holds any slot, `showLanding()` falls through to the store so visitors never hit an empty page.
- **Tips are the one client-chosen amount**: every product price is re-read from `products.price_cents` server-side, but a tip has nothing to validate against — `create-tip-session` defends with hard bounds only ($1–$500, `MIN_TIP_CENTS`/`MAX_TIP_CENTS`). Tip sessions carry `metadata.tip = 'true'`, which `stripe-webhook` branches on *before* the line-item loop, because that loop calls `decrement_inventory` on every line item and a tip's ad-hoc Stripe product must never reach it. Tips are nontaxable (`txcd_00000000`, `automatic_tax` off) — a gratuity isn't a sale of goods. They live in their own `tips` table (not `orders`, which is all shipping/fulfillment columns a tip never uses) and `success.html` short-circuits on `?tip=1` before calling `secure-download`, which would otherwise error on a tip that has no files.
- **Per-product SEO + a real dedicated product page**: `products.slug` (unique, admin-editable, autofilled from title until touched — `wireSlugAutofill` in `main.js`) backs two things. (1) A static file per product at `dist/products/<slug>/index.html`, written by `scripts/prerender-products.js` as an extra `npm run build` step — a clone of the built `index.html` with title/meta description/canonical/OG/Twitter tags and a per-product JSON-LD `Product` block rewritten in, plus `dist/sitemap.xml` (homepage + every product), which is what makes the `Sitemap:` line in `public/robots.txt` resolve to something. This is what non-JS crawlers (Google, social link previews) see. (2) A real in-app product page for humans: `showProductPage` (`main.js`) swaps `#landing-view`/`#store-grid` for `#product-view`, rendering the full untruncated product via `renderProductMarkup`/`wireProductInteractions` — the exact same functions that build a grid card, just called with different options: the card passes `linkTitle: true, truncateDescription: true, showBuyControls: false, showDescription: false, showFullGallery: false`, the page passes the inverse of all five. A card is deliberately info-only — first photo, title, price, category, and sizes as plain tags — with no description, no multi-photo arrows/counter (the lightbox still gets every photo when the single visible one is clicked), no size *picker*, and no buy/free-download button; all of that only exists on the dedicated page. `renderProductMarkup`'s own trailing flex spacer (`margin-top: auto`, meant to push a player/buy-button to the bottom) is only emitted when there's actually something after it to push — otherwise a now-mostly-empty card would carry dead reserved space for controls it isn't rendering. `goToProduct` (landing carousel/side-box clicks, and the initial `/products/<slug>/` route match via `matchProductFromPath`) and a card's title-link click both funnel through `showProductPage`. `updateProductUrlAndMeta` — called at the end of `showProductPage` — pushes the URL (no-op if already there) and swaps `document.title`/meta via `setProductMetaTags`. `showStore`/`showLanding` take a `{ skipHistoryUpdate }` option: by default (a real click — filter tab, footer logo, Shop Now, the product page's own Back button) they push `/` onto history if the visitor is currently on a product URL, so leaving a product always gets its own history entry; `skipHistoryUpdate: true` is used only for the initial page load and inside the `popstate` handler itself, where the browser has already moved history and pushing again would corrupt the stack mid-navigation. Without that push, two products visited back-to-back (grid → A → back to grid → B) pushed straight onto each other with no grid entry between them, so one Back press from B landed on A instead of the grid — this is what fixed it. A `popstate` listener re-derives the correct view (product page or landing) on Back/Forward, but still doesn't attempt full history fidelity — it won't restore whatever category filter was active before a product was opened, only that a product URL resolves to that product's page and everything else resolves to landing.
- **Printful two-ID system**: every Printful variant needs both a catalog `variant_id` (`/shipping/rates`) and a `sync_variant_id` (`/orders`) — stored together in `products.printful_variant_map` as `{[size]: {variantId, syncVariantId}}`.
- **Checkout ID vs. price**: `stripe_product_id` only identifies the Stripe Product. Price is always read live from `products.price_cents` via `price_data` — changing price never requires regenerating the Checkout ID.
- **Oversized apparel surcharge**: sizes are free-text per product (no fixed dropdown) — admins can type any label. Selecting 2XL/3XL/4XL/5XL (or their XXL…XXXXXL spellings) adds a flat `SIZE_UPCHARGE_CENTS` ($4) to the base price, applied client-side in `cart.js`'s `addToCart` and re-derived independently server-side in `create-checkout-session` from `item.size` — never trusted from the client cart snapshot. Applies to every fulfillment path (self-shipped and Printful alike), since it keys off the size string, not the fulfillment method. `UPCHARGE_SIZES` is duplicated in both files — keep the two lists in sync. The surcharge is currently uniform; Printful's own per-size cost is not uniform, so if it's ever made per-size, `SIZE_UPCHARGE_CENTS` becomes a per-size map in both places and the storefront hint in `main.js` needs to stop assuming one amount.
- **Payment Links are opt-in, normally skipped**: `create-stripe-link` auto-sets `skipPaymentLink=true` when Printful IDs are filled. Static Payment Links never attach a shipping charge and are never handed to customers.
- **No customer-facing "Printful" branding**: shipping labels are genericized ("Standard Shipping").
- **Digital tax codes**: products with no `weight_oz` and no Printful mapping get a Stripe Tax digital-goods code (`txcd_...`); physical items default to tangible-goods tax.
- **Mixed-cart shipping**: composite rate IDs join up to two components with `::` (`shippoRateId::printfulRateId`, `printful::rateId`, or a plain Shippo ID) — always re-parsed/re-validated server-side in `create-checkout-session`, never trusted from the client.
- **Digital-file bundles can mix audio with non-audio files** (cover art, tracklist images uploaded alongside tracks). `processDigitalFiles` derives the tracklist from whichever files are actually audio, not from an "every file must be audio" check — and the card render path independently re-derives playable tracks from `download_files`, so a bundle saved before this logic existed still gets a player without a re-upload.
- **Description hard cap**: `MAX_DESCRIPTION_LENGTH` in `main.js` (currently 400) must match the `maxlength` on `#upload-description`/`#edit-description` in `index.html`. Enforced at save time (form) and on the grid card (`renderProductMarkup` called with `truncateDescription: true`) — the dedicated product page deliberately passes `truncateDescription: false` and shows the full text, since the cap exists for a small tile, not a page with room for it.
- **Lightbox z-index**: `#lb-close` must keep an explicit `z-index` — the image row is `position: relative; width: 100%`, and on any viewport ≤900px wide its edge lines up with the close button; without an explicit z-index, DOM-order stacking makes the row swallow the click.
- **Product card bottom layout**: the flex-grow spacer sits *before* the audio player (not on the Buy Now button) so leftover vertical space collects above the player, not between the player and Buy Now.
- Contact link intentionally still uses `mailto:` (known to fail silently without a configured mail client) — left as-is per explicit decision, not an oversight.
- `src/counter.js` and `src/assets/{javascript,vite}.svg` are unused Vite scaffold leftovers — not wired into anything, safe to ignore.

## AI Interaction Directives
- Never rewrite an entire file for a small change — targeted edits only.
- No filler, no apologies, no restating the request before acting. Prioritize token efficiency.
- Do not explore the codebase beyond files relevant to the requested change unless told to.
- No speculative refactors, abstractions, or "while I'm here" cleanup outside requested scope.
- Verify UI/behavioral changes live (dev server + browser) before reporting done — this project has no test suite to lean on instead.
- Before proposing a fix, check whether the bug reproduces at the actual failure point (viewport size, stale data, prod vs. dev) rather than assuming it reproduces wherever it's easiest to test.
- Treat this file as authoritative; update it the moment an instruction here goes stale — don't silently diverge from it.
