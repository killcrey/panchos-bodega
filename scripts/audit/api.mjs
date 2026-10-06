// Phase 1: everything that can be checked with plain HTTP — no browser.
import { createHash } from 'node:crypto'
import { check, pass, fail, warn, skip, section, http } from './lib.mjs'

const TEST_ADDRESS = { name: 'Audit Test', street1: '401 B St', street2: '', city: 'San Diego', state: 'CA', zip: '92101', country: 'US' }

export async function runApiAudit({ site, env, ctx }) {
  const SB = env.VITE_SUPABASE_URL
  const ANON = env.VITE_SUPABASE_ANON_KEY
  const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }
  const fnUrl = n => `${SB}/functions/v1/${n}`
  const call = async (name, body, extra = {}) => {
    const res = await http(fnUrl(name), { method: 'POST', headers: { ...H, Origin: site, ...extra }, body: JSON.stringify(body) })
    let json = null
    try { json = await res.json() } catch { /* not json */ }
    return { status: res.status, json }
  }
  ctx.call = call
  ctx.sessions = []

  // ---------------------------------------------------------------- bundle
  section('Production bundle & build config')
  const home = await http(site + '/')
  const homeHtml = await home.text()
  check('build', 'homepage returns 200', home.status === 200, `status ${home.status}`)
  const assets = [...new Set([...homeHtml.matchAll(/\/assets\/[^"']+\.js/g)].map(m => m[0]))]
  let bundle = ''
  for (const a of assets) bundle += await (await http(site + a)).text()
  check('build', 'JS bundle fetched', bundle.length > 50000, `${assets.length} file(s), ${bundle.length} bytes`)
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_STRIPE_PUBLISHABLE_KEY', 'VITE_GOOGLE_MAPS_API_KEY']) {
    const val = env[key]
    if (!val) { warn('build', `${key} present in production bundle`, 'no local value to compare against'); continue }
    check('build', `${key} present in production bundle (exact value)`, bundle.includes(val))
  }
  const secretPatterns = { 'Stripe secret key': /sk_live_[A-Za-z0-9]{10,}/, 'Stripe restricted key': /rk_live_[A-Za-z0-9]{10,}/, 'Stripe webhook secret': /whsec_[A-Za-z0-9]{10,}/, 'Resend key': /re_[A-Za-z0-9]{20,}/ }
  for (const [label, re] of Object.entries(secretPatterns)) check('security', `no ${label} in bundle`, !re.test(bundle))
  const jwts = [...bundle.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g)].map(m => m[0])
  const roles = jwts.map(j => { try { return JSON.parse(Buffer.from(j.split('.')[1], 'base64url').toString()).role } catch { return '?' } })
  check('security', 'no service_role JWT in bundle', !roles.includes('service_role'), `JWT roles found: ${roles.join(',') || 'none'}`)

  // -------------------------------------------------------------- products
  section('Catalog data (anon REST)')
  // Same explicit column list as the storefront (anon can no longer select * — see
  // migration 20261006220000_restrict_anon_product_columns.sql).
  const STOREFRONT_COLS = 'id,title,type,price_cents,cover_art_url,image_2_url,image_3_url,gallery_images,description,sizes,audio_preview_url,tracklist_snippets,download_files,category,published,coming_soon,inventory_count,weight_oz,domestic_shipping_cents,international_shipping_cents,printful_variant_map,landing_slot,slug,pricing_mode,offer_min_cents,offer_max_cents,created_at,feature_images'
  const pr = await http(`${SB}/rest/v1/products?select=${STOREFRONT_COLS}&published=eq.true`, { headers: H })
  const products = (await pr.json()) || []
  ctx.products = products
  check('data', 'published products load via anon key', pr.status === 200 && products.length > 0, `${products.length} products`)
  const isService = p => p.category === 'services'
  const isPhysical = p => (p.weight_oz != null && p.weight_oz > 0) || (p.printful_variant_map && Object.keys(p.printful_variant_map).length > 0)
  const hasFiles = p => !!(p.audio_preview_url || (Array.isArray(p.download_files) && p.download_files.length) || (Array.isArray(p.tracklist_snippets) && p.tracklist_snippets.length))
  const mode = p => p.pricing_mode || 'standard'
  const isFree = p => mode(p) === 'free' || (mode(p) === 'standard' && p.price_cents === 0 && !isService(p))
  ctx.isService = isService; ctx.isPhysical = isPhysical; ctx.isFree = isFree; ctx.mode = mode
  for (const p of products) {
    const label = `${p.slug || p.id}`
    if (!p.slug) warn('data', `${label}: has a slug`, 'no slug → no prerendered page / shareable link')
    if (!p.cover_art_url) warn('data', `${label}: has a cover photo`)
    if (isService(p) || p.coming_soon) continue
    if (isFree(p)) { check('data', `${label}: free product has a deliverable file`, hasFiles(p)); continue }
    if (mode(p) === 'offer_based' && !(p.offer_min_cents > 0)) fail('data', `${label}: offer-based product has min offer`, `offer_min_cents=${p.offer_min_cents}`)
    if ((p.category === 'apparel' || ['printful', 'printful-apparel', 'printful-picks'].includes(p.category)) && !isPhysical(p)) {
      fail('data', `${label}: apparel/Printful item has shipping set up`, 'no weight and no Printful IDs — it cannot ship; storefront now shows it as Unavailable. Add Printful IDs (or a weight) in the admin, or unpublish it')
      continue
    }
    if (isPhysical(p)) {
      const hasSizes = p.sizes || (p.printful_variant_map && Object.keys(p.printful_variant_map).some(k => k !== 'default'))
      // A Printful item with only the 'default' key is a legitimate one-size product (e.g. the sling bag).
      const printfulOnlyDefault = p.printful_variant_map && Object.keys(p.printful_variant_map).every(k => k === 'default')
      if ((p.category === 'apparel' || p.category === 'printful-apparel') && !printfulOnlyDefault) check('data', `${label}: apparel has sizes`, !!hasSizes)
    } else {
      check('data', `${label}: paid digital product has a deliverable file`, hasFiles(p), 'buyer would pay and receive nothing')
    }
    if (p.inventory_count != null && p.inventory_count <= 0) warn('data', `${label}: in stock`, `inventory_count=${p.inventory_count} (shows Sold Out)`)
  }

  // -------------------------------------------------------- static pages/SEO
  section('Pages, SEO & social cards')
  for (const pth of ['/success.html', '/robots.txt', '/sitemap.xml']) {
    const r = await http(site + pth)
    check('pages', `${pth} reachable`, r.status === 200, `status ${r.status}`)
  }
  const sm = await (await http(site + '/sitemap.xml')).text()
  const smUrls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
  check('pages', 'sitemap lists every published product', products.filter(p => p.slug).every(p => smUrls.some(u => u.includes(`/products/${p.slug}/`))),
    `${smUrls.length} urls vs ${products.filter(p => p.slug).length} products`)
  const spa = await http(site + '/products/audit-nonexistent-slug-xyz/')
  check('pages', 'unknown product path falls back to the app (no hard 404)', spa.status === 200, `status ${spa.status}`)
  for (const p of products.filter(x => x.slug)) {
    const r = await http(`${site}/products/${p.slug}/`)
    const html = await r.text()
    const ok = r.status === 200
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1]
    const dupes = (html.match(/property="og:image:width"/g) || []).length
    const canon = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]
    const titleOk = html.includes(`<title>${escapeHtml(p.title)}`) || html.includes(escapeHtml(p.title))
    if (!check('seo', `${p.slug}: page 200`, ok, `status ${r.status}`)) continue
    check('seo', `${p.slug}: og:image + canonical + title are product-specific`, !!og && canon === `${site}/products/${p.slug}/` && titleOk && !og.endsWith('opensign.jpg'),
      `og:image=${og ? og.split('/').pop() : 'MISSING'} canonical=${canon}`)
    check('seo', `${p.slug}: og:image is the CURRENT cover photo`, !p.cover_art_url || og === p.cover_art_url,
      og === p.cover_art_url ? '' : 'prerendered page is stale vs the live product row — needs a redeploy')
    check('seo', `${p.slug}: exactly one og:image:width`, dupes === 1, `found ${dupes}`)
    if (og) {
      const ir = await http(og, { method: 'HEAD' })
      const len = +ir.headers.get('content-length') || 0
      check('seo', `${p.slug}: og:image loads as an image`, ir.status === 200 && /^image\//.test(ir.headers.get('content-type') || ''), `status ${ir.status} ${ir.headers.get('content-type')}`)
      if (len > 1_500_000) warn('perf', `${p.slug}: og:image is large`, `${Math.round(len / 1024)} KB`)
    }
  }

  // ----------------------------------------------------------- images
  section('Product images')
  const imgUrls = new Map()
  for (const p of products) {
    for (const u of [p.cover_art_url, p.image_2_url, p.image_3_url, ...((p.gallery_images || []).map(g => typeof g === 'string' ? g : g?.url))]) if (u) imgUrls.set(u, p.slug)
  }
  let big = 0, broken = 0, totalBytes = 0
  for (const [u, slug] of imgUrls) {
    const r = await http(u, { method: 'HEAD' })
    const len = +r.headers.get('content-length') || 0
    totalBytes += len
    if (r.status !== 200) { broken++; fail('images', `${slug}: image reachable`, `${r.status} ${u}`) }
    else if (len > 800_000) { big++; warn('perf', `${slug}: image over 800 KB`, `${Math.round(len / 1024)} KB ${u.split('/').pop()}`) }
  }
  check('images', `all ${imgUrls.size} product images reachable`, broken === 0)
  check('perf', `no oversized product images (egress quota)`, big === 0, `total ${(totalBytes / 1048576).toFixed(1)} MB across ${imgUrls.size} files`, 'WARN')

  // ------------------------------------------------------- RLS / security
  section('Database access rules (anon key)')
  for (const t of ['orders', 'order_items', 'tips', 'email_captures', 'service_inquiries', 'product_payments', 'game_signup_sync_state', 'processed_webhook_sessions']) {
    const r = await http(`${SB}/rest/v1/${t}?select=*&limit=1`, { headers: H })
    let rows = null
    try { rows = await r.json() } catch { /* */ }
    check('security', `anon cannot read ${t}`, !(r.status === 200 && Array.isArray(rows) && rows.length > 0), `status ${r.status}, rows ${Array.isArray(rows) ? rows.length : 'n/a'}`)
  }
  const ss = await http(`${SB}/rest/v1/site_settings?select=*&limit=1`, { headers: H })
  const ssRows = await ss.json().catch(() => null)
  if (ss.status === 200 && Array.isArray(ssRows) && ssRows.length) warn('security', 'anon can read site_settings', 'fine only if it holds nothing but public email-note text')
  else pass('security', 'anon cannot read site_settings')
  const wr = await http(`${SB}/rest/v1/products?id=eq.00000000-0000-0000-0000-000000000000`, { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ title: 'x' }) })
  check('security', 'anon cannot update products', wr.status >= 400 || (await wr.text()) === '[]', `status ${wr.status}`)
  const ins = await http(`${SB}/rest/v1/products`, { method: 'POST', headers: H, body: JSON.stringify({ title: 'audit-should-fail' }) })
  check('security', 'anon cannot insert products', ins.status >= 400, `status ${ins.status}`)
  for (const col of ['stripe_url', 'stripe_product_id', '*']) {
    const lr = await http(`${SB}/rest/v1/products?select=${col}&limit=1`, { headers: H })
    check('security', `anon cannot read products.${col === '*' ? '* (all columns)' : col}`, lr.status >= 400, `status ${lr.status}`)
  }

  // -------------------------------------------------------- audio vault
  section('Audio vault (private bucket)')
  const withFiles = products.find(p => Array.isArray(p.download_files) && p.download_files.some(f => /\.(mp3|wav|m4a|flac)(\?|$)/i.test(f.url || f)))
  const audioUrl = withFiles ? (withFiles.download_files.map(f => f.url || f).find(u => /\.(mp3|wav|m4a|flac)(\?|$)/i.test(u))) : null
  if (audioUrl) {
    const direct = await http(audioUrl, { method: 'HEAD' })
    check('security', 'raw audio-vault URL is NOT publicly downloadable', direct.status !== 200, `status ${direct.status}`)
    const pb = await call('get-playback-url', { url: audioUrl })
    check('audio', 'get-playback-url returns a signed link', pb.status === 200 && !!pb.json?.url, `status ${pb.status}`)
    if (pb.json?.url) {
      const a = await http(pb.json.url, { headers: { Range: 'bytes=0-1023' } })
      check('audio', 'signed link actually streams audio', [200, 206].includes(a.status) && /audio|octet/.test(a.headers.get('content-type') || ''), `status ${a.status} ${a.headers.get('content-type')}`)
    }
  } else skip('audio', 'audio-vault checks', 'no product with audio files')

  // ------------------------------------------------------ edge functions
  section('Edge functions — error handling, CORS, auth gates')
  for (const fn of ['create-checkout-session', 'get-shipping-rates', 'create-tip-session', 'create-product-payment-session', 'free-download', 'submit-service-inquiry', 'get-playback-url', 'secure-download']) {
    const r = await http(fnUrl(fn), { method: 'OPTIONS', headers: { Origin: site, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-client-info' } })
    const allow = r.headers.get('access-control-allow-origin')
    check('functions', `${fn}: CORS preflight allows the storefront`, r.status < 300 && (allow === '*' || allow === site), `status ${r.status}, allow-origin=${allow}`)
  }
  for (const fn of ['create-stripe-link', 'printful-variant-lookup', 'purchase-shipping-label', 'retry-printful-order']) {
    const r = await call(fn, {})
    check('security', `${fn}: rejects the public anon key`, r.status >= 400 && r.status < 500 && /admin|log(ged)? ?in/i.test(r.json?.error || ''), `status ${r.status} ${r.json?.error || ''}`)
  }
  const wh = await http(fnUrl('stripe-webhook'), { method: 'POST', headers: { ...H, 'stripe-signature': 't=1,v1=bad' }, body: '{}' })
  check('functions', 'stripe-webhook rejects unsigned/bad-signature events with 400', wh.status === 400, `status ${wh.status}`)
  const un = await http(`${fnUrl('unsubscribe')}?email=a@b.co&token=bad`, { headers: H })
  check('functions', 'unsubscribe rejects a bad token', un.status >= 400 || /invalid/i.test(await un.text()), `status ${un.status}`)
  const sd = await call('secure-download', { session_id: 'cs_live_audit_bogus' })
  check('functions', 'secure-download rejects a bogus session cleanly (4xx JSON, not 5xx)', sd.status >= 400 && sd.status < 500 && !!sd.json?.error, `status ${sd.status}`)
  const fd = await call('free-download', { productId: '00000000-0000-0000-0000-000000000000', email: 'audit@example.invalid' })
  check('functions', 'free-download rejects an unknown product cleanly', fd.status >= 400 && fd.status < 500, `status ${fd.status} ${fd.json?.error || ''}`)
  const si = await call('submit-service-inquiry', { productId: '00000000-0000-0000-0000-000000000000' })
  check('functions', 'submit-service-inquiry rejects an incomplete request cleanly', si.status >= 400 && si.status < 500, `status ${si.status} ${si.json?.error || ''}`)
  const pbBad = await call('get-playback-url', { url: 'https://example.com/not-ours.mp3' })
  check('security', 'get-playback-url refuses a URL that is not ours', pbBad.status >= 400, `status ${pbBad.status}`)

  // ----------------------------------------- Checkout: every purchasable product
  section('Checkout — real (unpaid) Stripe sessions for every purchasable product')
  const sample = products.find(p => !isService(p) && !p.coming_soon && !isFree(p) && mode(p) === 'standard' && !isPhysical(p))
  const tip = await call('create-tip-session', { amountCents: 500, name: 'Audit', message: 'audit' })
  check('checkout', 'tip session: $5 creates a Stripe session', tip.status === 200 && /checkout\.stripe\.com/.test(tip.json?.url || ''), `status ${tip.status} ${tip.json?.error || ''}`)
  if (tip.json?.url) ctx.sessions.push(sessionIdFromUrl(tip.json.url))
  const tipLow = await call('create-tip-session', { amountCents: 50 })
  check('checkout', 'tip session: $0.50 is rejected', tipLow.status >= 400 && tipLow.status < 500, `status ${tipLow.status}`)
  const tipHigh = await call('create-tip-session', { amountCents: 999900 })
  check('checkout', 'tip session: $9,999 is rejected', tipHigh.status >= 400 && tipHigh.status < 500, `status ${tipHigh.status}`)

  const svc = products.find(p => isService(p) && !p.coming_soon)
  if (svc) {
    const ps = await call('create-product-payment-session', { productId: svc.id, amountCents: 5000 })
    check('checkout', `service payment session (${svc.slug})`, ps.status === 200 && /checkout\.stripe\.com/.test(ps.json?.url || ''), `status ${ps.status} ${ps.json?.error || ''}`)
    if (ps.json?.url) ctx.sessions.push(sessionIdFromUrl(ps.json.url))
    const psLow = await call('create-product-payment-session', { productId: svc.id, amountCents: 10 })
    check('checkout', 'service payment: under $0.50 is rejected', psLow.status >= 400 && psLow.status < 500, `status ${psLow.status}`)
  } else skip('checkout', 'service payment session', 'no published service')

  const bad1 = await call('create-checkout-session', { items: [{ productId: '00000000-0000-0000-0000-000000000000', quantity: 1 }] })
  check('checkout', 'unknown product is rejected cleanly', bad1.status >= 400 && bad1.status < 500, `status ${bad1.status} ${bad1.json?.error || ''}`)
  const bad2 = await call('create-checkout-session', { items: [] })
  check('checkout', 'empty cart is rejected cleanly', bad2.status >= 400 && bad2.status < 500, `status ${bad2.status}`)

  ctx.checkoutResults = []
  for (const p of products) {
    if (isService(p) || p.coming_soon || isFree(p)) continue
    if (p.inventory_count != null && p.inventory_count <= 0) { skip('checkout', `${p.slug}: checkout`, 'sold out'); continue }
    if ((p.category === 'apparel' || ['printful', 'printful-apparel', 'printful-picks'].includes(p.category)) && !isPhysical(p)) {
      const r = await call('create-checkout-session', { items: [{ productId: p.id, quantity: 1 }] })
      check('checkout', `${p.slug}: unshippable physical item is refused at checkout (not sold as a download)`, r.status >= 400 && r.status < 500, `status ${r.status} ${r.json?.error || ''}`)
      if (r.status === 200 && r.json?.url) ctx.sessions.push(sessionIdFromUrl(r.json.url))
      continue
    }
    const sizes = p.printful_variant_map && Object.keys(p.printful_variant_map).filter(k => k !== 'default').length
      ? Object.keys(p.printful_variant_map).filter(k => k !== 'default')
      : (p.sizes ? p.sizes.split(',').map(s => s.trim()).filter(Boolean) : [])
    const size = sizes[0] || undefined
    const item = { productId: p.id, quantity: 1, size, offerAmountCents: mode(p) === 'offer_based' ? Math.max(p.offer_min_cents || 100, 100) : null }
    let body = { items: [item] }
    let shippingNote = ''
    if (isPhysical(p)) {
      const rates = await call('get-shipping-rates', { items: [{ productId: p.id, quantity: 1, size }], toAddress: TEST_ADDRESS })
      const list = rates.json?.rates || []
      if (!check('checkout', `${p.slug}: live shipping rates returned`, rates.status === 200 && list.length > 0, `status ${rates.status} ${rates.json?.error || ''} (${list.length} rates)`)) continue
      const cheapest = [...list].sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0]
      body = { items: [item], rateId: cheapest.id, toAddress: TEST_ADDRESS }
      shippingNote = ` with shipping $${parseFloat(cheapest.amount).toFixed(2)}`
    }
    const r = await call('create-checkout-session', body)
    const ok = r.status === 200 && /checkout\.stripe\.com/.test(r.json?.url || '')
    check('checkout', `${p.slug}: Stripe checkout session created${shippingNote}`, ok, ok ? '' : `status ${r.status} ${r.json?.error || ''}`)
    if (ok) ctx.sessions.push(sessionIdFromUrl(r.json.url))
  }

  // mixed cart: one physical + one digital
  const phys = products.find(p => isPhysical(p) && !isService(p) && !p.coming_soon && !isFree(p) && mode(p) === 'standard' && !(p.inventory_count != null && p.inventory_count <= 0))
  const dig = products.find(p => !isPhysical(p) && !['apparel', 'printful', 'printful-apparel', 'printful-picks'].includes(p.category) && !isService(p) && !p.coming_soon && !isFree(p) && mode(p) === 'standard' && !(p.inventory_count != null && p.inventory_count <= 0))
  if (phys && dig) {
    const pSizes = phys.printful_variant_map && Object.keys(phys.printful_variant_map).filter(k => k !== 'default').length ? Object.keys(phys.printful_variant_map).filter(k => k !== 'default') : (phys.sizes ? phys.sizes.split(',').map(s => s.trim()) : [])
    const rates = await call('get-shipping-rates', { items: [{ productId: phys.id, quantity: 1, size: pSizes[0] }], toAddress: TEST_ADDRESS })
    const rate = (rates.json?.rates || [])[0]
    if (rate) {
      const r = await call('create-checkout-session', { items: [{ productId: phys.id, quantity: 1, size: pSizes[0] }, { productId: dig.id, quantity: 1 }], rateId: rate.id, toAddress: TEST_ADDRESS })
      const ok = r.status === 200 && /checkout\.stripe\.com/.test(r.json?.url || '')
      check('checkout', `mixed cart (${phys.slug} + ${dig.slug}) creates a session`, ok, ok ? '' : `status ${r.status} ${r.json?.error || ''}`)
      if (ok) ctx.sessions.push(sessionIdFromUrl(r.json.url))
    }
  }

  // ----------------------------------------------------- Google Maps key
  section('Google Maps (address autocomplete)')
  const gk = env.VITE_GOOGLE_MAPS_API_KEY
  if (gk) {
    const nw = await http('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gk, Referer: site + '/' }, body: JSON.stringify({ input: '401 B St San Diego' }) })
    const nj = await nw.json().catch(() => ({}))
    check('maps', 'Places API (New) accepts the key from the live site referrer', nw.status === 200, `status ${nw.status} ${nj.error?.message || ''}`, 'WARN')
    const jsr = await http(`https://maps.googleapis.com/maps/api/js?key=${gk}&libraries=places`, { headers: { Referer: site + '/' } })
    const jst = await jsr.text()
    check('maps', 'Maps JavaScript API loader serves without a key error', jsr.status === 200 && !/InvalidKeyMapError|RefererNotAllowedMapError|ApiNotActivatedMapError/.test(jst) , `status ${jsr.status}`, 'WARN')
    const rogue = await http('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': gk, Referer: 'https://evil.example.com/' }, body: JSON.stringify({ input: 'test' }) })
    check('security', 'Google key is referrer-restricted (rejects a foreign site)', rogue.status === 403, `foreign referrer got status ${rogue.status}`, 'WARN')
  } else skip('maps', 'Google Maps key checks', 'no key available')

  ctx.testAddress = TEST_ADDRESS
}

function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function sessionIdFromUrl(url) { const m = url.match(/(cs_(?:live|test)_[A-Za-z0-9]+)/); return m ? m[1] : null }
void createHash
