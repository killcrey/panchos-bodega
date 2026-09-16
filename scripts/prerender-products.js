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

// og:image:width/height aren't required, but omitting them makes some
// crawlers (Pinterest, LinkedIn, older Facebook scrapes) fetch and decode
// the full image themselves before deciding whether/how to render a
// preview — a step that can silently fail or time out. Hand-parses the
// three formats actually used in this bucket (PNG/JPEG/WebP, including
// WebP's VP8/VP8L/VP8X variants) straight from the real file bytes rather
// than trusting anything embedded (a JPEG's EXIF thumbnail can carry a
// completely different width/height than the actual image — verified
// against a real product photo where EXIF said 1024x1024 and the real
// image was 2167x2167). Returns null on anything unrecognized/truncated;
// callers just omit the extra tags rather than failing the whole build.
function getImageDimensions(buf) {
  // PNG: signature (8 bytes) + IHDR chunk (length(4) + "IHDR" + width(4 BE) + height(4 BE)).
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // JPEG: SOI (0xFFD8) then segments; find a SOFn marker (0xC0-0xCF, excluding
  // 0xC4/0xC8/0xCC, which are DHT/JPG/DAC, not start-of-frame).
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue }
      const marker = buf[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2
        continue
      }
      const segmentLength = buf.readUInt16BE(offset + 2)
      const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
      }
      offset += 2 + segmentLength
    }
    return null
  }

  // WebP: "RIFF" + size(4) + "WEBP" + chunk ("VP8 " lossy / "VP8L" lossless / "VP8X" extended).
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16))
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      return { width, height }
    }
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return {
        width: (buf[26] | (buf[27] << 8)) & 0x3fff,
        height: (buf[28] | (buf[29] << 8)) & 0x3fff,
      }
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      }
    }
  }

  return null
}

async function fetchImageMeta(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    const dims = getImageDimensions(buf)
    return dims ? { ...dims, type: contentType } : null
  } catch {
    return null
  }
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
  const sitemapUrls = [SITE_URL + '/']
  for (const p of products) {
    if (!p.slug) continue

    const title = `${p.title} | Panchos Bodega`
    const description = (p.description || '').slice(0, MAX_DESCRIPTION_LENGTH) ||
      'Official apparel, unreleased tracks, and digital downloads from The Invisible Panchos.'
    const image = p.cover_art_url || `${SITE_URL}/opensign.jpg`
    const url = `${SITE_URL}/products/${p.slug}/`

    const imageMeta = await fetchImageMeta(image)

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
        /<meta property="og:image:width" content="[^"]*" \/>/,
        imageMeta ? `<meta property="og:image:width" content="${imageMeta.width}" />` : ''
      )
      .replace(
        /<meta property="og:image:height" content="[^"]*" \/>/,
        imageMeta ? `<meta property="og:image:height" content="${imageMeta.height}" />` : ''
      )
      .replace(
        /<meta property="og:image:type" content="[^"]*" \/>/,
        imageMeta?.type ? `<meta property="og:image:type" content="${escapeHtml(imageMeta.type)}" />` : ''
      )
      .replace(
        /<meta property="og:image:alt" content="[^"]*" \/>/,
        `<meta property="og:image:alt" content="${escapeHtml(p.title)}" />`
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
        /<meta name="twitter:image:alt" content="[^"]*" \/>/,
        `<meta name="twitter:image:alt" content="${escapeHtml(p.title)}" />`
      )
      .replace(
        '</head>',
        `  <script type="application/ld+json">${jsonLd}</script>\n  </head>`
      )

    const outDir = path.join(DIST, 'products', p.slug)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(path.join(outDir, 'index.html'), html)
    sitemapUrls.push(url)
    written++
  }

  // robots.txt already points at /sitemap.xml (see public/robots.txt) —
  // this is what makes that reference actually resolve to something.
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    sitemapUrls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>\n`
  writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap)

  console.log(`prerender-products: wrote ${written} product page(s) and sitemap.xml.`)
}

main().catch((err) => {
  console.error('prerender-products failed:', err)
  process.exitCode = 1
})
