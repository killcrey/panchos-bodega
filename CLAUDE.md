# CLAUDE.md

## Project Overview
"Panchos Bodega" — e-commerce storefront for The Invisible Panchos (band/brand). Sells three product types from one cart: physical apparel (self-fulfilled via Shippo, or print-on-demand via Printful), digital downloads (music/art, delivered via signed download links), and free downloads. Single admin panel manages inventory, orders, and fulfillment. No test suite exists.

## Tech Stack & Architecture
- **Frontend**: Vanilla JS (ES modules, no framework), Vite 8 bundler. Single-page `index.html` toggles between storefront and admin views by DOM show/hide (no router).
- **Backend**: Supabase — Postgres (RLS-locked tables) + Deno Edge Functions (`supabase/functions/*`) + Storage (product images, audio vault).
- **Payments**: Stripe Checkout Sessions, dynamic `price_data` line items (no persisted Stripe Prices — price is always read live from `products.price_cents`). Stripe Address Element for shipping address entry, using Google Maps Platform for autocomplete (Stripe's free autocomplete doesn't activate without a Payment Element/Link session).
- **Shipping**: Shippo API (self-fulfilled items, rates + label purchase) and Printful API (print-on-demand items, rates + order submission). A cart can mix both — rates are fetched in parallel and summed into one combined Stripe shipping line.
- **Styling**: Plain CSS in `src/style.css` + inline `<style>` in `index.html`. No preprocessor, no utility framework.
- **Hosting**: Netlify (static `dist/` build). Supabase Edge Functions deployed independently via Supabase CLI.

## Directory Structure
```
index.html              storefront + admin markup (single file, ~1700 lines)
src/
  main.js                admin panel logic + storefront product rendering + checkout entry (~1700 lines)
  cart.js                cart state, localStorage persistence, mixed-cart shipping resolution
  style.css               global styles
  counter.js               unused Vite template leftover
success.html              post-checkout confirmation/download page
supabase/
  functions/               Deno Edge Functions (one dir per function, index.ts + deno.json)
    create-checkout-session   builds Stripe Checkout session, re-validates price/shipping/inventory server-side
    create-stripe-link        admin "Generate Checkout ID" — creates bare Stripe Product (+ Price/Payment Link unless skipPaymentLink)
    get-shipping-rates        combined Shippo + Printful rate quoting
    purchase-shipping-label   buys the Shippo label after order payment
    stripe-webhook            payment confirmation: order creation, email receipt, Printful order submission
    secure-download           signed digital-file download (post-purchase)
    free-download             signed digital-file download ($0 products)
  migrations/                schema history, chronological, timestamp-prefixed
  config.toml
netlify.toml               build command, secrets-scanner opt-outs for VITE_ public keys
```

## Core Commands
```bash
npm install               # install deps
npm run dev                # local dev server (Vite, localhost:5173)
npm run build               # production build -> dist/
npm run preview              # serve the production build locally
npx supabase functions deploy <name>   # deploy one edge function
npx supabase db push          # apply pending migrations
```
No test command exists — there is no test suite.

## Coding Standards & Conventions
- **Naming**: kebab-case for HTML element IDs (`upload-generate-stripe-btn`), camelCase for JS variables/functions, snake_case for Postgres columns and JSON metadata keys.
- **State management**: no framework state. Admin form state (e.g. accumulated file selections) lives in module-level `let` variables in `main.js`, reset explicitly on modal open/close/submit. Cart state lives in `cart.js`, persisted to `localStorage`.
- **Styling**: class-based CSS in `style.css` for reusable patterns; inline `style=""` attributes are used ad hoc in `index.html` for one-off admin UI (accepted convention here, not an anti-pattern to "fix").
- **Data fetching**: `supabase.functions.invoke(name, { body })` for all edge function calls from the client. Edge functions always re-validate price, inventory, and shipping server-side against the DB — never trust client-sent amounts. Supabase table reads from the client go through the anon key + RLS; writes to `products`/`orders` happen only inside edge functions using the service role key.
- **Native file input gotcha**: `<input type="file" multiple>` replaces (not appends to) its FileList each time the picker reopens. Any multi-select file UI must accumulate selections in a JS array and reset `input.value = ''` after each `change` event — see `uploadNewImageFiles`/`uploadNewDigitalFiles` in `main.js` for the pattern.

## Deployment Protocol
- Frontend: Netlify, auto-deploys `main` branch. Build = `npm run build`, publish = `dist`.
- `netlify.toml` disables `SECRETS_SCAN_SMART_DETECTION_ENABLED` — required because every `VITE_`-prefixed key is intentionally inlined into the client bundle and otherwise fails Netlify's scanner as a false-positive leak. Never add a genuinely secret key (e.g. `service_role`) with a `VITE_` prefix.
- Edge functions: deployed independently, not part of the Netlify build — `npx supabase functions deploy <name>` per function after any `supabase/functions/**` change. Docker warning on deploy is expected/harmless (no local function testing is used).
- Migrations: `npx supabase db push` applies pending files in `supabase/migrations/`. Several historical migrations are throwaway debug/test-data probes (kept for history, not reverted).
- **Standing permission**: push to `origin/main` without asking first, in this repo.

## Known Quirks & Critical Context
- **Printful two-ID system**: every Printful-fulfilled variant needs both a catalog `variant_id` (required by `/shipping/rates`) and a `sync_variant_id` (required by `/orders`) — different numeric IDs for the same size, stored together in `products.printful_variant_map` as `{[size]: {variantId, syncVariantId}}`.
- **Checkout ID vs. price**: `stripe_product_id` (created via "Generate Checkout ID") only identifies the Stripe Product. Price is always read live from `products.price_cents` at checkout time via `price_data` — changing price never requires regenerating the Checkout ID.
- **Payment Links are opt-in and normally skipped**: `create-stripe-link` accepts `skipPaymentLink`, auto-set true when Printful IDs are filled in. When true, it creates only the bare Stripe Product and returns — no Price, no Payment Link, nothing else sent to Stripe. Static Payment Links are considered dead weight for physical/Printful items (they collect an address but never attach a shipping charge) and are never handed out to customers.
- **No customer-facing "Printful" branding**: shipping rate labels (rate picker + Stripe Checkout shipping line) are genericized ("Standard Shipping") — the fulfillment vendor is an internal implementation detail.
- **Digital tax codes**: products with no `weight_oz` and no Printful mapping are tagged with a category-specific Stripe Tax digital-goods code (`txcd_...`) so sales tax isn't charged on downloads; physical items default to general tangible goods.
- **Mixed-cart shipping**: composite rate IDs encode up to two components joined by `::` (`shippoRateId::printfulRateId`, `printful::rateId`, or a plain Shippo ID) — parsed and re-validated server-side in `create-checkout-session`, never trusted from the client.
- Contact link intentionally still uses `mailto:` (known to fail silently without a configured mail client) — left as-is per explicit decision, not an oversight.

## AI Interaction Directives
- Never rewrite an entire file for a small change — use targeted edits only.
- No filler, no apologies, no restating the request back before acting.
- Do not explore the codebase beyond the files relevant to the requested change unless told to.
- No speculative refactors, abstractions, or "while I'm here" cleanup outside the requested scope.
- Verify UI/behavioral changes live (dev server + browser) before reporting done — this project has no test suite to lean on instead.
- Treat this file as authoritative context; update it when an instruction here becomes stale or wrong, don't silently diverge from it.
