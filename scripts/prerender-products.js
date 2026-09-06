// Runs after `vite build`. The SPA has exactly one URL, so no matter how
// good the JS-injected meta tags are, Google indexes every product as the
// same homepage result and social crawlers (which don't execute JS at all)
// show the same generic preview for every shared product link.
//
// This writes a real static file per published product — dist/products/<slug>/index.html
// — cloned from the built index.html with per-product <title>/meta/OG/JSON-LD
// baked into the HTML itself. The file still boots the exact same SPA bundle,
// which (see matchProductFromPath in src/main.js) detects the URL on load and
// opens that product's card for any human visitor.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIST = path.join(ROOT, 'dist')
const SITE_URL = 'https://bodega.theinvisiblepanchos.com'
const MAX_DESCRIPTION_LENGTH = 400 // mirrors src/main.js

// Node doesn't auto-load .env the way Vite does — read it directly for local
// builds. Netlify's build environment already has these set as real env
// vars (see netlify.toml's SECRETS_SCAN_OMIT_KEYS), so process.env wins there.
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] === undefined) {
      process.env[key] = rawValue.replace(/^["']|["']$/g, '')
    }
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

async function main() {
  loadDotEnv()

  const supabaseUrl = process.env.VITE_SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('prerender-products: missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — skipping.')
    return
  }

  const templatePath = path.join(DIST, 'index.html')
  if (!existsSync(templatePath)) {
    console.error('prerender-products: dist/index.html not found — run `vite build` first.')
    process.exitCode = 1
    return
  }
  const template = readFileSync(templatePath, 'utf8')

  const res = await fetch(
    `${supabaseUrl}/rest/v1/products?select=slug,title,description,cover_art_url,price_cents,coming_soon,inventory_count&published=eq.true&slug=not.is.null`,
    { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` } }
  )
  if (!res.ok) {
    console.error('prerender-products: failed to fetch products —', res.status, await res.text())
    process.exitCode = 1
    return
  }
  const products = await res.json()

  let written = 0
  for (const p of products) {
    if (!p.slug) continue

    const title = `${p.title} | Panchos Bodega`
    const description = (p.description || '').slice(0, MAX_DESCRIPTION_LENGTH) ||
      'Official apparel, unreleased tracks, and digital downloads from The Invisible Panchos.'
    const image = p.cover_art_url || `${SITE_URL}/opensign.jpg`
    const url = `${SITE_URL}/products/${p.slug}/`

    const availability = p.coming_soon
      ? 'https://schema.org/PreOrder'
      : (p.inventory_count != null && p.inventory_count <= 0)
        ? 'https://schema.org/OutOfStock'
        : 'https://schema.org/InStock'

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.title,
      description,
      image,
      offers: {
        '@type': 'Offer',
        price: ((p.price_cents || 0) / 100).toFixed(2),
        priceCurrency: 'USD',
        availability,
        url,
      },
    })

    let html = template
      .replace(
        '<title>Panchos Bodega | The Invisible Panchos</title>',
        `<title>${escapeHtml(title)}</title>`
      )
      .replace(
        /<meta name="description" content="[^"]*" \/>/,
        `<meta name="description" content="${escapeHtml(description)}" />`
      )
      .replace(
        /<link rel="canonical" href="[^"]*" \/>/,
        `<link rel="canonical" href="${url}" />`
      )
      .replace(
        /<meta property="og:url" content="[^"]*" \/>/,
        `<meta property="og:url" content="${url}" />`
      )
      .replace(
        /<meta property="og:title" content="[^"]*" \/>/,
        `<meta property="og:title" content="${escapeHtml(title)}" />`
      )
      .replace(
        /<meta property="og:description" content="[^"]*" \/>/,
        `<meta property="og:description" content="${escapeHtml(description)}" />`
      )
      .replace(
        /<meta property="og:image" content="[^"]*" \/>/,
        `<meta property="og:image" content="${image}" />`
      )
      .replace(
        /<meta name="twitter:title" content="[^"]*" \/>/,
        `<meta name="twitter:title" content="${escapeHtml(title)}" />`
      )
      .replace(
        /<meta name="twitter:description" content="[^"]*" \/>/,
        `<meta name="twitter:description" content="${escapeHtml(description)}" />`
      )
      .replace(
        /<meta name="twitter:image" content="[^"]*" \/>/,
        `<meta name="twitter:image" content="${image}" />`
      )
      .replace(
        '</head>',
        `  <script type="application/ld+json">${jsonLd}</script>\n  </head>`
      )

    const outDir = path.join(DIST, 'products', p.slug)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), html)
    written++
  }

  console.log(`prerender-products: wrote ${written} product page(s).`)
}

main().catch((err) => {
  console.error('prerender-products failed:', err)
  process.exitCode = 1
})
