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
scripts/prerender-products.js   build-time per-product static pages + sitemap (see SEO note below)
scripts/audit/             live-site audit (HTTP + real-browser); `node scripts/audit/audit.mjs` — see Known Quirks
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

## Known Quirks & Critical Context (INDEX ONLY)
Full write-ups live in `docs/NOTES-ARCHIVE.md` (not auto-loaded). Before changing an area below, `grep -n -i "<keyword>" docs/NOTES-ARCHIVE.md` and read the matching entry. Add NEW incident/change notes to the archive, not to this file.

- Landing page slots
- Tips are the one client-chosen amount
- `?filter=<category>` deep link
- Per-product SEO + a real dedicated product page
- Printful two-ID system
- Printful categories split into `printful-apparel`/`printful-picks`, not one bare `printful`
- The "← Back to the Bodega" button had its own separate category→filter mapping, and it was still wrong after the Printful split
- Admin file-picker previews go above their `<input>`, not below
- Checkout ID vs. price
- Oversized apparel surcharge
- Payment Links are opt-in, normally skipped
- No customer-facing "Printful" branding
- Digital tax codes
- One shared Resend Audience ("The Invisible Panchos", live id set as `RESEND_AUDIENCE_ID`), fed three ways
- Buyers audience, separate from the shared list
- Tippers audience, a third and separate Audience from Buyers
- Unsubscribe: a self-hosted endpoint, because Resend doesn't provide one
- `checkout.session.completed` alone isn't proof of payment
- `audio-vault` is a private bucket — `get-playback-url` is how anything in it ever gets played
- Mixed-cart shipping
- Digital-file bundles can mix audio with non-audio files
- Description hard cap
- Edit form shows what's actually attached, not a vague count (2026-09-11 incident)
- Lightbox z-index
- Product card bottom layout
- `.update()` under RLS lies by omission
- Admin-editable email notes
- Services are `products` with `category = 'services'`, not a separate system
- Pricing Mode (`products.pricing_mode`), available on every product regardless of category
- `.env` was tracked in git — never actually a credential leak, but fixed anyway (2026-09-17, in response to a GitGuardian alert)
- Social-card image reliability audit (2026-09-15)
- Inventory list is grouped by category (2026-09-14)
- Admin dashboard is tabbed, not columned
- Storage egress cleanup (2026-09-10)
- Cached Egress quota exceeded again (2026-10-06) — product photos were the cause, not the already-fixed background/PNG leftovers
- Full live-site audit: `node scripts/audit/audit.mjs` (built 2026-10-06 after customers were lost to a checkout bug — run it after every deploy and aft...
- Look Book — one shared scrolling photo strip on the Featured page, max 4 photos, oldest auto-dropped (2026-10-06)
- Photo trim #2 + site-chrome images right-sized + sling bag set to Sold Out (2026-10-22)
- Featured carousel order is now admin-controlled (2026-10-31)
- Album preview only ever played track 1 (2026-10-31, reported on the real "Memories Of Home" upload)
- Paid downloads: albums are now ONE .zip, and the files delivered come from the product row, not Stripe's copy (2026-10-31, reported after the user bou...
- Customer emails now carry the logo and the product photo (2026-10-31, on request)
- Product photo count is already unbounded, not capped at 3
- Contact link intentionally still uses `mailto:` (known to fail silently without a configured mail client) — left as-is per explicit decision, not an o...
- The Vite scaffold leftovers (`src/counter.js`, `src/assets/{javascript,vite}.svg`, `hero.png`) were deleted 2026-11-05; nothing referenced them (build...
- 30-second play counter + unique listeners (2026-11-03)

### Recent changes (2026-11) — titles only; details in the archive

- "Please wait" note on the zip download (2026-11-01)
- Player redesigned as a phone-style streaming player (2026-11-01, on request: "look more like a player users are used to")
- Sharing a song: per-track links, share sheet, Stories image (2026-11-02, on request — the release is website-only until DSPs on 12/1/26 and free full ...
- Song credit lines say "from the soundtrack <album>" (2026-11-02, follow-up to the sharing bullet above)
- The Enter gate is skipped for any `/products/<slug>/...` URL (2026-11-02)
- Stories image copies the song link for the Link sticker (2026-11-02)
- VIP folder: a private, self-closing page behind an NFC keychain (2026-11-02, deployed)
- OPEN SECURITY ISSUE — public signup is enabled on the live Supabase project (found 2026-11-02, not yet fixed)
- VIP folder for LAYERS, and a real album order for it (2026-11-04)
- LAYERS track 8 renamed "WATER EVERYTHING" (2026-11-04, on request, matching the tracklist artwork)
- LAYERS featured artists added to two titles (2026-11-04, on request, same "ft" format as Memories Of Home's titles)
- Memories Of Home titles now follow the tracklist artwork (2026-11-05, on request)
- Album cover + tracklist files in paid downloads are right-sized (2026-11-05, on request)
- Admin edit form hid an album's cover/tracklist and would have dropped them on save (2026-11-05, fixed)
- VIP: tracklist always delivered, "Link closes" above the button, editable close date (2026-11-05, on request)
- Memories Of Home VIP now shows only "Cover" and "Tracklist" (2026-11-05, on request)
- Storage cleanup, 2026-11-05 — done (on request)
- VIP links: editable title + the title on the link-preview card (2026-11-07, on request)
- Admin on a phone: a menu of sections instead of the cramped tab strip (2026-11-07, on request)
- VIP link action buttons: 2x2 grid on phones (2026-11-07, on request)
- Memories Of Home track 11 credit is now "(feat 2Mex & 60 East)" (2026-11-11, on request; its link slug changed)
- Memories tracklist artwork says "(FEAT 60 EAST & 2MEX)" while track 11 is "(feat 2Mex & 60 East)" — LEAVE ALONE, do not flag (2026-11-11, user decision)
- Memories Of Home track 11 file had no embedded cover art; added (2026-11-11, on request)

## Issues log
- **RESOLVED (verified live 2026-11-07: disable_signup=true) — public signup was enabled on the live Supabase project (found 2026-11-02)**: a read-only `GET <project>/auth/v1/settings` with the anon key returned `disable_signup: false` (`mailer_autoconfirm: false`, so a confirmed email is required, but anyone with an email address can get one). Every admin table here (orders, tips, email_captures, service_inquiries, lookbook_photos, products writes, …) is guarded only by RLS policies `to authenticated using (true)` — "any logged-in user", which assumed nobody but the owner could ever log in. Not tested by creating an account (that would be a write to the real project), but by design any self-signed-up user can read orders/customer addresses/email captures and edit products/photos. **Fix = turn off "Allow new users to sign up" in the Supabase dashboard (Authentication → Sign In / Providers); it needs the project owner, existing logins keep working. Backstop worth adding after: scope the policies to the admin's email.** Once done, correct this bullet. The new `vip_links` table is additionally locked down by column grants (`insert (label, note)`, `update (revoked)`, no delete — see its migration), so even a rogue login could not pick a token/expiry/product on it.

## AI Interaction Directives
- Never rewrite an entire file for a small change — targeted edits only.
- No filler, no apologies, no restating the request before acting. Prioritize token efficiency.
- Do not explore the codebase beyond files relevant to the requested change unless told to.
- No speculative refactors, abstractions, or "while I'm here" cleanup outside requested scope.
- Verify UI/behavioral changes live (dev server + browser) before reporting done — this project has no test suite to lean on instead.
- Before proposing a fix, check whether the bug reproduces at the actual failure point (viewport size, stale data, prod vs. dev) rather than assuming it reproduces wherever it's easiest to test.
- Treat this file as authoritative; update it the moment an instruction here goes stale — don't silently diverge from it.
- Keep this file short: it loads every session. Put change logs and incident details in `docs/NOTES-ARCHIVE.md`.
