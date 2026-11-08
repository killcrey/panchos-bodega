import { createClient } from '@supabase/supabase-js'
import { loadStripe } from '@stripe/stripe-js'
import { getCart, addToCart, removeFromCart, setCartQuantity, cartCount, cartSubtotalCents, cartHasPhysicalItems, isUpchargeSize, SIZE_UPCHARGE_CENTS } from './cart.js'
import { PLAYER_ARTIST, isAudioUrl, slugify, getPlayableTracks, findTrackBySlug, productPath, trackPath, trackMeta } from './tracks.js'
import { SHARE_ICON_SVG, openShareMenu, initShareMenu } from './share.js'
import { watchPlays } from './playlog.js'
import { initInAppBrowserNotice } from './inapp.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY
const googleMapsApiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ADMIN PORTAL
let editingProduct = null

// Mirrors the upload/edit category <select> order — anything found in the
// data but not listed here (a legacy bare 'printful' row, say) still gets
// its own group, just appended after these in alphabetical order.
const CATEGORY_ORDER = ['apparel', 'art', 'music', 'services', 'printful-apparel', 'printful-picks', 'pancho picks']
const CATEGORY_LABELS = {
  apparel: 'Apparel',
  art: 'Art',
  music: 'Music',
  services: 'Services',
  'printful-apparel': 'Printful — Apparel',
  'printful-picks': 'Printful — Picks',
  'pancho picks': 'Pancho Picks',
}

// Kept so the Look Book tab's "use a product photo" picker can list every
// product photo without a second query.
let adminProductsCache = []

async function loadAdminInventory() {
  const listEl = document.getElementById('admin-inventory-list')
  if (!listEl) return

  const { data: products, error } = await supabase.from('products').select('*')

  if (error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load inventory.</p>'
    return
  }
  adminProductsCache = products || []
  renderFeaturedOrderAdmin()

  if (!products || products.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No products yet.</p>'
    return
  }

  listEl.innerHTML = ''

  // Grouped by the product's real stored category (never displayCategory —
  // the admin should see the truth, same reasoning as the rest of this
  // function) so the admin can scan one product type at a time instead of
  // whatever order the DB happened to return rows in.
  const groups = new Map()
  products.forEach(product => {
    const key = product.category || 'uncategorized'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(product)
  })

  const extraCategories = [...groups.keys()]
    .filter(cat => cat !== 'uncategorized' && !CATEGORY_ORDER.includes(cat))
    .sort()
  const categoryKeys = [...CATEGORY_ORDER, ...extraCategories, 'uncategorized'].filter(cat => groups.has(cat))

  categoryKeys.forEach(categoryKey => {
    const categoryProducts = groups.get(categoryKey)
    const heading = document.createElement('p')
    heading.style.cssText = 'font-size: 0.6rem; color: #e8b923; letter-spacing: 1px; text-transform: uppercase; margin: 1rem 0 0.5rem 0;'
    heading.textContent = `${CATEGORY_LABELS[categoryKey] || categoryKey} (${categoryProducts.length})`
    listEl.appendChild(heading)

    categoryProducts.forEach(product => renderAdminInventoryItem(listEl, product))
  })
}

function renderAdminInventoryItem(listEl, product) {
  const item = document.createElement('div')
  item.className = 'inventory-item'
  const isPublished = product.published !== false
  const pricingMode = product.pricing_mode || 'standard'
  // pricing_mode = 'free' forces price_cents to 0 (see readPricingModeFields),
  // same as a plain $0 standard product always has — either one displays as
  // FREE. offer_based also stores price_cents as 0 (unused, replaced by the
  // min/max bounds below), so it's deliberately excluded here rather than
  // read off price_cents too.
  const isFree = pricingMode === 'free' || (pricingMode === 'standard' && (product.price_cents || 0) === 0)
  const isService = product.category === 'services'
  const hasCheckoutId = !!product.stripe_product_id
  // Services (any mode) and Free never need a Stripe Checkout ID —
  // services always use create-product-payment-session's ad-hoc sessions
  // instead of the cart's Stripe pipeline, Free never checks out.
  const needsCheckoutId = product.category !== 'services' && pricingMode !== 'free' && !isFree
  const trackCount = Array.isArray(product.tracklist_snippets) ? product.tracklist_snippets.length : 0
  const isTracked = product.inventory_count != null
  const isSoldOut = isTracked && product.inventory_count <= 0
  const landingSlotLabel = {
    featured: 'Featured',
    latest_release: 'Latest Release',
    pancho_pick: 'Panchos Pick',
    spotlight: 'Spotlight',
  }[product.landing_slot] || ''
  // Mirrors the storefront/checkout rule (see computeProductFlags): apparel and
  // Printful items with neither a weight nor Printful IDs can't ship, so the
  // storefront shows them as Unavailable — flag it here too, since the Checkout
  // ID can be perfectly fine while the item still can't actually be sold.
  const cannotShip = computeProductFlags(product).isUnavailable
  // A $0 service means "Custom Pricing" on its product page (too varied to
  // quote a number), not a free giveaway — showing "FREE" here read as
  // exactly that, incorrectly.
  const priceLabel =
    pricingMode === 'offer_based' ? `OFFER${product.offer_min_cents != null ? ` $${(product.offer_min_cents / 100).toFixed(2)}+` : ''}` :
    isService && isFree ? 'CUSTOM PRICING' :
    isFree ? 'FREE' : `$${((product.price_cents || 0) / 100).toFixed(2)}`
  item.innerHTML = `
    <div class="inventory-item-info">
      <div class="inventory-item-title">${product.title || 'Untitled'}</div>
      <div class="inventory-item-meta">${priceLabel} — ${(product.category || 'uncategorized').toUpperCase()}${trackCount > 0 ? ` — ${trackCount} TRACKS` : ''}${isTracked ? ` — ${product.inventory_count} IN STOCK` : ''}</div>
      <span class="inventory-status-badge ${isPublished ? 'status-published' : 'status-draft'}">${isPublished ? 'Published' : 'Draft'}</span>
      ${!isService && isFree ? '<span class="inventory-status-badge status-free">Free</span>' : ''}
      ${pricingMode === 'offer_based' ? '<span class="inventory-status-badge status-checkout-set">Offer Based</span>' : ''}
      ${product.coming_soon ? '<span class="inventory-status-badge status-coming-soon">Coming Soon</span>' : ''}
      ${isSoldOut ? '<span class="inventory-status-badge status-warning">Sold Out</span>' : ''}
      ${needsCheckoutId ? (hasCheckoutId
        ? '<span class="inventory-status-badge status-checkout-set">Checkout ID Set</span>'
        : '<span class="inventory-status-badge status-warning">No Checkout ID</span>') : ''}
      ${cannotShip ? '<span class="inventory-status-badge status-warning">Cannot ship — add Printful IDs or weight</span>' : ''}
      ${landingSlotLabel ? `<span class="inventory-status-badge status-landing-slot">${landingSlotLabel}</span>` : ''}
    </div>
    <div class="inventory-item-actions">
      <button type="button" class="inventory-edit-btn">Edit</button>
      <button type="button" class="inventory-delete-btn">Delete</button>
    </div>
  `
  item.querySelector('.inventory-edit-btn').addEventListener('click', () => openEditModal(product))
  item.querySelector('.inventory-delete-btn').addEventListener('click', () => deleteProduct(product))
  listEl.appendChild(item)
}

// Tips are a read-only ledger — nothing to fulfill, so unlike orders there's
// no "clear it off the queue" action and the whole history stays listed.
async function loadAdminTips() {
  const listEl = document.getElementById('admin-tips-list')
  if (!listEl) return

  const { data: tips, error } = await supabase
    .from('tips')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load tips.</p>'
    return
  }

  if (!tips || tips.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No tips yet.</p>'
    return
  }

  const totalCents = tips.reduce((sum, t) => sum + (t.amount_cents || 0), 0)

  listEl.innerHTML = `
    <p style="font-size: 0.6rem; color: #e8b923; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 0.5rem 0;">
      ${tips.length} tip${tips.length === 1 ? '' : 's'} — $${(totalCents / 100).toFixed(2)} total
    </p>
    ${tips.map(tip => `
      <div class="tip-row">
        <div class="tip-row-meta">
          <strong style="color: #ccc;">${tip.name || 'Anonymous'}</strong>
          ${tip.email ? `<br>${tip.email}` : ''}
          <br>${tip.created_at ? new Date(tip.created_at).toLocaleDateString() : ''}
          ${tip.message ? `<br><span class="tip-row-message">"${tip.message}"</span>` : ''}
          ${tip.refund_status ? `<br><strong style="color: #ff4d4d;">${tip.refund_status === 'refunded' ? 'Refunded' : 'Partially refunded'}</strong>` : ''}
          ${tip.dispute_status ? `<br><strong style="color: #ff4d4d;">Dispute:</strong> ${tip.dispute_status}` : ''}
        </div>
        <div class="tip-row-amount">$${((tip.amount_cents || 0) / 100).toFixed(2)}</div>
      </div>
    `).join('')}
  `
}

// Free-download claims — write-only until now (see products embed, which
// relies on the products.id -> email_captures.product_id foreign key
// already in place, confirmed live before building this).
async function loadAdminEmailCaptures() {
  const listEl = document.getElementById('admin-email-captures-list')
  if (!listEl) return

  const { data: captures, error } = await supabase
    .from('email_captures')
    .select('*, products(title)')
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load email captures.</p>'
    return
  }

  if (!captures || captures.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No free download claims yet.</p>'
    return
  }

  // One row per unique email — someone who's claimed several different free
  // items is one engaged fan, not several different people. `captures` is
  // already newest-first, so the first row seen per email is their most
  // recent claim.
  const byEmail = new Map()
  for (const capture of captures) {
    if (!byEmail.has(capture.email)) {
      byEmail.set(capture.email, { email: capture.email, mostRecent: capture.created_at, products: [] })
    }
    const title = capture.products?.title || 'Deleted product'
    const entry = byEmail.get(capture.email)
    if (!entry.products.includes(title)) entry.products.push(title)
  }
  const uniqueCaptures = Array.from(byEmail.values())

  listEl.innerHTML = `
    <p style="font-size: 0.6rem; color: #e8b923; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 0.5rem 0;">
      ${uniqueCaptures.length} unique email${uniqueCaptures.length === 1 ? '' : 's'} — ${captures.length} claim${captures.length === 1 ? '' : 's'}
    </p>
    ${uniqueCaptures.map(entry => `
      <div class="tip-row">
        <div class="tip-row-meta">
          <strong style="color: #ccc;">${entry.email}</strong>
          <br>${entry.products.join(', ')}
          <br>${entry.mostRecent ? new Date(entry.mostRecent).toLocaleDateString() : ''}
        </div>
      </div>
    `).join('')}
  `
}

// Same "active to-do queue" shape as loadAdminOrders — a handled inquiry
// drops off the list rather than staying in an ever-growing ledger, since
// each one needs a human follow-up (unlike tips, which just accumulate).
// Shows both service_inquiries (REQUEST A QUOTE requests — need a human
// follow-up, so an "active queue" like Orders) and product_payments
// (PAYMENT button charges — already paid, listed as a read-only ledger like
// Tips, since there's no "handled" state for money that already cleared).
async function loadAdminServiceInquiries() {
  const listEl = document.getElementById('admin-service-inquiries-list')
  if (!listEl) return

  const [{ data: inquiries, error: inquiriesError }, { data: payments, error: paymentsError }] = await Promise.all([
    supabase.from('service_inquiries').select('*').eq('status', 'new').order('created_at', { ascending: false }),
    supabase.from('product_payments').select('*').order('created_at', { ascending: false }).limit(50),
  ])

  if (inquiriesError || paymentsError) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load inquiries.</p>'
    return
  }

  listEl.innerHTML = ''

  const paymentsHeading = document.createElement('p')
  paymentsHeading.style.cssText = 'font-size: 0.6rem; color: #e8b923; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 0.5rem 0;'
  paymentsHeading.textContent = `Service Payments (${(payments || []).length})`
  listEl.appendChild(paymentsHeading)

  if (!payments || payments.length === 0) {
    const empty = document.createElement('p')
    empty.style.cssText = 'font-size: 0.65rem; color: #888; margin: 0 0 1rem 0;'
    empty.textContent = 'None yet.'
    listEl.appendChild(empty)
  } else {
    payments.forEach(payment => {
      const item = document.createElement('div')
      item.className = 'tip-row'
      item.innerHTML = `
        <div class="tip-row-meta">
          <strong style="color: #ccc;">${payment.product_title || 'Deleted product'}</strong>
          ${payment.name || payment.email ? `<br>${[payment.name, payment.email].filter(Boolean).join(' — ')}` : ''}
          <br>${payment.created_at ? new Date(payment.created_at).toLocaleDateString() : ''}
          ${payment.refund_status ? `<br><strong style="color: #ff4d4d;">${payment.refund_status === 'refunded' ? 'Refunded' : 'Partially refunded'}</strong>` : ''}
          ${payment.dispute_status ? `<br><strong style="color: #ff4d4d;">Dispute:</strong> ${payment.dispute_status}` : ''}
        </div>
        <div class="tip-row-amount">$${((payment.amount_cents || 0) / 100).toFixed(2)}</div>
      `
      listEl.appendChild(item)
    })
  }

  const inquiriesHeading = document.createElement('p')
  inquiriesHeading.style.cssText = 'font-size: 0.6rem; color: #e8b923; letter-spacing: 1px; text-transform: uppercase; margin: 1rem 0 0.5rem 0;'
  inquiriesHeading.textContent = `Open Quote Requests (${(inquiries || []).length})`
  listEl.appendChild(inquiriesHeading)

  if (!inquiries || inquiries.length === 0) {
    const empty = document.createElement('p')
    empty.style.cssText = 'font-size: 0.65rem; color: #888;'
    empty.textContent = 'No open inquiries.'
    listEl.appendChild(empty)
    return
  }

  inquiries.forEach(inquiry => {
    const item = document.createElement('div')
    item.className = 'order-item'
    item.innerHTML = `
      <div class="order-item-title">${inquiry.product_title || 'General inquiry'}</div>
      <div class="order-item-meta">
        <strong>${inquiry.name}</strong> — ${inquiry.email}${inquiry.phone ? ` — ${inquiry.phone}` : ''}
        <br>${inquiry.created_at ? new Date(inquiry.created_at).toLocaleDateString() : ''}
        ${inquiry.event_date ? `<br><strong>Date:</strong> ${inquiry.event_date}` : ''}
        ${inquiry.budget ? `<br><strong>Budget:</strong> ${inquiry.budget}` : ''}
        ${inquiry.message ? `<br><strong>Message:</strong> ${inquiry.message}` : ''}
      </div>
      <div class="order-item-actions">
        <a href="mailto:${inquiry.email}">Reply</a>
        <button type="button" class="mark-handled-btn">Mark Handled</button>
      </div>
    `
    item.querySelector('.mark-handled-btn').addEventListener('click', async () => {
      await supabase.from('service_inquiries').update({ status: 'handled' }).eq('id', inquiry.id)
      loadAdminServiceInquiries()
    })
    listEl.appendChild(item)
  })
}

// The two admin-editable notes appended to automated emails — read by
// stripe-webhook (order confirmation + tip thank-you) and free-download
// (download email) at send time. Blank means "no note", not an error.
// ---- FEATURED ORDER ---------------------------------------------------------
// The Featured carousel follows products.featured_order (1 = first slide).
// Products with no order yet (null) sort after every ordered one, and ties keep
// the order the database returned them in (Array.sort is stable), so nothing
// changes until the admin sets an order.
function byFeaturedOrder(a, b) {
  return (a.featured_order ?? 1e9) - (b.featured_order ?? 1e9)
}

// Pure so it can be tested on its own: returns the featured list in its new
// order after moving one product up (-1) or down (+1), or null if it can't move.
function moveInFeaturedList(sortedList, id, dir) {
  const i = sortedList.findIndex(p => p.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= sortedList.length) return null
  const next = sortedList.slice()
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

function renderFeaturedOrderAdmin() {
  const el = document.getElementById('featured-order-list')
  if (!el) return
  const list = adminProductsCache.filter(p => p.landing_slot === 'featured').sort(byFeaturedOrder)
  if (list.length === 0) {
    el.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No products are set to Featured yet. Set a product\'s Landing Page Slot to Featured in its Edit window and it will show up here.</p>'
    return
  }
  const esc = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  el.innerHTML = list.map((p, i) => `
    <div class="inventory-item" data-id="${p.id}">
      <div class="inventory-item-info">
        <div class="inventory-item-title">${i + 1}. ${esc(p.title || 'Untitled')}</div>
      </div>
      <div class="inventory-item-actions">
        <button type="button" class="inventory-edit-btn" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">&#9650;</button>
        <button type="button" class="inventory-edit-btn" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">&#9660;</button>
      </div>
    </div>
  `).join('')
}

async function moveFeatured(id, dir) {
  const statusEl = document.getElementById('featured-order-status')
  const say = (msg, color) => { statusEl.textContent = msg; statusEl.style.color = color }
  const list = adminProductsCache.filter(p => p.landing_slot === 'featured').sort(byFeaturedOrder)
  const next = moveInFeaturedList(list, id, dir)
  if (!next) return
  try {
    say('Saving...', '#e8b923')
    // Renumber the whole list 1..n (so products that had no order yet get one)
    // and write only the rows whose number actually changed. Each update chains
    // .select() and checks the row count — the "update lies by omission" rule.
    const changes = next.map((p, i) => ({ p, order: i + 1 })).filter(({ p, order }) => p.featured_order !== order)
    const results = await Promise.all(changes.map(({ p, order }) =>
      supabase.from('products').update({ featured_order: order }).eq('id', p.id).select('id')
    ))
    const failed = results.find(r => r.error || !r.data || r.data.length !== 1)
    if (failed) throw new Error(failed.error?.message || 'One of the changes did not save.')
    changes.forEach(({ p, order }) => { p.featured_order = order })
    renderFeaturedOrderAdmin()
    say('Saved. Refresh the Featured page to see the new order.', '#00ffcc')
  } catch (err) {
    console.error('Featured order save failed:', err)
    say(err.message || 'Could not save the new order.', '#ff4d4d')
    await loadAdminInventory()
  }
}

function initFeaturedOrderAdmin() {
  const el = document.getElementById('featured-order-list')
  if (!el) return
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]')
    if (!btn || btn.disabled) return
    moveFeatured(btn.closest('.inventory-item').getAttribute('data-id'), parseInt(btn.getAttribute('data-dir'), 10))
  })
}

// ---- LOOK BOOK (admin) --------------------------------------------------
// Keeps the newest LOOKBOOK_MAX photos: adding past the cap deletes the
// oldest ones. Uploaded photos are resized small first (they only ever show
// in a ~240px-tall strip). Rows with source 'product' just reference an
// existing product photo — deleting one removes the row only, never the file,
// because the product still uses it.
const LOOKBOOK_IMAGE_PX = 1000

// Pure so the FIFO rule can be tested on its own: rows are oldest -> newest,
// returns the ones that have to go to get back down to max.
function planLookbookTrim(rows, max) {
  return rows.length > max ? rows.slice(0, rows.length - max) : []
}

async function removeLookbookRows(rows) {
  if (rows.length === 0) return
  const { data, error } = await supabase.from('lookbook_photos').delete().in('id', rows.map(r => r.id)).select('id')
  // Same "update/delete lies by omission under RLS" rule as everywhere else.
  if (error || !data || data.length !== rows.length) throw new Error(error?.message || 'Could not remove the photo.')
  const paths = rows
    .filter(r => r.source === 'upload')
    .map(r => extractStoragePath(r.image_url, 'bodega-images'))
    .filter(Boolean)
  if (paths.length > 0) await supabase.storage.from('bodega-images').remove(paths)
}

async function loadAdminLookbook() {
  const el = document.getElementById('lookbook-current')
  if (!el) return
  const { data, error } = await supabase.from('lookbook_photos').select('*').order('created_at', { ascending: true })
  if (error) {
    el.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load look book photos.</p>'
    return
  }
  const rows = data || []
  el.innerHTML = rows.map(row => `
    <div class="admin-image-thumb">
      <img src="${row.image_url}" alt="">
      <button type="button" class="admin-image-remove-btn" data-id="${row.id}" aria-label="Remove photo">&times;</button>
    </div>
  `).join('')
  el.dataset.rows = JSON.stringify(rows)
  document.getElementById('lookbook-count').textContent = rows.length === 0
    ? 'No photos yet — the strip stays hidden until you add one.'
    : `${rows.length} of ${LOOKBOOK_MAX} photos — the first one is the oldest and is dropped first when you add more.`
}

async function addLookbookPhotos(items) {
  const statusEl = document.getElementById('lookbook-status')
  const say = (msg, color = '#e8b923') => { statusEl.textContent = msg; statusEl.style.color = color }
  if (items.length === 0) return
  try {
    // More than a full set at once: only the newest LOOKBOOK_MAX would
    // survive the trim anyway, so don't upload the rest just to delete them.
    const picked = items.slice(-LOOKBOOK_MAX)
    say(`Adding ${picked.length} photo${picked.length === 1 ? '' : 's'}...`)
    const base = Date.now()
    const rows = []
    for (let i = 0; i < picked.length; i++) {
      const item = picked[i]
      let url = item.url
      if (item.file) {
        const file = await compressProductImage(item.file, LOOKBOOK_IMAGE_PX)
        const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '-')
        const path = `lookbook-${base}-${i}-${safeName}`
        const { error: upErr } = await supabase.storage.from('bodega-images').upload(path, file, { cacheControl: '2592000' })
        if (upErr) throw upErr
        url = supabase.storage.from('bodega-images').getPublicUrl(path).data.publicUrl
      }
      // Explicit, strictly increasing timestamps — a single multi-row insert
      // would otherwise stamp every row with the same now() and make "oldest"
      // ambiguous.
      rows.push({ image_url: url, source: item.file ? 'upload' : 'product', created_at: new Date(base + i).toISOString() })
    }
    const { error: insErr } = await supabase.from('lookbook_photos').insert(rows)
    if (insErr) throw insErr

    const { data: all, error: listErr } = await supabase.from('lookbook_photos').select('*').order('created_at', { ascending: true })
    if (listErr) throw listErr
    await removeLookbookRows(planLookbookTrim(all || [], LOOKBOOK_MAX))
    await loadAdminLookbook()
    say('Saved. Refresh the Featured page to see it.', '#00ffcc')
  } catch (err) {
    console.error('Look book add failed:', err)
    say(err.message || 'Something went wrong adding the photo.', '#ff4d4d')
    await loadAdminLookbook()
  }
}

// VIP FOLDER LINKS (admin "VIP Links" tab) — the secret link written onto the
// NFC keychains. The table is admin-only (the token is the secret); the public
// vip-folder edge function is the only reader, and it enforces the 7-day expiry
// (set by the table default) and the shut-off flag on every request.
const VIP_PAGE_BASE = 'https://bodega.theinvisiblepanchos.com/vip/'
// The albums a link can open (slug -> name shown in the list). The same slugs are
// the only ones the database accepts (vip_links_product_slug_allowed) and match the
// <option>s of #vip-album in index.html — a third album means all three.
const VIP_ALBUM_NAMES = {
  'memories-of-home': 'Memories Of Home',
  'the-invisible-panchos-layers-download': 'Layers',
}

// Web NFC exists only in Chrome on Android (HTTPS page, tapped from a user gesture).
// Elsewhere the "Write to Keychain" button is simply not shown; Copy Link + an NFC app still work.
const VIP_WEB_NFC = typeof window !== 'undefined' && 'NDEFReader' in window
let vipNfcAbort = null

// The status line (#vip-status) sits above the list, out of sight when you are
// scrolled down to a link — so a finished write showed nothing. The result is now
// also shown ON the button that was tapped, in a banner pinned to the top of the
// screen, and as a buzz on phones that support it.
function vipNfcBanner(msg, ok) {
  let el = document.getElementById('vip-nfc-banner')
  if (!el) {
    el = document.createElement('div')
    el.id = 'vip-nfc-banner'
    el.setAttribute('role', 'status')
    el.style.cssText = 'position: fixed; top: 0.8rem; left: 50%; transform: translateX(-50%); z-index: 100000; max-width: 92vw; padding: 0.9rem 1.2rem; font-size: 0.95rem; font-weight: bold; text-align: center; border-radius: 6px; box-shadow: 0 4px 18px rgba(0,0,0,0.6);'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.style.background = ok ? '#00ffcc' : '#ff4d4d'
  el.style.color = '#000'
  el.style.display = 'block'
  clearTimeout(vipNfcBanner.timer)
  vipNfcBanner.timer = setTimeout(() => { el.style.display = 'none' }, 6000)
}

async function writeVipKeychain(url, say, btn) {
  if (vipNfcAbort) vipNfcAbort.abort() // a second tap on the button cancels the waiting write
  const ctrl = new AbortController()
  vipNfcAbort = ctrl
  const timer = setTimeout(() => ctrl.abort(), 30000)
  const original = btn ? (btn.dataset.label || (btn.dataset.label = btn.textContent)) : ''
  const tok = String(Date.now() + Math.random())
  const setBtn = (text, bg) => {
    if (!btn) return
    btn.dataset.tok = tok
    btn.textContent = text
    btn.style.background = bg || ''
    btn.style.color = bg ? '#000' : ''
  }
  // Only put the label back if a newer write hasn't taken over the button since.
  const resetBtnLater = (ms) => setTimeout(() => { if (btn && btn.dataset.tok === tok) { setBtn(original); btn.style.background = ''; btn.style.color = '' } }, ms)
  // url === null means ERASE: the tag gets one empty NDEF record (it stays writable, just blank).
  const erasing = !url
  say('Hold the keychain flat against the back of your phone...')
  setBtn('Waiting for keychain...')
  try {
    await new NDEFReader().write({ records: [erasing ? { recordType: 'empty' } : { recordType: 'url', data: url }] }, { signal: ctrl.signal })
    say(erasing ? 'Keychain erased. It is blank and can be written again.' : 'Keychain written. Tap it on a phone to test it.', '#00ffcc')
    setBtn(erasing ? '✓ Erased' : '✓ Written', '#00ffcc')
    vipNfcBanner(erasing ? '✓ Keychain erased. It is blank now.' : '✓ Keychain written. Tap it on a phone to test.', true)
    try { navigator.vibrate && navigator.vibrate([150, 80, 150]) } catch (e) { /* not supported */ }
    resetBtnLater(8000)
  } catch (err) {
    const msg = ctrl.signal.aborted ? 'Cancelled or timed out. Press the button and try again.'
      : err && err.name === 'NotAllowedError' ? 'NFC is off or blocked. Turn NFC on in your phone settings and allow it for this site.'
      : err && err.name === 'NotSupportedError' ? 'This tag cannot be written (or is locked).'
      : (err && err.message) || (erasing ? 'Could not erase the keychain.' : 'Could not write the keychain.')
    console.error('VIP keychain write failed:', err)
    say(msg, '#ff4d4d')
    setBtn('Failed - try again', '#ff4d4d')
    vipNfcBanner(msg, false)
    resetBtnLater(6000)
  } finally {
    clearTimeout(timer)
    if (vipNfcAbort === ctrl) vipNfcAbort = null
  }
}

function vipLinkStatus(row) {
  if (row.revoked) return { text: 'Shut off', color: '#888', live: false }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { text: 'Expired', color: '#888', live: false }
  const when = new Date(row.expires_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return { text: `Live — closes ${when}`, color: '#00ffcc', live: true }
}

const VIP_TITLE_MAX = 120

// <input type="datetime-local"> wants local time as "YYYY-MM-DDTHH:mm".
function vipDateInputValue(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

async function loadAdminPlays() {
  const totalsEl = document.getElementById('plays-totals')
  const listEl = document.getElementById('plays-list')
  if (!totalsEl || !listEl) return
  const [totalsRes, statsRes] = await Promise.all([
    supabase.from('track_play_totals').select('*').maybeSingle(),
    supabase.from('track_play_stats').select('*').order('plays', { ascending: false })
  ])
  if (totalsRes.error || statsRes.error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load plays.</p>'
    return
  }
  const t = totalsRes.data || { plays: 0, listeners: 0, plays_7d: 0, listeners_7d: 0 }
  const box = (label, value) => `<div style="border: 1px solid #333; padding: 0.5rem 0.7rem; flex: 1; min-width: 6rem;"><div style="font-size: 1.1rem;">${Number(value) || 0}</div><div style="font-size: 0.55rem; color: #888;">${label}</div></div>`
  totalsEl.innerHTML = `<div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.5rem 0;">${box('Plays, all time', t.plays)}${box('Listeners, all time', t.listeners)}${box('Plays, last 7 days', t.plays_7d)}${box('Listeners, last 7 days', t.listeners_7d)}</div>`
  const rows = statsRes.data || []
  if (rows.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #aaa;">No 30-second plays yet.</p>'
    return
  }
  listEl.innerHTML = rows.map(r => {
    const name = r.track_name || r.album || r.product_slug
    const extra = [r.shared_plays > 0 ? `${r.shared_plays} from shared links` : '', r.vip_plays > 0 ? `${r.vip_plays} from VIP page` : ''].filter(Boolean).join(' · ')
    return `
      <div style="border: 1px solid #333; padding: 0.6rem; margin-top: 0.5rem;">
        <div style="display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline;">
          <strong style="font-size: 0.75rem;">${escapeHtmlText(name)}</strong>
          <span style="font-size: 0.7rem;">${r.plays} play${r.plays === 1 ? '' : 's'} · ${r.listeners} listener${r.listeners === 1 ? '' : 's'}</span>
        </div>
        <span style="font-size: 0.55rem; color: #888;">${escapeHtmlText(r.track_name ? r.album : '')}${r.track_name && extra ? ' · ' : ''}${escapeHtmlText(extra)}${(r.track_name || extra) ? ' · ' : ''}last 7 days: ${r.plays_7d} plays, ${r.listeners_7d} listeners</span>
      </div>
    `
  }).join('')
}

async function loadAdminVipLinks() {
  const el = document.getElementById('vip-links-list')
  if (!el) return
  const { data, error } = await supabase.from('vip_links').select('*').order('created_at', { ascending: false })
  if (error) {
    el.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load VIP links.</p>'
    return
  }
  if (!data || data.length === 0) {
    el.innerHTML = '<p style="font-size: 0.65rem; color: #aaa;">No links yet. Make one above.</p>'
    return
  }
  el.innerHTML = data.map(row => {
    const status = vipLinkStatus(row)
    const url = VIP_PAGE_BASE + row.token
    const lastOpened = row.last_opened_at
      ? `, last ${new Date(row.last_opened_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      : ''
    const opened = row.open_count > 0
      ? `Opened ${row.open_count} time${row.open_count === 1 ? '' : 's'}${lastOpened}`
      : 'Not opened yet'
    return `
      <div style="border: 1px solid #333; padding: 0.7rem; margin-top: 0.7rem; display: flex; flex-direction: column; gap: 0.4rem;">
        <div style="display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline;">
          <strong style="font-size: 0.8rem;">${escapeHtmlText(row.label || 'Untitled event')}</strong>
          <span style="font-size: 0.65rem; color: ${status.color};">${escapeHtmlText(status.text)}</span>
        </div>
        <span style="font-size: 0.6rem; color: #888;">${escapeHtmlText(VIP_ALBUM_NAMES[row.product_slug] || row.product_slug)} · ${escapeHtmlText(opened)} · Download: ${row.download_url ? 'Google Drive link' : 'built-in zip'}</span>
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <span style="font-size: 0.6rem; color: #888;">Title:</span>
          <input type="text" class="admin-input" style="width: auto; flex: 1; min-width: 11rem;" maxlength="${VIP_TITLE_MAX}" data-vip-title="${escapeHtmlText(row.id)}" value="${escapeHtmlText(row.label || '')}" aria-label="Link title (shown on the link preview card)">
          <button type="button" class="admin-btn" data-vip-save-title="${escapeHtmlText(row.id)}">Save Title</button>
        </div>
        <input type="text" class="admin-input" readonly value="${escapeHtmlText(url)}" onclick="this.select()" aria-label="VIP link">
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="admin-btn" data-vip-copy="${escapeHtmlText(url)}">Copy Link</button>
          ${status.live && VIP_WEB_NFC ? `<button type="button" class="admin-btn" data-vip-nfc="${escapeHtmlText(url)}">Write to Keychain</button>` : ''}
          ${VIP_WEB_NFC ? `<button type="button" class="admin-btn" data-vip-nfc-erase>Erase Keychain</button>` : ''}
          ${status.live ? `<button type="button" class="admin-btn" data-vip-off="${escapeHtmlText(row.id)}">Shut Off Now</button>` : ''}
        </div>
        ${row.revoked ? '' : `
        <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
          <span style="font-size: 0.6rem; color: #888;">Closes:</span>
          <input type="datetime-local" class="admin-input" style="width: auto; flex: 1; min-width: 11rem;" data-vip-date="${escapeHtmlText(row.id)}" value="${escapeHtmlText(vipDateInputValue(row.expires_at))}" aria-label="Link close date">
          <button type="button" class="admin-btn" data-vip-save-date="${escapeHtmlText(row.id)}">Change Close Date</button>
        </div>`}
      </div>
    `
  }).join('')
}

async function createVipLink() {
  const statusEl = document.getElementById('vip-status')
  const say = (msg, color = '#e8b923') => { statusEl.textContent = msg; statusEl.style.color = color }
  const labelEl = document.getElementById('vip-label')
  const noteEl = document.getElementById('vip-note')
  const driveEl = document.getElementById('vip-download-url')
  const albumEl = document.getElementById('vip-album')
  const productSlug = albumEl.value
  if (!VIP_ALBUM_NAMES[productSlug]) { say('Pick an album.', '#ff4d4d'); return }
  const label = labelEl.value.trim()
  if (!label) { say('Give the link an event name so you can tell them apart.', '#ff4d4d'); return }
  // Same rule the page enforces: only a Google Drive link can replace the built-in zip.
  const downloadUrl = driveEl.value.trim()
  if (downloadUrl && !downloadUrl.startsWith('https://drive.google.com/')) {
    say('The download link must be a Google Drive link (it starts with https://drive.google.com/). Or leave it blank.', '#ff4d4d')
    return
  }
  say('Making the link...')
  const { data, error } = await supabase.from('vip_links').insert({ label, note: noteEl.value.trim(), download_url: downloadUrl, product_slug: productSlug }).select().single()
  if (error || !data) {
    console.error('VIP link create failed:', error)
    say((error && error.message) || 'Could not make the link.', '#ff4d4d')
    return
  }
  labelEl.value = ''
  noteEl.value = ''
  driveEl.value = ''
  let copied = false
  try { await navigator.clipboard.writeText(VIP_PAGE_BASE + data.token); copied = true } catch (err) { /* the list below has a Copy button */ }
  say(copied
    ? (VIP_WEB_NFC ? 'Link made and copied. Press "Write to Keychain" below, then tap the keychain to your phone.' : 'Link made and copied. Write it onto the keychains with your NFC app.')
    : 'Link made. Copy it from the list below.', '#00ffcc')
  await loadAdminVipLinks()
}

function initVipAdmin() {
  const createBtn = document.getElementById('vip-create-btn')
  const list = document.getElementById('vip-links-list')
  if (!createBtn || !list) return
  createBtn.addEventListener('click', createVipLink)
  list.addEventListener('click', async (e) => {
    const statusEl = document.getElementById('vip-status')
    const say = (msg, color = '#e8b923') => { statusEl.textContent = msg; statusEl.style.color = color }
    const copyBtn = e.target.closest('[data-vip-copy]')
    if (copyBtn) {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.vipCopy)
        say('Link copied.', '#00ffcc')
      } catch (err) {
        say('Could not copy — tap the link box and copy it by hand.', '#ff4d4d')
      }
      return
    }
    const nfcBtn = e.target.closest('[data-vip-nfc]')
    if (nfcBtn) {
      await writeVipKeychain(nfcBtn.dataset.vipNfc, say, nfcBtn)
      return
    }
    const eraseBtn = e.target.closest('[data-vip-nfc-erase]')
    if (eraseBtn) {
      await writeVipKeychain(null, say, eraseBtn)
      return
    }
    const titleBtn = e.target.closest('[data-vip-save-title]')
    if (titleBtn) {
      const id = titleBtn.dataset.vipSaveTitle
      const input = list.querySelector(`[data-vip-title="${CSS.escape(id)}"]`)
      const label = input ? input.value.trim().slice(0, VIP_TITLE_MAX) : ''
      if (!label) { say('Give the link a title.', '#ff4d4d'); return }
      // Chained .select() so a blocked/no-match update isn't reported as success.
      const { data, error } = await supabase.from('vip_links').update({ label }).eq('id', id).select('id')
      if (error || !data || data.length === 0) {
        console.error('VIP link title change failed:', error)
        say((error && error.message) || 'Could not change that title.', '#ff4d4d')
      } else {
        say('Title saved. Messaging apps may keep showing the old preview for a while.', '#00ffcc')
      }
      await loadAdminVipLinks()
      return
    }
    const dateBtn = e.target.closest('[data-vip-save-date]')
    if (dateBtn) {
      const id = dateBtn.dataset.vipSaveDate
      const input = list.querySelector(`[data-vip-date="${CSS.escape(id)}"]`)
      const when = input && input.value ? new Date(input.value) : null
      if (!when || Number.isNaN(when.getTime())) { say('Pick a close date and time first.', '#ff4d4d'); return }
      if (when.getTime() <= Date.now()) { say('That is in the past. Pick a future date, or use Shut Off Now to close the link.', '#ff4d4d'); return }
      // Chained .select() so a blocked/no-match update isn't reported as success.
      const { data, error } = await supabase.from('vip_links').update({ expires_at: when.toISOString() }).eq('id', id).select('id')
      if (error || !data || data.length === 0) {
        console.error('VIP link date change failed:', error)
        say((error && error.message) || 'Could not change that date.', '#ff4d4d')
      } else {
        say('Close date changed.', '#00ffcc')
      }
      await loadAdminVipLinks()
      return
    }
    const offBtn = e.target.closest('[data-vip-off]')
    if (offBtn) {
      if (!confirm('Shut this link off now? Anyone with it will see "This link has closed."')) return
      // Chained .select() so a blocked/no-match update isn't reported as success.
      const { data, error } = await supabase.from('vip_links').update({ revoked: true }).eq('id', offBtn.dataset.vipOff).select('id')
      if (error || !data || data.length === 0) {
        console.error('VIP link shut-off failed:', error)
        say((error && error.message) || 'Could not shut that link off.', '#ff4d4d')
      } else {
        say('Link shut off.', '#00ffcc')
      }
      await loadAdminVipLinks()
    }
  })
}

function initLookbookAdmin() {
  const fileInput = document.getElementById('lookbook-file')
  if (!fileInput) return
  fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files)
    e.target.value = ''
    await addLookbookPhotos(files.map(file => ({ file })))
  })

  document.getElementById('lookbook-current').addEventListener('click', async (e) => {
    const btn = e.target.closest('.admin-image-remove-btn')
    if (!btn) return
    const rows = JSON.parse(document.getElementById('lookbook-current').dataset.rows || '[]')
    const row = rows.find(r => r.id === btn.getAttribute('data-id'))
    if (!row) return
    const statusEl = document.getElementById('lookbook-status')
    try {
      await removeLookbookRows([row])
      statusEl.textContent = 'Removed.'
      statusEl.style.color = '#00ffcc'
    } catch (err) {
      statusEl.textContent = err.message
      statusEl.style.color = '#ff4d4d'
    }
    await loadAdminLookbook()
  })

  const picker = document.getElementById('lookbook-product-picker')
  document.getElementById('lookbook-product-btn').addEventListener('click', () => {
    if (picker.style.display !== 'none') { picker.style.display = 'none'; return }
    const urls = new Set()
    adminProductsCache.forEach(p => {
      [p.cover_art_url, p.image_2_url, p.image_3_url, ...(Array.isArray(p.gallery_images) ? p.gallery_images : [])]
        .filter(Boolean).forEach(u => urls.add(u))
    })
    picker.innerHTML = [...urls].map(u => `
      <div class="admin-image-thumb lookbook-pick" data-url="${u}" style="cursor: pointer;"><img src="${u}" alt=""></div>
    `).join('') || '<p style="font-size: 0.65rem; color: #888;">No product photos yet.</p>'
    picker.style.display = 'flex'
  })
  picker.addEventListener('click', async (e) => {
    const pick = e.target.closest('.lookbook-pick')
    if (!pick) return
    picker.style.display = 'none'
    await addLookbookPhotos([{ url: pick.getAttribute('data-url') }])
  })
}

async function loadAdminSettings() {
  const purchaseInput = document.getElementById('settings-purchase-message')
  const tipInput = document.getElementById('settings-tip-message')
  if (!purchaseInput || !tipInput) return

  const { data, error } = await supabase
    .from('site_settings')
    .select('purchase_thank_you_message, tip_thank_you_message')
    .eq('id', true)
    .single()

  if (error) {
    console.error('Failed to load site settings:', error)
    return
  }

  purchaseInput.value = data?.purchase_thank_you_message || ''
  tipInput.value = data?.tip_thank_you_message || ''
}

async function loadAdminOrders() {
  const listEl = document.getElementById('admin-orders-list')
  if (!listEl) return

  // Once an order is marked shipped it drops off this list — it's meant to
  // be the active/to-do queue, not a full order history.
  const { data: orders, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .is('fulfilled_at', null)
    .order('created_at', { ascending: false })

  if (error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load orders.</p>'
    return
  }

  if (!orders || orders.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No open orders.</p>'
    return
  }

  listEl.innerHTML = ''

  // Only used for the address-edit inputs' `value=""` attributes below — a
  // customer-typed address landing in an unescaped attribute could break
  // the markup or inject a script tag into the admin's own view.
  const escapeAttr = (str) => String(str || '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const addrInputStyle = 'width: 100%; background: #000; border: 1px solid #555; color: #fff; padding: 0.4rem 0.5rem; margin-bottom: 0.4rem; font-size: 0.65rem; box-sizing: border-box; font-family: inherit;'

  orders.forEach(order => {
    const item = document.createElement('div')
    item.className = 'order-item'

    const amount = order.amount_total_cents != null ? `$${(order.amount_total_cents / 100).toFixed(2)}` : '—'
    const orderDate = order.created_at ? new Date(order.created_at).toLocaleDateString() : ''
    const addressLines = [
      order.shipping_name,
      [order.shipping_street1, order.shipping_street2].filter(Boolean).join(' '),
      [order.shipping_city, order.shipping_state, order.shipping_zip].filter(Boolean).join(', '),
      order.shipping_country
    ].filter(Boolean).join('<br>')

    const hasShipping = !!order.shipping_street1
    // A shipping order can have a self-fulfilled (Shippo) component, a
    // Printful component, or both — each gets its own status/actions since
    // they're separate parcels handled by separate systems.
    const hasShippoLabel = !!order.shipping_rate_id
    const hasPrintful = !!order.printful_order_status
    const items = Array.isArray(order.order_items) ? order.order_items : []
    const itemsSummary = items.length > 0
      ? items.map(oi => `${oi.quantity > 1 ? `${oi.quantity} × ` : ''}${oi.product_title}${oi.size ? ` — Size ${oi.size}` : ''}`).join(', ')
      : (order.product_title || 'Order')

    const statusLabel = order.label_status === 'purchased' ? 'Label Ready' : order.label_status === 'failed' ? 'Label Failed' : 'Label Pending'
    const printfulStatusLabel = order.printful_order_status === 'submitted' ? 'Printful Submitted' : order.printful_order_status === 'failed' ? 'Printful Failed' : 'Printful Pending'

    item.innerHTML = `
      <div class="order-item-title">${itemsSummary}</div>
      <div class="order-item-meta">
        ${amount} — ${orderDate}${order.customer_email ? `<br><strong>Email:</strong> ${order.customer_email}` : ''}
        ${hasShipping ? `<br><strong>Ship to:</strong> ${addressLines || 'No address on file'}` : '<br><strong>Digital order</strong> — no shipping required'}
        ${order.shipping_service ? `<br><strong>Service:</strong> ${order.shipping_service}` : ''}
        ${order.tracking_number ? `<br><strong>Tracking:</strong> ${order.tracking_number}` : ''}
        ${hasShippoLabel && order.label_status === 'failed' && order.label_error ? `<br><strong>Label Error:</strong> ${order.label_error}` : ''}
        ${hasPrintful && order.printful_order_status === 'failed' && order.printful_order_error ? `<br><strong>Printful Error:</strong> ${order.printful_order_error}` : ''}
        ${hasPrintful && order.printful_order_id ? `<br><strong>Printful Order:</strong> #${order.printful_order_id}` : ''}
        ${order.oversold_items ? `<br><strong style="color: #ff4d4d;">Oversold:</strong> ${order.oversold_items} — paid for, but stock was already gone by the time this cleared. Handle manually (refund or backorder).` : ''}
        ${order.refund_status ? `<br><strong>Refund:</strong> ${order.refund_status === 'refunded' ? 'Fully refunded' : 'Partially refunded'}${order.refunded_amount_cents ? ` ($${(order.refunded_amount_cents / 100).toFixed(2)})` : ''}` : ''}
        ${order.dispute_status ? `<br><strong style="color: #ff4d4d;">Dispute:</strong> ${order.dispute_status}` : ''}
      </div>
      ${hasShippoLabel ? `<span class="order-status-badge status-${order.label_status}">${statusLabel}</span>` : ''}
      ${hasPrintful ? `<span class="order-status-badge status-${order.printful_order_status}">${printfulStatusLabel}</span>` : ''}
      ${order.oversold_items ? `<span class="order-status-badge status-warning">Oversold</span>` : ''}
      ${order.refund_status ? `<span class="order-status-badge status-warning">${order.refund_status === 'refunded' ? 'Refunded' : 'Partial Refund'}</span>` : ''}
      ${order.dispute_status ? `<span class="order-status-badge status-warning">Dispute: ${order.dispute_status}</span>` : ''}
      <div class="order-item-actions">
        ${hasShippoLabel ? (order.label_status === 'purchased'
          ? `<a href="${order.label_url}" target="_blank" rel="noopener noreferrer">Print Label</a>`
          : `<button type="button" class="buy-label-btn">${order.label_status === 'failed' ? 'Retry Label' : 'Buy Label'}</button>`
        ) : ''}
        ${hasPrintful && order.printful_order_status === 'failed' ? `<button type="button" class="retry-printful-btn">Retry Printful Order</button>` : ''}
        ${order.tracking_url ? `<a href="${order.tracking_url}" target="_blank" rel="noopener noreferrer">Track</a>` : ''}
        ${hasShipping ? `<button type="button" class="edit-address-btn">Edit Address</button>` : ''}
        ${hasShipping ? `<button type="button" class="mark-shipped-btn">Mark Shipped</button>` : ''}
      </div>
      ${hasShipping ? `
        <div class="order-address-edit" style="display: none; margin-top: 0.6rem; padding-top: 0.6rem; border-top: 1px solid rgba(255,255,255,0.15);">
          <input type="text" class="addr-name" placeholder="Name" value="${escapeAttr(order.shipping_name)}" style="${addrInputStyle}">
          <input type="text" class="addr-street1" placeholder="Street address" value="${escapeAttr(order.shipping_street1)}" style="${addrInputStyle}">
          <input type="text" class="addr-street2" placeholder="Apt / suite (optional)" value="${escapeAttr(order.shipping_street2)}" style="${addrInputStyle}">
          <div style="display: flex; gap: 0.4rem;">
            <input type="text" class="addr-city" placeholder="City" value="${escapeAttr(order.shipping_city)}" style="${addrInputStyle} flex: 2;">
            <input type="text" class="addr-state" placeholder="State" value="${escapeAttr(order.shipping_state)}" style="${addrInputStyle} flex: 1;">
            <input type="text" class="addr-zip" placeholder="ZIP" value="${escapeAttr(order.shipping_zip)}" style="${addrInputStyle} flex: 1;">
          </div>
          <input type="text" class="addr-country" placeholder="Country" value="${escapeAttr(order.shipping_country)}" style="${addrInputStyle}">
          <div style="display: flex; gap: 0.4rem; margin-top: 0.2rem;">
            <button type="button" class="save-address-btn">Save Address</button>
            <button type="button" class="cancel-address-btn">Cancel</button>
          </div>
        </div>
      ` : ''}
    `

    const buyLabelBtn = item.querySelector('.buy-label-btn')
    if (buyLabelBtn) {
      buyLabelBtn.addEventListener('click', async () => {
        buyLabelBtn.disabled = true
        buyLabelBtn.textContent = 'Buying...'
        try {
          const { error: fnError } = await supabase.functions.invoke('purchase-shipping-label', {
            body: { orderId: order.id }
          })
          if (fnError) throw fnError
          loadAdminOrders()
        } catch (err) {
          alert(await describeFunctionError(err))
          buyLabelBtn.disabled = false
          buyLabelBtn.textContent = order.label_status === 'failed' ? 'Retry Label' : 'Buy Label'
        }
      })
    }

    // Mirrors buyLabelBtn above — a failed Printful order previously had no
    // recovery path in the admin at all (see AUDIT.md Pass 3).
    const retryPrintfulBtn = item.querySelector('.retry-printful-btn')
    if (retryPrintfulBtn) {
      retryPrintfulBtn.addEventListener('click', async () => {
        retryPrintfulBtn.disabled = true
        retryPrintfulBtn.textContent = 'Retrying...'
        try {
          const { error: fnError } = await supabase.functions.invoke('retry-printful-order', {
            body: { orderId: order.id }
          })
          if (fnError) throw fnError
          loadAdminOrders()
        } catch (err) {
          alert(await describeFunctionError(err))
          retryPrintfulBtn.disabled = false
          retryPrintfulBtn.textContent = 'Retry Printful Order'
        }
      })
    }

    // Pass 3 MEDIUM (AUDIT.md): a bad address previously had no admin-facing
    // fix short of editing the row directly in Supabase's Table Editor — a
    // failed label/Printful submission would just fail the same way every
    // retry, since both re-read these same shipping_* columns unchanged.
    const editAddressBtn = item.querySelector('.edit-address-btn')
    const addressEditPanel = item.querySelector('.order-address-edit')
    if (editAddressBtn && addressEditPanel) {
      editAddressBtn.addEventListener('click', () => {
        addressEditPanel.style.display = addressEditPanel.style.display === 'none' ? 'block' : 'none'
      })
    }

    const cancelAddressBtn = item.querySelector('.cancel-address-btn')
    if (cancelAddressBtn) {
      cancelAddressBtn.addEventListener('click', () => {
        addressEditPanel.style.display = 'none'
      })
    }

    const saveAddressBtn = item.querySelector('.save-address-btn')
    if (saveAddressBtn) {
      saveAddressBtn.addEventListener('click', async () => {
        const updated = {
          shipping_name: item.querySelector('.addr-name').value.trim(),
          shipping_street1: item.querySelector('.addr-street1').value.trim(),
          shipping_street2: item.querySelector('.addr-street2').value.trim() || null,
          shipping_city: item.querySelector('.addr-city').value.trim(),
          shipping_state: item.querySelector('.addr-state').value.trim(),
          shipping_zip: item.querySelector('.addr-zip').value.trim(),
          shipping_country: item.querySelector('.addr-country').value.trim(),
        }
        if (!updated.shipping_street1 || !updated.shipping_city || !updated.shipping_zip) {
          alert('Street address, city, and ZIP are required.')
          return
        }

        saveAddressBtn.disabled = true
        saveAddressBtn.textContent = 'Saving...'

        // .update() under RLS returns { error: null } even when it matches
        // zero rows — chaining .select() and checking the row count is the
        // only way to actually know the write landed (see CLAUDE.md).
        const { data: rows, error: updateError } = await supabase
          .from('orders')
          .update(updated)
          .eq('id', order.id)
          .select()

        if (updateError || !rows || rows.length === 0) {
          alert(updateError?.message || 'Address update did not save — no matching order row.')
          saveAddressBtn.disabled = false
          saveAddressBtn.textContent = 'Save Address'
          return
        }

        loadAdminOrders()
      })
    }

    const markShippedBtn = item.querySelector('.mark-shipped-btn')
    if (markShippedBtn) markShippedBtn.addEventListener('click', async () => {
      markShippedBtn.disabled = true
      const { error: updateError } = await supabase
        .from('orders')
        .update({ fulfilled_at: new Date().toISOString() })
        .eq('id', order.id)
      if (updateError) {
        alert(updateError.message)
        markShippedBtn.disabled = false
        return
      }
      // Shipped orders drop off this list — the row just disappears.
      loadAdminOrders()
    })

    listEl.appendChild(item)
  })
}

// Matches the maxlength on #upload-description / #edit-description in index.html.
// Enforced again here at render time so descriptions saved before this limit
// existed can't blow out the product card either.
const MAX_DESCRIPTION_LENGTH = 400

// Auto-fills a slug field from its title field until the admin edits the
// slug directly — same "don't fight what the user just typed" pattern as
// the printful-variant/size fields elsewhere in these forms.
// Uses a dataset flag rather than closure state because the edit form is a
// single persistent element reused across products (openEditModal resets
// the flag per product it loads) — a closure captured once at page load
// would never reflect "this particular product already has a slug".
function wireSlugAutofill(titleInputId, slugInputId) {
  const titleInput = document.getElementById(titleInputId)
  const slugInput = document.getElementById(slugInputId)
  slugInput.dataset.touched = slugInput.value.trim().length > 0 ? 'true' : 'false'

  slugInput.addEventListener('input', () => {
    slugInput.dataset.touched = slugInput.value.trim().length > 0 ? 'true' : 'false'
  })
  titleInput.addEventListener('input', () => {
    if (slugInput.dataset.touched !== 'true') slugInput.value = slugify(titleInput.value)
  })
}

const IMAGE_URL_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']

function isImageUrl(url) {
  if (!url) return false
  const clean = url.split('?')[0].toLowerCase()
  return IMAGE_URL_EXTENSIONS.some(ext => clean.endsWith(ext))
}

// Track naming (stripLeadingTrackNumber / cleanTrackTitle / PLAYER_ARTIST) and
// the per-track URL slugs live in ./tracks.js, shared with the build-time prerender.

// Escapes text for use inside HTML text and double-quoted attributes.
function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14z"/></svg>'
const PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4.2" height="15" rx="1"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1"/></svg>'
const PREV_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="2.4" height="14" rx="1"/><path d="M19 6.1v11.8a1 1 0 0 1-1.55.83L9.3 12.83a1 1 0 0 1 0-1.66l8.15-5.9A1 1 0 0 1 19 6.1z"/></svg>'
const NEXT_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="16.6" y="5" width="2.4" height="14" rx="1"/><path d="M5 6.1v11.8a1 1 0 0 0 1.55.83l8.15-5.9a1 1 0 0 0 0-1.66l-8.15-5.9A1 1 0 0 0 5 6.1z"/></svg>'

function computeProductFlags(product) {
  const isFree = (product.price_cents || 0) === 0
  const isSoldOut = product.inventory_count != null && product.inventory_count <= 0
  const isComingSoon = !!product.coming_soon
  const isService = product.category === 'services'
  const pricingMode = product.pricing_mode || 'standard'
  // Apparel and Printful items are always physical. If one has neither a
  // weight (self-ship) nor Printful IDs, checkout has no way to collect an
  // address or charge shipping — it would sell as if it were a download.
  // create-checkout-session refuses it too; this just keeps the button honest.
  const hasPrintfulMap = !!(product.printful_variant_map && Object.keys(product.printful_variant_map).length > 0)
  const isAlwaysPhysical = product.category === 'apparel' || isPrintfulCategory(product.category)
  const isUnavailable = isAlwaysPhysical && !(product.weight_oz > 0) && !hasPrintfulMap
  return { isFree, isSoldOut, isComingSoon, isService, isUnavailable, pricingMode, isInert: isSoldOut || isComingSoon || isUnavailable }
}

// Shared by both the grid card and the dedicated product page — they're the
// same product content at two different sizes/contexts, not two different
// templates. `linkTitle` wraps the title in a self-link to /products/<slug>/
// (the card needs that; a product already ON that page linking to itself
// doesn't), and `truncateDescription` is the card's small-tile-friendly cap
// that the dedicated page has no reason to apply.
function renderProductMarkup(product, flags, { linkTitle = true, truncateDescription = true, showBuyControls = true, showDescription = true, showFullGallery = true, showAudioPreview = true } = {}) {
  const { isFree, isInert, isComingSoon, isSoldOut, isUnavailable, isService, pricingMode } = flags
  // Pricing Mode overrides the plain price/service logic below it — those
  // only ever apply to pricingMode === 'standard', the default every
  // existing product already has.
  const formattedPrice =
    pricingMode === 'free' ? 'FREE' :
    isService ? (isFree ? 'Custom Pricing' : `Starting at $${(product.price_cents / 100).toFixed(2)}`) :
    pricingMode === 'offer_based' ? (product.offer_min_cents != null ? `From $${(product.offer_min_cents / 100).toFixed(2)}` : 'Name Your Price') :
    (isFree ? 'FREE' : `$${(product.price_cents / 100).toFixed(2)}`)
  const availableImages = productImages(product)

  // The card face only ever shows the first photo — flipping through the
  // rest is what the lightbox (opened by clicking it, still passed every
  // photo) is for. Only the dedicated product page gets the inline
  // prev/next arrows and counter.
  let galleryHTML = ''
  if (availableImages.length > 0) {
    galleryHTML = `
      <div class="image-gallery">
        <img src="${availableImages[0]}" alt="${product.title}" class="lightbox-trigger gallery-current-img" data-idx="0" loading="lazy" decoding="async">
        ${(showFullGallery && availableImages.length > 1) ? `
          <button type="button" class="gallery-arrow gallery-prev" aria-label="Previous photo">&#10094;</button>
          <button type="button" class="gallery-arrow gallery-next" aria-label="Next photo">&#10095;</button>
          <div class="gallery-counter">1 / ${availableImages.length}</div>
        ` : ''}
      </div>
    `
  } else {
    galleryHTML = `<div class="no-image">NO IMAGE</div>`
  }

  const descriptionText = (showDescription && product.description)
    ? (truncateDescription ? product.description.slice(0, MAX_DESCRIPTION_LENGTH) : product.description)
    : ''
  const descriptionHTML = descriptionText ? `<p class="description">${descriptionText}</p>` : ''

  // A Printful category product has no free-text Sizes field (grayed out
  // in the admin — redundant with the Printful IDs field, which already
  // keys each size), so its sizes are read from printful_variant_map's own
  // keys instead. 'default' means a sizeless single-variant product, not a
  // size choice.
  const isPrintfulProduct = isPrintfulCategory(product.category)
  const printfulSizeKeys = isPrintfulProduct && product.printful_variant_map
    ? Object.keys(product.printful_variant_map).filter(k => k !== 'default')
    : []
  const sizesHTML = isPrintfulProduct
    ? (printfulSizeKeys.length > 0 ? `<div class="sizes-container">${printfulSizeKeys.map(s => `<span class="size-tag">${s}</span>`).join('')}</div>` : '')
    : (product.sizes ? `<div class="sizes-container">${product.sizes.split(',').map(s => `<span class="size-tag">${s.trim()}</span>`).join('')}</div>` : '')

  // Card no longer plays audio at all — preview belongs on the product page.
  let audioHTML = ''
  const playableTracks = !showAudioPreview ? [] : getPlayableTracks(product)

  // Every play trigger carries what the player needs to show it: the song name,
  // the artist line, the album it belongs to, and the cover art — plus the URL
  // to share for it (a track's own page, or the product page for a single/album).
  const playerCover = product.cover_art_url || ''
  const playerAlbum = product.title || ''
  const triggerAttrs = (url, name, track, sharePath, trackSlug = '') =>
    `data-product-slug="${escapeHtmlText(product.slug || '')}" data-track-slug="${escapeHtmlText(trackSlug)}" data-url="${escapeHtmlText(url)}" data-title="${escapeHtmlText(track ? `${playerAlbum} — ${track}` : playerAlbum)}" data-name="${escapeHtmlText(name)}" data-sub="${escapeHtmlText(PLAYER_ARTIST)}" data-album="${escapeHtmlText(playerAlbum)}" data-cover="${escapeHtmlText(playerCover)}"` +
    (sharePath ? ` data-share-url="${escapeHtmlText(SITE_URL + sharePath)}"` : '')
  // A product with no slug has no page to link to, so it gets no share button.
  const shareBtn = (label, extraAttrs = '') => product.slug
    ? `<button type="button" class="share-btn" aria-label="${escapeHtmlText(label)}" ${extraAttrs}>${SHARE_ICON_SVG}</button>`
    : ''
  const productSharePath = product.slug ? productPath(product.slug) : ''

  if (playableTracks.length > 1) {
    audioHTML = `
      <div class="album-player-container">
        <div class="album-actions">
          <span class="album-label">Preview · ${playableTracks.length} tracks</span>
          <span class="album-actions-right">
            ${shareBtn(`Share ${playerAlbum}`, `data-share-url="${escapeHtmlText(SITE_URL + productSharePath)}" data-name="${escapeHtmlText(playerAlbum)}" data-album="" data-cover="${escapeHtmlText(playerCover)}"`)}
            <button type="button" class="card-play-btn album-big-play" aria-label="Play preview" ${triggerAttrs(playableTracks[0].url, playableTracks[0].name, playableTracks[0].title, '', playableTracks[0].slug)}>
              <span class="play-icon">${PLAY_ICON_SVG}</span>
            </button>
          </span>
        </div>
        <div class="tracklist-slider">
          <ul>
            ${playableTracks.map((track) => `
              <li class="track-item" ${triggerAttrs(track.url, track.name, track.title, product.slug ? trackPath(product.slug, track.slug) : '', track.slug)}>
                <span class="track-num"><span class="track-n">${track.trackNumber}</span><span class="track-eq"><i></i><i></i><i></i></span></span>
                <span class="track-meta"><span class="track-name">${escapeHtmlText(track.name)}</span><span class="track-artist">${escapeHtmlText(PLAYER_ARTIST)}</span></span>
                ${shareBtn(`Share ${track.name}`)}
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    `
  } else if (playableTracks.length === 1 || (showAudioPreview && isAudioUrl(product.audio_preview_url))) {
    const singleUrl = playableTracks.length === 1 ? playableTracks[0].url : product.audio_preview_url
    audioHTML = `
      <div class="single-actions">
        <button type="button" class="card-play-btn preview-pill" ${triggerAttrs(singleUrl, playerAlbum, '', productSharePath)}>
          <span class="play-icon">${PLAY_ICON_SVG}</span> Play Preview
        </button>
        ${shareBtn(`Share ${playerAlbum}`, `data-share-url="${escapeHtmlText(SITE_URL + productSharePath)}" data-name="${escapeHtmlText(playerAlbum)}" data-album="" data-cover="${escapeHtmlText(playerCover)}"`)}
      </div>
    `
  }

  const needsSize = pricingMode !== 'free' && !isInert && (
    (product.category === 'apparel' && product.sizes) ||
    (isPrintfulProduct && printfulSizeKeys.length > 0)
  )
  const sizeOptions = !needsSize ? [] : (
    isPrintfulProduct ? printfulSizeKeys : product.sizes.split(',').map(s => s.trim()).filter(Boolean)
  )
  // The card shows sizes as plain informational tags only (sizesHTML,
  // above) — the interactive picker and its price-upcharge hint are part
  // of the buy flow, so they only exist where showBuyControls is on.
  const sizeSelectHTML = (needsSize && showBuyControls)
    ? `<select class="card-size-select admin-input">
        <option value="" disabled selected>Select Size</option>
        ${sizeOptions.map(s => `<option value="${s}">${s}</option>`).join('')}
      </select>`
    : ''
  const upchargedSizes = sizeOptions.filter(isUpchargeSize)
  const sizeUpchargeHintHTML = (showBuyControls && upchargedSizes.length > 0)
    ? `<p style="font-size: 0.5rem; color: #e8b923; margin: 0.2rem 0 0 0;">+$${(SIZE_UPCHARGE_CENTS / 100).toFixed(0)} for ${upchargedSizes.join(', ')}</p>`
    : ''
  // Every service shows the same two thinner buttons regardless of pricing
  // mode — REQUEST A QUOTE (the existing quote-request inquiry, for pitching
  // details/asking questions before paying anything) and PAYMENT (opens an
  // amount-entry modal — no fixed price, nothing non-refundable; the admin
  // tells the customer what to pay off-site, they type that amount in).
  // There's no "Make an Offer"/"Reserve" branching here anymore —
  // pricing_mode stopped being a services UI switch once Payment became
  // unconditional (see create-product-payment-session).
  const buyButtonHTML = !showBuyControls ? '' : isService
    ? `<div style="display: flex; gap: 0.4rem; margin-top: 0.3rem;">
        <button class="service-message-btn" ${isInert ? 'disabled' : ''} style="flex: 1; padding: 0.5rem; background: transparent; color: ${isInert ? '#666' : '#00ffcc'}; border: 1px solid ${isInert ? '#444' : '#00ffcc'}; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: ${isInert ? 'not-allowed' : 'pointer'}; text-transform: uppercase;">Request A Quote</button>
        <button class="service-payment-btn" ${isInert ? 'disabled' : ''} style="flex: 1; padding: 0.5rem; background: ${isInert ? '#444' : '#00ffcc'}; color: ${isInert ? '#999' : '#111'}; border: none; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: ${isInert ? 'not-allowed' : 'pointer'}; text-transform: uppercase;">${isComingSoon ? 'Coming Soon' : 'Payment'}</button>
      </div>`
    : `<button class="buy-btn" ${isInert ? 'disabled' : ''} style="margin-top: 0.3rem; width: 100%; padding: 0.5rem; background: ${isInert ? '#444' : '#00ffcc'}; color: ${isInert ? '#999' : '#111'}; border: none; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: ${isInert ? 'not-allowed' : 'pointer'}; text-transform: uppercase;">
        ${isComingSoon ? 'Coming Soon' : (isSoldOut ? 'Sold Out' : (isUnavailable ? 'Unavailable' :
          (pricingMode === 'free' ? 'Get It Free' :
           pricingMode === 'offer_based' ? 'Pay What You Want' :
           (isFree ? 'Get It Free' : 'Add to Cart'))))}
      </button>`

  const titleInner = `<h3 style="margin: 0 0 0.15rem 0; font-size: 0.7rem; line-height: 1.2;">${product.title}</h3>`
  const titleHTML = (linkTitle && product.slug)
    ? `<a href="/products/${product.slug}/" class="product-title-link">${titleInner}</a>`
    : titleInner

  // This spacer exists to push whatever comes after it (player, buy button)
  // to the bottom of the card's flex column — with nothing to push, it's
  // just dead reserved space, which is exactly the leftover padding a
  // now-mostly-empty card (no description, no buy controls) doesn't need.
  const hasTrailingContent = !!(audioHTML || sizeSelectHTML || sizeUpchargeHintHTML || buyButtonHTML)
  const trailingSpacerHTML = hasTrailingContent ? `<div style="margin-top: auto;"></div>` : ''

  return `
    ${galleryHTML}
    ${titleHTML}
    <p class="price" style="margin: 0 0 0.15rem 0; font-size: 0.65rem;">${formattedPrice}</p>
    <p style="font-size: 0.5rem; letter-spacing: 1px; color: #aaa; margin: 0 0 0.2rem 0;">${(displayCategory(product.category) || 'UNCATEGORIZED').toUpperCase()}</p>
    ${descriptionHTML}
    ${sizesHTML}
    ${trailingSpacerHTML}
    ${audioHTML}
    ${sizeSelectHTML}
    ${sizeUpchargeHintHTML}
    ${buyButtonHTML}
  `
}

// Attaches every interaction a rendered product's markup needs (lightbox,
// gallery arrows, audio playback, buy/size-select) to whichever container
// holds it — a grid card or the dedicated product page — since both are
// built from the exact same renderProductMarkup output.
function wireProductInteractions(container, product, flags, { enableLightbox = true } = {}) {
  const { isFree, isInert, isService, pricingMode } = flags
  const availableImages = productImages(product)

  // The card disables this — clicking its (single, arrow-less) photo now
  // navigates to the product page instead of zooming, since the page is
  // where the full gallery/zoom actually lives.
  if (enableLightbox) {
    const images = container.querySelectorAll('.lightbox-trigger')
    images.forEach(img => {
      img.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-idx'))
        window.openLightbox(availableImages, idx)
      })
    })
  }

  const galleryImg = container.querySelector('.gallery-current-img')
  const galleryCounter = container.querySelector('.gallery-counter')
  const galleryPrevBtn = container.querySelector('.gallery-prev')
  const galleryNextBtn = container.querySelector('.gallery-next')
  if (galleryImg && (galleryPrevBtn || galleryNextBtn)) {
    const showGalleryImage = (idx) => {
      galleryImg.src = availableImages[idx]
      galleryImg.setAttribute('data-idx', idx)
      if (galleryCounter) galleryCounter.textContent = `${idx + 1} / ${availableImages.length}`
    }
    galleryPrevBtn.addEventListener('click', () => {
      const current = parseInt(galleryImg.getAttribute('data-idx'))
      showGalleryImage((current - 1 + availableImages.length) % availableImages.length)
    })
    galleryNextBtn.addEventListener('click', () => {
      const current = parseInt(galleryImg.getAttribute('data-idx'))
      showGalleryImage((current + 1) % availableImages.length)
    })
  }

  // audio-vault is a private bucket — the stored URL on data-url is no
  // longer directly playable, so a fresh short-lived signed URL is fetched
  // right before playback instead of ever exposing a permanent public link.
  const playTriggers = container.querySelectorAll('.card-play-btn, .track-item')
  playTriggers.forEach(trigger => {
    trigger.addEventListener('click', async () => {
      // The album's big round play button drives the track rows (so the
      // highlighted row, the mini-player and prev/next all stay in sync):
      // it pauses/resumes if this album is already playing, else starts track 1.
      if (trigger.classList.contains('album-big-play')) {
        const rows = [...trigger.closest('.album-player-container').querySelectorAll('.track-item')]
        if (currentTrack && rows.some(r => r.dataset.url === currentTrack.url)) toggleGlobalPlayback()
        else if (rows[0]) rows[0].click()
        return
      }
      // Tapping the track that's already loaded pauses/resumes it instead of
      // restarting it from the top.
      if (currentTrack && currentTrack.url === trigger.dataset.url && globalAudio.src && !globalAudio.error) {
        toggleGlobalPlayback()
        return
      }
      // Plain opacity dimming, not a text-content swap — these triggers
      // contain a styled child <span> icon, and setting .textContent to
      // "restore" it afterward would flatten that markup permanently.
      if (trigger.dataset.loading === 'true') return
      trigger.dataset.loading = 'true'
      trigger.style.opacity = '0.6'

      try {
        // A track row plays within its album's list, so next/previous and
        // auto-advance walk the whole tracklist.
        const album = trigger.classList.contains('track-item') ? trigger.closest('.album-player-container') : null
        const queue = album ? [...album.querySelectorAll('.track-item')].map(metaFromEl) : [metaFromEl(trigger)]
        await startTrack(metaFromEl(trigger), queue)
      } catch (err) {
        console.error('Failed to get playback URL:', err)
      } finally {
        trigger.dataset.loading = 'false'
        trigger.style.opacity = ''
      }
    })
  })
  // A freshly rendered page may contain the track that's already playing.
  refreshPlayStateUI()

  // Share buttons: one inside a track row shares that song (its row carries
  // the data), a standalone one carries its own. stopPropagation keeps the
  // click from also starting playback on the row underneath it.
  container.querySelectorAll('.share-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const src = btn.closest('.track-item') || btn
      openShareMenu({ url: src.dataset.shareUrl, name: src.dataset.name, album: src.dataset.album, cover: src.dataset.cover })
    })
  })

  // Services get their own two-button wiring — REQUEST A QUOTE always opens the
  // quote-request inquiry, PAYMENT always starts the flat $25 deposit
  // checkout, regardless of pricing_mode (see renderProductMarkup above).
  if (isService) {
    const messageBtn = container.querySelector('.service-message-btn')
    const paymentBtn = container.querySelector('.service-payment-btn')
    if (messageBtn) {
      messageBtn.addEventListener('click', () => {
        if (isInert) return
        openServiceInquiryModal(product)
      })
    }
    if (paymentBtn) {
      paymentBtn.addEventListener('click', () => {
        if (isInert) return
        openReserveModal(product)
      })
    }
    return
  }

  const buyButton = container.querySelector('.buy-btn')
  const sizeSelect = container.querySelector('.card-size-select')
  if (!buyButton) return
  buyButton.addEventListener('click', () => {
    if (isInert) {
      return
    } else if (pricingMode === 'free') {
      openFreeDownloadModal(product)
      return
    } else if (pricingMode === 'offer_based') {
      let size = null
      if (sizeSelect) {
        size = sizeSelect.value
        if (!size) {
          sizeSelect.style.borderColor = '#ff4d4d'
          return
        }
      }
      openOfferModal(product, size)
      return
    } else if (isFree) {
      openFreeDownloadModal(product)
      return
    }

    let size = null
    if (sizeSelect) {
      size = sizeSelect.value
      if (!size) {
        sizeSelect.style.borderColor = '#ff4d4d'
        return
      }
    }

    addToCart(product, { size })
    updateCartBadge()
    const originalLabel = buyButton.textContent
    buyButton.textContent = 'Added ✓'
    setTimeout(() => { buyButton.textContent = originalLabel }, 1200)
  })
}

function extractStoragePath(url, bucket) {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(url.slice(idx + marker.length))
}

function isAudioFile(file) {
  return file.type.startsWith('audio/')
}

// Derives fileUrl/downloadFiles/tracklistSnippets from a list of {name, url}
// digital files already sitting in Storage — the same tail logic
// processDigitalFiles uses for a freshly uploaded batch, factored out so the
// edit form's save handler can run it again over kept-files-plus-new-uploads
// combined, instead of only ever looking at whatever was newly picked (see
// the edit form's own digital-file section below). Audio detection reads
// the URL's real extension rather than `name`, since a kept file sourced
// from tracklist_snippets has its track title (no extension) as `name`.
function deriveDigitalFileFields(items) {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  if (sorted.length === 0) return { fileUrl: null, downloadFiles: null, tracklistSnippets: null }

  const audioTracks = []
  sorted.forEach(f => {
    if (isAudioUrl(f.url)) {
      audioTracks.push({ trackNumber: audioTracks.length + 1, title: (f.name || '').replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?)$/i, ''), url: f.url })
    }
  })

  let fileUrl = sorted[0].url
  if (audioTracks.length === 1) fileUrl = audioTracks[0].url

  return { fileUrl, downloadFiles: sorted, tracklistSnippets: audioTracks.length > 1 ? audioTracks : null }
}

async function uploadToVault(file) {
  const path = `${Date.now()}-${file.name}`
  // Same fix as processImageFiles below — without this, every signed
  // playback/download URL serves with Cache-Control: no-cache.
  const { error } = await supabase.storage.from('audio-vault').upload(path, file, { cacheControl: '2592000' })
  if (error) throw error
  const { data } = supabase.storage.from('audio-vault').getPublicUrl(path)
  return { url: data.publicUrl, path }
}

// Uploads whatever digital files (audio, PDF, image, etc.) are currently
// selected in the given file input. Every file — one or many, audio or not —
// is uploaded individually and never bundled into a zip here: a combined zip
// for an 11-track album can exceed Storage's per-file size cap, while each
// individual file comfortably stays under it. The zip a buyer actually
// receives is assembled on demand at download time (see secure-download /
// free-download) from these same individual files.
//
// Returns:
//   fileUrl          - an audio file's URL if one was uploaded (so the
//                       storefront's single-track player can find it),
//                       otherwise the first file's URL
//   filePaths        - every file's storage path, for Generate/Stripe to tag
//   downloadFiles    - {name, url} for every file, saved on the product so
//                       free-download (which has no Stripe session to read
//                       metadata from) knows what to zip
//   tracklistSnippets - built from whichever uploaded files are audio, even
//                       when non-audio files (cover art, tracklist images)
//                       are bundled alongside them; populated only when 2+
//                       audio files are present, for the storefront's
//                       multi-track preview player
async function processDigitalFiles(inputFiles) {
  // The browser's file picker can hand back a multi-select in click order
  // rather than filename order, which would otherwise number tracks in
  // whatever order they happened to be selected. Sort by filename first
  // (numeric-aware, so "2 - Song.mp3" sorts before "10 - Song.mp3") so
  // track numbering follows the filenames instead. Takes an explicit
  // File[] (from an accumulator, see uploadNewDigitalFiles /
  // editNewDigitalFiles below) rather than reading a file input directly —
  // same reasoning as processImageFiles: the input's FileList gets replaced,
  // not appended to, every time the picker reopens.
  const files = [...inputFiles]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))

  if (files.length === 0) {
    return { fileUrl: null, filePaths: [], downloadFiles: null, tracklistSnippets: null }
  }

  const filePaths = []
  const downloadFiles = []
  const audioTracks = []
  let fileUrl = null

  for (let i = 0; i < files.length; i++) {
    const { url, path } = await uploadToVault(files[i])
    if (i === 0) fileUrl = url
    filePaths.push(path)
    downloadFiles.push({ name: files[i].name, url })
    if (isAudioFile(files[i])) {
      audioTracks.push({
        trackNumber: audioTracks.length + 1,
        title: files[i].name.replace(/\.[^/.]+$/, ''),
        url
      })
    }
  }

  if (audioTracks.length === 1) fileUrl = audioTracks[0].url
  const tracklistSnippets = audioTracks.length > 1 ? audioTracks : null

  return { fileUrl, filePaths, downloadFiles, tracklistSnippets }
}

// Uploads a set of image Files to bodega-images. The first becomes the
// product's main/cover photo; the rest become the scrollable gallery. Takes
// an explicit File[] (from an accumulator, see uploadNewImageFiles /
// editNewImageFiles below) rather than reading a file input directly — a
// native <input type="file" multiple> replaces its whole selection every
// time the picker reopens, so reading it directly would silently drop
// anything picked in an earlier batch.
// Raw phone/camera uploads were 2-8 MB each and every storefront visit pulled
// all of them — this is what tripped Supabase's Cached Egress quota (2026-10).
// Downscales to MAX_PRODUCT_IMAGE_PX on the longest side and re-encodes as
// WebP (keeps alpha, unlike JPEG). Falls back to the original file if the
// browser can't decode/encode it, or if re-encoding wouldn't actually be smaller.
const MAX_PRODUCT_IMAGE_PX = 1000
async function compressProductImage(file, maxPx = MAX_PRODUCT_IMAGE_PX) {
  try {
    if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.74))
    if (!blob || blob.type !== 'image/webp' || blob.size >= file.size) return file
    const safeName = file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'image'
    return new File([blob], `${safeName}.webp`, { type: 'image/webp' })
  } catch {
    return file
  }
}

async function processImageFiles(files) {
  if (files.length === 0) {
    return { coverUrl: null, galleryImages: null }
  }

  const urls = []
  for (const original of files) {
    const file = await compressProductImage(original)
    const path = `${Date.now()}-${file.name}`
    // Without an explicit cacheControl, this bucket was serving every object
    // with `Cache-Control: no-cache` (confirmed live via response headers on
    // existing uploads) — every visitor re-fetches every product photo from
    // Supabase's origin on every page view instead of the CDN/browser
    // caching it. 30 days is safe since a product photo's URL changes (new
    // timestamp prefix) whenever it's actually replaced.
    const { error } = await supabase.storage.from('bodega-images').upload(path, file, { cacheControl: '2592000' })
    if (error) throw error
    const { data } = supabase.storage.from('bodega-images').getPublicUrl(path)
    urls.push(data.publicUrl)
  }

  return { coverUrl: urls[0], galleryImages: urls.length > 1 ? urls.slice(1) : null }
}

async function deleteProduct(product) {
  const confirmed = window.confirm(`Delete "${product.title || 'this product'}"? This cannot be undone.`)
  if (!confirmed) return

  const { error } = await supabase.from('products').delete().eq('id', product.id)
  if (error) {
    alert(error.message)
    return
  }

  try {
    const imagePaths = [
      product.cover_art_url,
      product.image_2_url,
      product.image_3_url,
      ...(Array.isArray(product.gallery_images) ? product.gallery_images : [])
    ]
      .map(url => extractStoragePath(url, 'bodega-images'))
      .filter(Boolean)
    if (imagePaths.length > 0) {
      await supabase.storage.from('bodega-images').remove(imagePaths)
    }

    const audioPaths = [
      extractStoragePath(product.audio_preview_url, 'audio-vault'),
      ...(Array.isArray(product.tracklist_snippets)
        ? product.tracklist_snippets.map(track => extractStoragePath(track.url, 'audio-vault'))
        : []),
      ...(Array.isArray(product.download_files)
        ? product.download_files.map(f => extractStoragePath(f.url, 'audio-vault'))
        : [])
    ].filter(Boolean)
    if (audioPaths.length > 0) {
      await supabase.storage.from('audio-vault').remove(audioPaths)
    }
  } catch (err) {
    console.error('Failed to clean up storage files for deleted product:', err)
  }

  loadAdminInventory()
  loadBodega()
}

// Sizes only make sense for apparel. Weight/shipping applies to apparel too,
// but also art, music (CDs/vinyl), and pancho picks — any of those can be a
// physical item (ships, needs a weight) or a pure digital download
// depending on the individual product.
const SHIPPABLE_CATEGORIES = ['apparel', 'art', 'music', 'pancho picks']

// Printful categories (fields for them: Printful IDs; not: the free-text
// Sizes box, self-ship Package Weight — sizes come from the Printful IDs'
// own S:/M:/L: keys, and Printful quotes shipping itself, no weight
// needed), but each still needs to show up under the storefront category a
// customer would actually browse for it — a fulfillment method isn't
// something customers filter by, so 'printful-apparel'/'printful-picks'
// exist specifically to file into the Apparel/Pancho Picks filter tabs
// (see displayCategory) while still getting all of Printful's admin-form
// behavior. Plain 'printful' (pre-split) is kept recognized here too, for
// any existing row still using it — it just won't match a filter tab.
function isPrintfulCategory(categoryValue) {
  return categoryValue === 'printful' || categoryValue === 'printful-apparel' || categoryValue === 'printful-picks'
}

// The customer-facing category a product should be filed/labeled under —
// a Printful category is an admin-only fulfillment distinction, not
// something a customer browses by, so it's shown and filtered as its real
// category (Apparel or Pancho Picks) everywhere the storefront renders or
// filters by category. loadAdminInventory deliberately does NOT use this —
// the admin should see the real stored category, not the customer-facing one.
function displayCategory(categoryValue) {
  if (categoryValue === 'printful-apparel') return 'apparel'
  if (categoryValue === 'printful-picks') return 'pancho picks'
  return categoryValue
}

// It's still a shippable, Printful-fulfillable category like the others —
// this just adds it to that check without folding it into
// SHIPPABLE_CATEGORIES itself, since that list specifically means "this
// category still needs the self-ship Package Weight field."
function canUsePrintful(categoryValue) {
  return SHIPPABLE_CATEGORIES.includes(categoryValue) || isPrintfulCategory(categoryValue)
}

function updateSizesVisibility(categoryValue, pricingMode, groupId) {
  const show = categoryValue === 'apparel' && pricingMode !== 'free'
  document.getElementById(groupId).style.display = show ? 'block' : 'none'
}

function updateWeightVisibility(categoryValue, pricingMode, groupId) {
  // Excludes 'printful' deliberately — that category ships via Printful's
  // own rate quoting, keyed off its variant IDs, never a self-ship weight.
  const show = SHIPPABLE_CATEGORIES.includes(categoryValue) && pricingMode !== 'free'
  document.getElementById(groupId).style.display = show ? 'block' : 'none'
}

function updatePrintfulVisibility(categoryValue, pricingMode, groupId) {
  const show = canUsePrintful(categoryValue) && pricingMode !== 'free'
  document.getElementById(groupId).style.display = show ? 'block' : 'none'
}

// Pricing Mode (see the products.pricing_mode migration) governs how a
// price is determined, and combined with category, which fields are even
// relevant: Free never ships or tracks inventory or needs a generated
// Stripe Checkout ID (it skips Stripe entirely), Offer Based replaces the
// fixed price with buyer-chosen bounds. Services ignore pricing_mode
// entirely on the storefront now — every service product page always shows
// the same REQUEST A QUOTE + PAYMENT buttons (see renderProductMarkup/
// wireProductInteractions) — PAYMENT opens an amount-entry modal, no fixed
// price of its own, which is what retired the old services-only Reserve
// mode (2026-09-13). Offer Based is disabled for Services for the same
// reason: there's no UI left on a service page that would ever read its
// bounds. Price still matters for a service, just as *display* only —
// "Starting at $X" for a service with a real base rate (e.g. a performance),
// or leave it at $0 for one that's too varied to quote a number for (e.g. a
// website build) — it shows "Custom Pricing" instead. Either way REQUEST A QUOTE
// and PAYMENT behave identically; Price never drives their behavior.
function updatePricingModeUI(prefix) {
  const category = document.getElementById(`${prefix}-category`).value
  const pricingModeSelect = document.getElementById(`${prefix}-pricing-mode`)
  const offerBasedOption = pricingModeSelect.querySelector('option[value="offer_based"]')
  const isServices = category === 'services'

  offerBasedOption.disabled = isServices
  const priceInput = document.getElementById(`${prefix}-price`)
  if (isServices && pricingModeSelect.value === 'offer_based') {
    pricingModeSelect.value = 'standard'
  }
  const pricingMode = pricingModeSelect.value
  const offerGroup = document.getElementById(`${prefix}-offer-bounds-group`)
  const inventoryGroup = document.getElementById(`${prefix}-inventory-group`)
  const stripeSection = document.getElementById(`${prefix}-stripe-section`)

  priceInput.style.display = pricingMode === 'offer_based' ? 'none' : 'block'
  priceInput.required = pricingMode !== 'offer_based'
  offerGroup.style.display = pricingMode === 'offer_based' ? 'block' : 'none'

  if (pricingMode === 'free') {
    priceInput.value = '0'
    priceInput.disabled = true
  } else {
    priceInput.disabled = false
  }

  if (pricingMode === 'offer_based') {
    // Default the floor to $1, not $0 — a blank/zero Minimum Offer would
    // make Offer Based behave like a second way to spell Free (see the
    // isFree check above), which defeats the point of Free being its own
    // deliberate choice. Only fills it when empty, so it never clobbers a
    // real value already typed or loaded from an existing product.
    const offerMinInput = document.getElementById(`${prefix}-offer-min`)
    if (!offerMinInput.value) offerMinInput.value = '1.00'
  }

  // A standard-mode product priced at $0 is functionally the same as
  // pricing_mode 'free' everywhere it matters — both trigger the
  // storefront's free-download flow (see the isFree check in
  // loadAdminInventory) — so both should hide the same now-irrelevant
  // fields here too, not just an explicit 'free' selection.
  const isFree = pricingMode === 'free' || (pricingMode === 'standard' && (parseFloat(priceInput.value) || 0) === 0)
  const hideForMode = isServices || isFree
  inventoryGroup.style.display = hideForMode ? 'none' : 'block'
  stripeSection.style.display = hideForMode ? 'none' : 'block'

  updateSizesVisibility(category, pricingMode, `${prefix}-sizes-group`)
  updateWeightVisibility(category, pricingMode, `${prefix}-weight-group`)
  updatePrintfulVisibility(category, pricingMode, `${prefix}-printful-group`)
}

// Reads price_cents/pricing_mode/offer bounds together since they're
// interdependent: what price_cents even means depends on pricing_mode, so
// they have to be derived as one unit rather than three independent reads.
function readPricingModeFields(prefix, rawPrice) {
  const pricingMode = document.getElementById(`${prefix}-pricing-mode`).value || 'standard'
  let priceCents = Math.round((rawPrice || 0) * 100)
  let offerMinCents = null
  let offerMaxCents = null

  if (pricingMode === 'free') {
    priceCents = 0
  } else if (pricingMode === 'offer_based') {
    priceCents = 0
    const minRaw = parseFloat(document.getElementById(`${prefix}-offer-min`).value)
    const maxRaw = parseFloat(document.getElementById(`${prefix}-offer-max`).value)
    offerMinCents = Number.isFinite(minRaw) ? Math.round(minRaw * 100) : null
    offerMaxCents = Number.isFinite(maxRaw) ? Math.round(maxRaw * 100) : null
  }

  return { pricingMode, priceCents, offerMinCents, offerMaxCents }
}

// Parses the admin's "S:12345:67890, M:12346:67891" (or a bare
// "variantId:syncVariantId" for a sizeless product) into the
// {size: {variantId, syncVariantId}} shape saved on the product. Two ids per
// size because Printful's shipping-rate API and order-submission API each
// require a different one (confirmed against the live API) — variantId is
// the catalog variant, syncVariantId is the store's synced product variant
// tied to the actual uploaded artwork. Returns null for blank input so it's
// easy to clear the mapping.
function parsePrintfulVariantMap(input) {
  const trimmed = (input || '').trim()
  if (!trimmed) return null

  function parsePair(str) {
    const [variantIdRaw, syncVariantIdRaw] = str.split(':').map(s => (s || '').trim())
    const variantId = parseInt(variantIdRaw, 10)
    const syncVariantId = parseInt(syncVariantIdRaw, 10)
    return (!isNaN(variantId) && !isNaN(syncVariantId)) ? { variantId, syncVariantId } : null
  }

  if (!trimmed.includes(',')) {
    const parts = trimmed.split(':')
    if (parts.length === 2) {
      const pair = parsePair(trimmed)
      return pair ? { default: pair } : null
    }
  }

  const map = {}
  trimmed.split(',').forEach(entry => {
    const parts = entry.split(':').map(s => (s || '').trim())
    if (parts.length !== 3) return
    const [size, variantIdRaw, syncVariantIdRaw] = parts
    const pair = parsePair(`${variantIdRaw}:${syncVariantIdRaw}`)
    if (size && pair) map[size] = pair
  })
  return Object.keys(map).length > 0 ? map : null
}

// The inverse of parsePrintfulVariantMap, for populating the edit form.
function formatPrintfulVariantMap(map) {
  if (!map || typeof map !== 'object') return ''
  const entries = Object.entries(map)
  if (entries.length === 1 && entries[0][0] === 'default') {
    const v = entries[0][1]
    return `${v.variantId}:${v.syncVariantId}`
  }
  return entries.map(([size, v]) => `${size}:${v.variantId}:${v.syncVariantId}`).join(', ')
}

let featuredFullResolver = null

// Reused for both Featured and Spotlight — same "pick one of these N to
// bump" shape either way, just different copy per slot.
function openFeaturedFullModal(products, { title, subtitle }) {
  document.getElementById('featured-full-title').textContent = title
  document.getElementById('featured-full-subtitle').textContent = subtitle
  const listEl = document.getElementById('featured-full-list')
  listEl.innerHTML = products.map(p => `
    <button type="button" class="admin-btn featured-full-pick-btn" data-id="${p.id}" style="display: block; width: 100%; margin-bottom: 0.5rem; text-align: left;">${p.title}</button>
  `).join('')
  listEl.querySelectorAll('.featured-full-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      closeFeaturedFullModal()
      if (featuredFullResolver) featuredFullResolver(id)
    })
  })
  document.getElementById('featured-full-modal').style.display = 'flex'
}

function closeFeaturedFullModal() {
  document.getElementById('featured-full-modal').style.display = 'none'
}

function initFeaturedFullModal() {
  const modal = document.getElementById('featured-full-modal')
  if (!modal) return
  const cancel = () => {
    closeFeaturedFullModal()
    if (featuredFullResolver) featuredFullResolver(null)
  }
  document.getElementById('featured-full-cancel-btn').addEventListener('click', cancel)
  modal.addEventListener('click', (e) => { if (e.target === modal) cancel() })
}

// Admin reference tool for the Printful IDs field — Printful's own
// dashboard doesn't reliably surface the plain numeric IDs its API
// actually needs (confirmed live: the variant row shows a hashed
// reference, not the integer id), so this calls printful-variant-lookup
// (which does hit the real API) and lets the admin fill the field with
// one click instead of hunting for the numbers by hand.
let printfulLookupTargetId = null

function openPrintfulLookupModal(targetInputId) {
  printfulLookupTargetId = targetInputId
  document.getElementById('printful-lookup-list').innerHTML = '<p class="field-hint">Loading your synced Printful products...</p>'
  document.getElementById('printful-lookup-modal').style.display = 'flex'
  loadPrintfulLookupList()
}

function closePrintfulLookupModal() {
  document.getElementById('printful-lookup-modal').style.display = 'none'
}

function renderPrintfulLookupList(products) {
  const listEl = document.getElementById('printful-lookup-list')

  if (products.length === 0) {
    listEl.innerHTML = '<p class="field-hint">No products synced to Printful yet.</p>'
    return
  }

  listEl.innerHTML = products.map((p, idx) => `
    <div class="tip-row">
      <div class="tip-row-meta">
        <strong style="color: #ccc;">${p.name}</strong>
        <br><span style="font-size: 0.6rem; color: #888;">${p.formatted || 'No variants found'}</span>
      </div>
      ${p.formatted ? `<button type="button" class="admin-btn admin-btn-small printful-use-btn" data-idx="${idx}">Use This</button>` : ''}
    </div>
  `).join('')

  listEl.querySelectorAll('.printful-use-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const product = products[parseInt(btn.getAttribute('data-idx'), 10)]
      if (printfulLookupTargetId && product?.formatted) {
        document.getElementById(printfulLookupTargetId).value = product.formatted
      }
      closePrintfulLookupModal()
    })
  })
}

async function loadPrintfulLookupList() {
  const listEl = document.getElementById('printful-lookup-list')
  try {
    const { data, error } = await supabase.functions.invoke('printful-variant-lookup')
    if (error) throw error
    renderPrintfulLookupList(data?.products || [])
  } catch (err) {
    listEl.innerHTML = `<p class="field-hint" style="color: #ff4d4d;">${await describeFunctionError(err)}</p>`
  }
}

function initPrintfulLookupModal() {
  const modal = document.getElementById('printful-lookup-modal')
  if (!modal) return
  document.getElementById('printful-lookup-cancel-btn').addEventListener('click', closePrintfulLookupModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closePrintfulLookupModal() })
  document.getElementById('upload-printful-lookup-btn').addEventListener('click', () => openPrintfulLookupModal('upload-printful-variants'))
  document.getElementById('edit-printful-lookup-btn').addEventListener('click', () => openPrintfulLookupModal('edit-printful-variants'))
}

// Resolves to the id of the product the admin chose to bump, or null if
// they cancelled (resolveLandingSlot falls back to the old hard error in
// that case, so cancelling never silently proceeds). Shared by Featured and
// Spotlight — same "pick one of N to replace" shape either way.
function pickSlotToReplace(products, copy) {
  return new Promise((resolve) => {
    featuredFullResolver = resolve
    openFeaturedFullModal(products, copy)
  })
}

// Featured and Spotlight each hold up to this many products at once — the
// DB can't express "at most N", so each is checked here (resolveLandingSlot)
// and mirrored at render time (landingFeatured/landingSpotlight in the
// landing-page section) capping how many are ever pulled in, so the two
// stay in sync. Keyed by slot value so resolveLandingSlot can look either
// up generically instead of branching per slot name.
const MULTI_SLOT_CAPS = { featured: 6, spotlight: 4 }
const MAX_FEATURED_PRODUCTS = MULTI_SLOT_CAPS.featured
const MAX_SPOTLIGHT_PRODUCTS = MULTI_SLOT_CAPS.spotlight

// Validates the landing-page slot picked in an admin form against what's
// already slotted. The two single-occupancy slots are enforced by a unique
// index, so the previous holder is demoted first rather than letting the
// insert fail on a constraint the admin can't see. productId is null when
// creating a new product.
async function resolveLandingSlot(selectId, productId) {
  const slot = document.getElementById(selectId).value || null
  if (!slot) return null

  const { data: slotted, error } = await supabase
    .from('products')
    .select('id, title, landing_slot')
    .eq('landing_slot', slot)
  if (error) throw error

  const others = (slotted || []).filter(p => p.id !== productId)

  const cap = MULTI_SLOT_CAPS[slot]
  if (cap) {
    if (others.length >= cap) {
      const slotLabel = slot === 'featured' ? 'Featured' : 'Spotlight'
      // Unlike the single-occupancy slots below, there's no one obvious
      // product to bump — ask which one to replace instead of just
      // erroring, since guessing (oldest? last in the list?) would surprise
      // the admin either way.
      const toReplaceId = await pickSlotToReplace(others, {
        title: `${slotLabel} Is Full`,
        subtitle: `${slotLabel} only holds ${cap} at a time. Pick one to replace:`,
      })
      if (!toReplaceId) {
        throw new Error(`Already ${cap} ${slotLabel.toLowerCase()} products (${others.map(p => p.title).join(', ')}). Clear one first.`)
      }
      // .update() under RLS returns { error: null } even when zero rows
      // matched — chaining .select() and checking the result is the only
      // way to actually know the clear happened.
      const { data: cleared, error: clearError } = await supabase
        .from('products')
        .update({ landing_slot: null })
        .eq('id', toReplaceId)
        .select()
      if (clearError) throw clearError
      if (!cleared || cleared.length === 0) throw new Error(`Failed to clear the replaced product's ${slotLabel} slot — try again.`)
    }
    return slot
  }

  // Latest Release / Panchos Pick: only one product may hold each.
  if (others.length > 0) {
    const { data: cleared, error: clearError } = await supabase
      .from('products')
      .update({ landing_slot: null })
      .in('id', others.map(p => p.id))
      .select()
    if (clearError) throw clearError
    if (!cleared || cleared.length !== others.length) throw new Error('Failed to clear the previous slot holder — try again.')
  }

  return slot
}

// Newly picked-but-not-yet-uploaded photos for each form, kept as our own
// accumulator instead of trusting the file input directly — a native
// <input type="file" multiple> replaces its entire FileList every time the
// picker reopens, so picking photos in two separate batches would silently
// drop the first batch if we read straight from the input at submit time.
let uploadNewImageFiles = []
let editNewImageFiles = []

// Renders thumbnails for an accumulator array of newly-picked Files, each
// with a remove button so a bad pick can be dropped before upload.
function renderPickedImagesPreview(files, previewEl) {
  previewEl.innerHTML = files.map((file, idx) => `
    <div class="admin-image-thumb">
      <img src="${URL.createObjectURL(file)}" alt="${file.name}">
      <button type="button" class="admin-image-remove-btn" data-idx="${idx}" aria-label="Remove photo">&times;</button>
    </div>
  `).join('')
}

// Same accumulator pattern as uploadNewImageFiles, for the digital-file
// input — so a wrong file (e.g. accidentally attaching a digital download
// to what should be a physical/Printful product) can be spotted and
// removed before deploying, not just discovered after.
let uploadNewDigitalFiles = []
let editNewDigitalFiles = []

function renderPickedFilesPreview(files, previewEl) {
  previewEl.innerHTML = files.map((file, idx) => `
    <div class="admin-file-chip">
      <span class="admin-file-chip-name">${file.name}</span>
      <button type="button" class="admin-file-remove-btn" data-idx="${idx}" aria-label="Remove file">&times;</button>
    </div>
  `).join('')
}

// The edit form's existing-photo thumbnails, each with a remove button —
// separate from renderPickedImagesPreview's newly-picked-file preview so
// newly added photos never clobber this list. Saving combines whatever's
// left here with any newly selected files, so editing photos is additive
// (add more, remove individual ones) instead of replace-the-whole-set.
let editKeptImages = []

// The edit form's existing-digital-file chips, mirroring editKeptImages —
// picking new files used to fully replace whatever was here (a real
// incident: adding two cover images wiped an 11-track album's audio files),
// so this is now kept/editable state combined with any new uploads at save
// time, the same additive pattern the photo picker already uses.
let editKeptDigitalFiles = []

// Normalizes whichever shape a product's digital files are currently in
// (a track album's tracklist_snippets, a multi-file download_files bundle,
// or one legacy audio_preview_url) into one list, so the edit form can show
// what's actually attached — filename and, if it's an image, a thumbnail —
// instead of a vague count. This is exactly what would have caught a photo
// accidentally uploaded as a "digital file" instead of a product photo
// (see the Printful category note below): the thumbnail alone makes an
// image sitting where an audio/PDF file should be immediately obvious.
function currentDigitalFileList(product) {
  // download_files is the complete bundle a buyer receives (songs AND cover/
  // tracklist images); tracklist_snippets is only its songs. It used to read
  // tracklist_snippets first, so an album's list showed songs only and saving
  // the edit form silently dropped the cover + tracklist from the bundle.
  // Anything that exists only in tracklist_snippets (legacy rows) is still added.
  const bundle = Array.isArray(product.download_files)
    ? product.download_files.map(f => ({ url: f.url, name: f.name || f.url }))
    : []
  if (Array.isArray(product.tracklist_snippets) && product.tracklist_snippets.length > 0) {
    const have = new Set(bundle.map(f => f.url))
    product.tracklist_snippets.forEach(t => {
      if (!have.has(t.url)) bundle.push({ url: t.url, name: t.title || t.url })
    })
  }
  if (bundle.length > 0) return bundle
  if (product.audio_preview_url) {
    const name = decodeURIComponent((product.audio_preview_url.split('/').pop() || product.audio_preview_url).replace(/^\d+-/, ''))
    return [{ url: product.audio_preview_url, name }]
  }
  return []
}

// Renders editKeptDigitalFiles (not the product directly — see the
// comment on that variable) with a remove button per chip, same pattern as
// renderEditImagePreview. audio-vault is a private bucket (see
// get-playback-url), so a plain public URL to an image inside it 404s
// straight from Storage ("Bucket not found") — chips render immediately
// with no image, then each thumbnail's real short-lived signed URL is
// fetched in the background and swapped in, the same signing
// get-playback-url already does for track playback.
function renderEditCurrentFilesPreview() {
  const previewEl = document.getElementById('edit-file-current-preview')
  const files = editKeptDigitalFiles
  if (files.length === 0) {
    previewEl.innerHTML = '<p class="field-hint">No digital file attached.</p>'
    return
  }
  previewEl.innerHTML = files.map((f, idx) => `
    <div class="admin-file-chip">
      ${isImageUrl(f.url) ? `<img data-thumb-idx="${idx}" alt="" style="width: 22px; height: 22px; object-fit: cover; border-radius: 3px; margin-right: 0.4rem; vertical-align: middle; background: #333;">` : ''}
      <span class="admin-file-chip-name">${f.name}</span>
      <button type="button" class="admin-file-remove-btn" data-idx="${idx}" aria-label="Remove file">&times;</button>
    </div>
  `).join('')

  files.forEach(async (f, idx) => {
    if (!isImageUrl(f.url)) return
    const img = previewEl.querySelector(`img[data-thumb-idx="${idx}"]`)
    if (!img) return
    try {
      const { data, error } = await supabase.functions.invoke('get-playback-url', { body: { url: f.url } })
      if (error || !data?.url) throw error || new Error('No signed URL returned.')
      img.src = data.url
    } catch (err) {
      console.error('Failed to load digital file thumbnail:', err)
    }
  })
}

function renderEditImagePreview() {
  const previewEl = document.getElementById('edit-image-preview')
  previewEl.innerHTML = editKeptImages.map((url, idx) => `
    <div class="admin-image-thumb">
      <img src="${url}" alt="">
      <button type="button" class="admin-image-remove-btn" data-idx="${idx}" aria-label="Remove photo">&times;</button>
    </div>
  `).join('')
  document.getElementById('edit-image-current-info').textContent = editKeptImages.length > 0
    ? `Currently: ${editKeptImages.length} photo${editKeptImages.length === 1 ? '' : 's'}`
    : 'Currently: no photos'
}

function openEditModal(product) {
  editingProduct = product
  document.getElementById('edit-id').value = product.id
  document.getElementById('edit-title').value = product.title || ''
  const editSlugInput = document.getElementById('edit-slug')
  editSlugInput.value = product.slug || ''
  // A product with no slug yet (pre-migration row) should still autofill as
  // the admin types a title; one that already has a slug should not.
  editSlugInput.dataset.touched = product.slug ? 'true' : 'false'
  document.getElementById('edit-price').value = product.price_cents != null ? (product.price_cents / 100).toFixed(2) : ''
  document.getElementById('edit-inventory').value = product.inventory_count != null ? product.inventory_count : ''
  document.getElementById('edit-stripe-product-id').value = product.stripe_product_id || ''
  document.getElementById('edit-description').value = product.description || ''
  document.getElementById('edit-category').value = product.category || ''
  document.getElementById('edit-sizes').value = product.sizes || ''
  document.getElementById('edit-weight').value = product.weight_oz != null ? product.weight_oz : ''
  document.getElementById('edit-printful-variants').value = formatPrintfulVariantMap(product.printful_variant_map)
  document.getElementById('edit-pricing-mode').value = product.pricing_mode || 'standard'
  document.getElementById('edit-offer-min').value = product.offer_min_cents != null ? (product.offer_min_cents / 100).toFixed(2) : ''
  document.getElementById('edit-offer-max').value = product.offer_max_cents != null ? (product.offer_max_cents / 100).toFixed(2) : ''
  updatePricingModeUI('edit')
  document.getElementById('edit-image').value = ''
  document.getElementById('edit-file').value = ''
  editNewImageFiles = []
  document.getElementById('edit-image-new-preview').innerHTML = ''
  editNewDigitalFiles = []
  document.getElementById('edit-file-preview').innerHTML = ''

  editKeptImages = [product.cover_art_url, product.image_2_url, product.image_3_url]
    .concat(Array.isArray(product.gallery_images) ? product.gallery_images : [])
    .filter(Boolean)
  renderEditImagePreview()

  editKeptDigitalFiles = currentDigitalFileList(product)
  renderEditCurrentFilesPreview()
  document.getElementById('edit-file-clear').checked = false

  document.getElementById('edit-stripe-url').value = product.stripe_url || ''
  document.getElementById('edit-published').checked = product.published !== false
  document.getElementById('edit-coming-soon').checked = !!product.coming_soon
  document.getElementById('edit-landing-slot').value = product.landing_slot || ''
  document.getElementById('edit-landing-slot-status').textContent = ''
  document.getElementById('edit-status').textContent = ''
  document.getElementById('edit-stripe-status').textContent = ''
  document.getElementById('edit-modal').style.display = 'flex'
}

function closeEditModal() {
  editingProduct = null
  editKeptImages = []
  editNewImageFiles = []
  editNewDigitalFiles = []
  editKeptDigitalFiles = []
  document.getElementById('edit-modal').style.display = 'none'
}

let freeDownloadProduct = null

function openFreeDownloadModal(product) {
  freeDownloadProduct = product
  document.getElementById('free-download-email').value = ''
  document.getElementById('free-download-status').textContent = ''
  document.getElementById('free-download-form-view').style.display = 'block'
  document.getElementById('free-download-result-view').style.display = 'none'
  document.getElementById('free-download-result-view').innerHTML = ''
  document.getElementById('free-download-modal').style.display = 'flex'
}

function closeFreeDownloadModal() {
  freeDownloadProduct = null
  document.getElementById('free-download-modal').style.display = 'none'
}

let serviceInquiryProduct = null

function openServiceInquiryModal(product) {
  serviceInquiryProduct = product
  document.getElementById('service-inquiry-subtitle').textContent = `For "${product.title}" — tell us the details and we'll follow up with pricing.`
  document.getElementById('service-inquiry-name').value = ''
  document.getElementById('service-inquiry-email').value = ''
  document.getElementById('service-inquiry-phone').value = ''
  document.getElementById('service-inquiry-date').value = ''
  document.getElementById('service-inquiry-budget').value = ''
  document.getElementById('service-inquiry-message').value = ''
  document.getElementById('service-inquiry-status').textContent = ''
  document.getElementById('service-inquiry-form-view').style.display = 'block'
  document.getElementById('service-inquiry-result-view').style.display = 'none'
  document.getElementById('service-inquiry-modal').style.display = 'flex'
}

function closeServiceInquiryModal() {
  serviceInquiryProduct = null
  document.getElementById('service-inquiry-modal').style.display = 'none'
}

function initServiceInquiryModal() {
  const modal = document.getElementById('service-inquiry-modal')
  if (!modal) return

  const cancelBtn = document.getElementById('service-inquiry-cancel-btn')
  const closeBtn = document.getElementById('service-inquiry-close-btn')
  const submitBtn = document.getElementById('service-inquiry-submit-btn')
  const statusEl = document.getElementById('service-inquiry-status')

  cancelBtn.addEventListener('click', closeServiceInquiryModal)
  closeBtn.addEventListener('click', closeServiceInquiryModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeServiceInquiryModal() })

  submitBtn.addEventListener('click', async () => {
    const name = document.getElementById('service-inquiry-name').value.trim()
    const email = document.getElementById('service-inquiry-email').value.trim()
    if (!name) {
      statusEl.textContent = 'Enter your name.'
      statusEl.style.color = '#ff4d4d'
      return
    }
    if (!email || !email.includes('@')) {
      statusEl.textContent = 'Enter a valid email address.'
      statusEl.style.color = '#ff4d4d'
      return
    }

    submitBtn.disabled = true
    statusEl.textContent = 'Sending...'
    statusEl.style.color = '#e8b923'

    try {
      const { error } = await supabase.functions.invoke('submit-service-inquiry', {
        body: {
          productId: serviceInquiryProduct?.id || null,
          name,
          email,
          phone: document.getElementById('service-inquiry-phone').value.trim() || null,
          eventDate: document.getElementById('service-inquiry-date').value || null,
          budget: document.getElementById('service-inquiry-budget').value.trim() || null,
          message: document.getElementById('service-inquiry-message').value.trim() || null,
        }
      })
      if (error) throw error

      document.getElementById('service-inquiry-form-view').style.display = 'none'
      document.getElementById('service-inquiry-result-view').style.display = 'block'
    } catch (err) {
      statusEl.textContent = await describeFunctionError(err)
      statusEl.style.color = '#ff4d4d'
    } finally {
      submitBtn.disabled = false
    }
  })
}

let offerProduct = null
let offerSize = null

// One modal covers both paths Offer Based can take: a physical/digital item
// (any category but services) collects the amount here and adds to cart —
// the rest of checkout is the normal cart flow. A service has no cart entry
// point at all, so it goes straight to a standalone Stripe session instead
// (create-product-payment-session, same shape as create-tip-session).
function openOfferModal(product, size = null) {
  offerProduct = product
  offerSize = size
  const minD = (product.offer_min_cents ?? 100) / 100
  const maxD = (product.offer_max_cents ?? 100000) / 100
  document.getElementById('offer-subtitle').textContent = `For "${product.title}" — choose an amount between $${minD.toFixed(2)} and $${maxD.toFixed(2)}.`
  document.getElementById('offer-amount').min = minD
  document.getElementById('offer-amount').max = maxD
  document.getElementById('offer-amount').value = ''
  document.getElementById('offer-status').textContent = ''
  document.getElementById('offer-submit-btn').textContent = product.category === 'services' ? 'Continue to Payment' : 'Add to Cart'
  document.getElementById('offer-modal').style.display = 'flex'
}

function closeOfferModal() {
  offerProduct = null
  offerSize = null
  document.getElementById('offer-modal').style.display = 'none'
}

function initOfferModal() {
  const modal = document.getElementById('offer-modal')
  if (!modal) return

  const cancelBtn = document.getElementById('offer-cancel-btn')
  const submitBtn = document.getElementById('offer-submit-btn')
  const amountInput = document.getElementById('offer-amount')
  const statusEl = document.getElementById('offer-status')

  cancelBtn.addEventListener('click', closeOfferModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeOfferModal() })

  submitBtn.addEventListener('click', async () => {
    if (!offerProduct) return
    const dollars = parseFloat(amountInput.value)
    const minD = (offerProduct.offer_min_cents ?? 100) / 100
    const maxD = (offerProduct.offer_max_cents ?? 100000) / 100
    if (!Number.isFinite(dollars) || dollars < minD || dollars > maxD) {
      statusEl.textContent = `Enter an amount between $${minD.toFixed(2)} and $${maxD.toFixed(2)}.`
      statusEl.style.color = '#ff4d4d'
      return
    }
    const amountCents = Math.round(dollars * 100)

    submitBtn.disabled = true
    statusEl.textContent = 'One moment...'
    statusEl.style.color = '#e8b923'

    try {
      if (offerProduct.category === 'services') {
        const { data, error } = await supabase.functions.invoke('create-product-payment-session', {
          body: { productId: offerProduct.id, amountCents }
        })
        if (error) throw error
        if (!data?.url) throw new Error('Could not start checkout. Try again in a moment.')
        window.location.href = data.url
      } else {
        addToCart(offerProduct, { size: offerSize, offerAmountCents: amountCents })
        updateCartBadge()
        closeOfferModal()
      }
    } catch (err) {
      statusEl.textContent = await describeFunctionError(err)
      statusEl.style.color = '#ff4d4d'
      submitBtn.disabled = false
    }
  })
}

// Internal names kept as "reserve" (predates the 2026-09-13 services
// redesign) even though the customer-facing copy now says "Payment" — this
// is the service product page's PAYMENT button, which collects a
// customer-typed amount (the admin tells them what to pay, off-site — no
// fixed deposit, nothing non-refundable) and starts checkout for exactly
// that. "Reserve" in the sense of a message before paying anything is
// openServiceInquiryModal below (the REQUEST A QUOTE button).
let reserveProduct = null

function openReserveModal(product) {
  reserveProduct = product
  document.getElementById('reserve-subtitle').textContent = `Enter the amount you were instructed to pay for "${product.title}".`
  document.getElementById('reserve-amount').value = ''
  document.getElementById('reserve-status').textContent = ''
  document.getElementById('reserve-modal').style.display = 'flex'
}

function closeReserveModal() {
  reserveProduct = null
  document.getElementById('reserve-modal').style.display = 'none'
}

function initReserveModal() {
  const modal = document.getElementById('reserve-modal')
  if (!modal) return

  const cancelBtn = document.getElementById('reserve-cancel-btn')
  const confirmBtn = document.getElementById('reserve-confirm-btn')
  const statusEl = document.getElementById('reserve-status')
  const amountInput = document.getElementById('reserve-amount')

  cancelBtn.addEventListener('click', closeReserveModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeReserveModal() })

  confirmBtn.addEventListener('click', async () => {
    if (!reserveProduct) return
    const amount = parseFloat(amountInput.value)
    // $0.50 is Stripe's own minimum charge, not a business rule — there's
    // no upper bound since the admin is the one telling the customer what
    // to pay in the first place.
    if (!amount || amount < 0.5) {
      statusEl.textContent = 'Enter an amount of at least $0.50.'
      statusEl.style.color = '#ff4d4d'
      return
    }
    confirmBtn.disabled = true
    statusEl.textContent = 'Sending you to checkout...'
    statusEl.style.color = '#e8b923'

    try {
      const { data, error } = await supabase.functions.invoke('create-product-payment-session', {
        body: { productId: reserveProduct.id, amountCents: Math.round(amount * 100) }
      })
      if (error) throw error
      if (!data?.url) throw new Error('Could not start checkout. Try again in a moment.')
      window.location.href = data.url
    } catch (err) {
      statusEl.textContent = await describeFunctionError(err)
      statusEl.style.color = '#ff4d4d'
      confirmBtn.disabled = false
    }
  })
}

// Calls a download-delivering Edge Function directly (bypassing
// supabase.functions.invoke, which assumes a JSON response) so a multi-track
// album's zip — assembled server-side and streamed back as raw bytes — can
// be received as a Blob instead. Single-file products still get back plain
// JSON with a direct signed URL, unchanged.
async function invokeDownloadFunction(functionName, body) {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseAnonKey,
      'Authorization': `Bearer ${supabaseAnonKey}`
    },
    body: JSON.stringify(body)
  })

  const contentType = response.headers.get('content-type') || ''

  if (!response.ok) {
    let message = 'Something went wrong.'
    try {
      const errBody = await response.json()
      if (errBody && errBody.error) message = errBody.error
    } catch (_parseErr) {
      // Keep the generic fallback message above.
    }
    throw new Error(message)
  }

  if (contentType.includes('application/json')) {
    const data = await response.json()
    return { kind: 'link', url: data.downloadUrl || data.secureUrl }
  }

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  return { kind: 'blob', url: URL.createObjectURL(blob), filename: match ? match[1] : 'download.zip' }
}

function initFreeDownloadModal() {
  const closeBtn = document.getElementById('free-download-close-btn')
  const submitBtn = document.getElementById('free-download-submit-btn')
  const emailInput = document.getElementById('free-download-email')
  const statusEl = document.getElementById('free-download-status')

  closeBtn.addEventListener('click', () => {
    closeFreeDownloadModal()
  })

  submitBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim()
    if (!email || !email.includes('@')) {
      statusEl.textContent = 'Enter a valid email address.'
      statusEl.style.color = '#ff4d4d'
      return
    }
    if (!freeDownloadProduct) return

    submitBtn.disabled = true
    statusEl.textContent = 'Getting your link...'
    statusEl.style.color = '#e8b923'

    try {
      const result = await invokeDownloadFunction('free-download', { productId: freeDownloadProduct.id, email })

      document.getElementById('free-download-form-view').style.display = 'none'
      document.getElementById('free-download-result-view').style.display = 'block'
      document.getElementById('free-download-result-view').innerHTML = `
        <p style="font-size: 0.75rem; color: #00ffcc; margin: 0 0 1rem 0;">Your download is ready.</p>
        <a href="${result.url}" class="admin-btn" style="display: block; text-decoration: none; text-align: center; box-sizing: border-box;" download${result.kind === 'blob' ? `="${result.filename}"` : ''}>Right-Click &amp; Download</a>
        <div class="download-instructions">
          <p><strong>Windows / Android:</strong> Right-click (or tap and hold) the button above and choose "Save Link As" / "Download Link" to save the file.</p>
          <p><strong>Mac (Safari):</strong> Right-click the button and choose "Download Linked File."</p>
          <p><strong>iPhone / iPad (Safari):</strong> Tap and hold the button, then choose "Download Linked File" — it saves to your Files app. If it opens a preview instead, use the Share icon and choose "Save to Files."</p>
          <p><strong>Multiple files?</strong> This downloads as a single .ZIP file. Unzip it after downloading to get everything inside.</p>
        </div>
      `
    } catch (err) {
      statusEl.textContent = err.message || 'Something went wrong.'
      statusEl.style.color = '#ff4d4d'
    } finally {
      submitBtn.disabled = false
    }
  })
}

// CART
// The cart itself (add/remove/qty) lives in cart.js. This wires it up to
// the storefront UI: the badge in the filter bar, the cart modal, and
// checkout — which either goes straight to create-checkout-session (a
// digital-only cart) or first collects one shipping address + a combined
// live Shippo rate for every physical item in the cart (see below).
function updateCartBadge() {
  const badge = document.getElementById('cart-count')
  if (!badge) return
  const count = cartCount()
  badge.textContent = count
  badge.setAttribute('data-empty', count === 0 ? 'true' : 'false')
}

function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`
}

function renderCartItems() {
  const cart = getCart()
  const emptyView = document.getElementById('cart-empty-view')
  const itemsView = document.getElementById('cart-items-view')
  const list = document.getElementById('cart-items-list')

  if (cart.length === 0) {
    emptyView.style.display = 'block'
    itemsView.style.display = 'none'
    return
  }

  emptyView.style.display = 'none'
  itemsView.style.display = 'block'

  list.innerHTML = cart.map(item => `
    <div class="cart-item-row" data-key="${item.key}">
      <div class="cart-item-info">
        <div class="cart-item-title">${item.title}${item.size ? ` — ${item.size}` : ''}</div>
        <div class="cart-item-price">${formatCents(item.priceCents)} each</div>
      </div>
      <div class="cart-item-qty">
        <button type="button" class="cart-qty-btn cart-qty-minus" aria-label="Decrease quantity">−</button>
        <span class="cart-qty-value">${item.quantity}</span>
        <button type="button" class="cart-qty-btn cart-qty-plus" aria-label="Increase quantity">+</button>
      </div>
      <div class="cart-item-line-total">${formatCents(item.priceCents * item.quantity)}</div>
      <button type="button" class="cart-remove-btn" aria-label="Remove item">&times;</button>
    </div>
  `).join('')

  document.getElementById('cart-subtotal-amount').textContent = formatCents(cartSubtotalCents(cart))
}

function openCartModal() {
  document.getElementById('cart-status').textContent = ''
  renderCartItems()
  document.getElementById('cart-modal').style.display = 'flex'
}

function closeCartModal() {
  document.getElementById('cart-modal').style.display = 'none'
}

function initCartModal() {
  document.getElementById('cart-btn').addEventListener('click', openCartModal)
  document.getElementById('cart-close-btn').addEventListener('click', closeCartModal)

  document.getElementById('cart-items-list').addEventListener('click', (e) => {
    const row = e.target.closest('.cart-item-row')
    if (!row) return
    const key = row.getAttribute('data-key')
    const cart = getCart()
    const current = cart.find(i => i.key === key)
    if (!current) return

    if (e.target.classList.contains('cart-qty-plus')) {
      setCartQuantity(key, current.quantity + 1)
    } else if (e.target.classList.contains('cart-qty-minus')) {
      setCartQuantity(key, current.quantity - 1)
    } else if (e.target.classList.contains('cart-remove-btn')) {
      removeFromCart(key)
    } else {
      return
    }
    renderCartItems()
    updateCartBadge()
  })

  document.getElementById('cart-checkout-btn').addEventListener('click', async () => {
    const cart = getCart()
    if (cart.length === 0) return

    const statusEl = document.getElementById('cart-status')

    if (cartHasPhysicalItems(cart)) {
      closeCartModal()
      openShippingCheckoutModal()
      return
    }

    const checkoutBtn = document.getElementById('cart-checkout-btn')
    checkoutBtn.disabled = true
    statusEl.textContent = 'Redirecting to payment...'
    statusEl.style.color = '#e8b923'

    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: { items: cart.map(i => ({ productId: i.productId, quantity: i.quantity, size: i.size, offerAmountCents: i.offerAmountCents ?? null })) }
      })
      if (error) throw error
      window.location.href = data.url
    } catch (err) {
      statusEl.textContent = await describeFunctionError(err)
      statusEl.style.color = '#ff4d4d'
      checkoutBtn.disabled = false
    }
  })
}

// SHIPPING CHECKOUT (physical items)
// Collects one shipping address for the whole cart via Stripe's Address
// Element (autocomplete-as-you-type, validated as the buyer types), gets a
// live combined Shippo rate for every physical item in it (apparel, or any
// art/pancho picks item with a weight set), then hands the chosen rate off
// to create-checkout-session to build a single Stripe Checkout Session
// covering the entire cart — physical and digital items alike.
let selectedShippingRateId = null
let stripeAddressElementPromise = null

// Created and mounted once, then reused for every time the modal opens —
// Stripe Elements aren't meant to be torn down and recreated repeatedly.
function getAddressElement() {
  if (!stripeAddressElementPromise) {
    stripeAddressElementPromise = loadStripe(stripePublishableKey).then(stripe => {
      const elements = stripe.elements({
        appearance: {
          theme: 'night',
          variables: {
            colorBackground: '#000',
            colorText: '#fff',
            colorTextPlaceholder: '#666',
            colorPrimary: '#00ffcc',
            colorDanger: '#ff4d4d',
            borderRadius: '0px',
            fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
            spacingUnit: '4px',
          },
          rules: {
            '.Input': { border: '2px solid #fff', padding: '0.9rem 1rem' },
          },
        },
      })
      const addressElement = elements.create('address', {
        mode: 'shipping',
        allowedCountries: ['US'],
        // Stripe's own free autocomplete only activates when a Payment
        // Element shares the same Elements group or during an active Link
        // session — neither applies here (payment happens on Stripe's own
        // hosted Checkout page afterward), so it needs our own Google Maps
        // API key to actually show suggestions as the buyer types.
        autocomplete: { mode: 'google_maps_api', apiKey: googleMapsApiKey },
      })
      addressElement.mount('#address-element')
      return addressElement
    })
  }
  return stripeAddressElementPromise
}

function openShippingCheckoutModal() {
  selectedShippingRateId = null

  getAddressElement()
  document.getElementById('shipping-form-status').textContent = ''
  document.getElementById('shipping-rates-status').textContent = ''
  document.getElementById('shipping-form-view').style.display = 'block'
  document.getElementById('shipping-rates-view').style.display = 'none'
  document.getElementById('shipping-checkout-modal').style.display = 'flex'
}

function closeShippingCheckoutModal() {
  selectedShippingRateId = null
  document.getElementById('shipping-checkout-modal').style.display = 'none'
}

function initShippingCheckoutModal() {
  const closeBtn = document.getElementById('shipping-checkout-close-btn')
  const getRatesBtn = document.getElementById('shipping-get-rates-btn')
  const backBtn = document.getElementById('shipping-back-btn')
  const continueBtn = document.getElementById('shipping-continue-btn')
  const formStatus = document.getElementById('shipping-form-status')
  const ratesStatus = document.getElementById('shipping-rates-status')
  const ratesList = document.getElementById('shipping-rates-list')

  let lastToAddress = null

  closeBtn.addEventListener('click', () => {
    closeShippingCheckoutModal()
    // Cart state hasn't changed — just hand the buyer back to the cart
    // instead of dropping them with no way back in.
    openCartModal()
  })

  backBtn.addEventListener('click', () => {
    document.getElementById('shipping-rates-view').style.display = 'none'
    document.getElementById('shipping-form-view').style.display = 'block'
  })

  getRatesBtn.addEventListener('click', async () => {
    const cart = getCart()
    const physicalItems = cart.filter(i => (i.weightOz != null && i.weightOz > 0) || i.printfulVariantId != null)
    if (physicalItems.length === 0) return

    const addressElement = await getAddressElement()
    const { complete, value } = await addressElement.getValue()
    if (!complete) {
      formStatus.textContent = 'Fill in all required address fields.'
      formStatus.style.color = '#ff4d4d'
      return
    }

    const toAddress = {
      name: value.name || '',
      street1: value.address.line1 || '',
      street2: value.address.line2 || '',
      city: value.address.city || '',
      state: value.address.state || '',
      zip: value.address.postal_code || '',
      country: value.address.country || 'US'
    }

    getRatesBtn.disabled = true
    formStatus.textContent = 'Getting live shipping rates...'
    formStatus.style.color = '#e8b923'

    try {
      const { data, error } = await supabase.functions.invoke('get-shipping-rates', {
        body: { items: physicalItems.map(i => ({ productId: i.productId, quantity: i.quantity, size: i.size })), toAddress }
      })
      if (error) throw error

      lastToAddress = toAddress

      ratesList.innerHTML = data.rates.map((rate, i) => `
        <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem; border: 1px solid #333; border-radius: 4px; margin-bottom: 0.5rem; cursor: pointer; font-size: 0.7rem;">
          <input type="radio" name="shipping-rate" value="${rate.id}" ${i === 0 ? 'checked' : ''}>
          <span style="flex: 1;">${rate.provider ? `${rate.provider} ` : ''}${rate.service}${rate.estimatedDays ? ` — ${rate.estimatedDays}d` : ''}</span>
          <span style="color: #00ffcc; font-weight: bold;">$${parseFloat(rate.amount).toFixed(2)}</span>
        </label>
      `).join('')

      selectedShippingRateId = data.rates[0] ? data.rates[0].id : null
      continueBtn.disabled = !selectedShippingRateId
      ratesStatus.textContent = ''

      document.getElementById('shipping-form-view').style.display = 'none'
      document.getElementById('shipping-rates-view').style.display = 'block'
    } catch (err) {
      formStatus.textContent = await describeFunctionError(err)
      formStatus.style.color = '#ff4d4d'
    } finally {
      getRatesBtn.disabled = false
    }
  })

  ratesList.addEventListener('change', (e) => {
    if (e.target.name === 'shipping-rate') {
      selectedShippingRateId = e.target.value
      continueBtn.disabled = false
    }
  })

  continueBtn.addEventListener('click', async () => {
    const cart = getCart()
    if (cart.length === 0 || !selectedShippingRateId || !lastToAddress) return

    continueBtn.disabled = true
    ratesStatus.textContent = 'Redirecting to payment...'
    ratesStatus.style.color = '#e8b923'

    try {
      const { data, error } = await supabase.functions.invoke('create-checkout-session', {
        body: {
          items: cart.map(i => ({ productId: i.productId, quantity: i.quantity, size: i.size, offerAmountCents: i.offerAmountCents ?? null })),
          rateId: selectedShippingRateId,
          toAddress: lastToAddress
        }
      })
      if (error) throw error
      window.location.href = data.url
    } catch (err) {
      ratesStatus.textContent = await describeFunctionError(err)
      ratesStatus.style.color = '#ff4d4d'
      continueBtn.disabled = false
    }
  })
}

// supabase.functions.invoke() throws a generic "Edge Function returned a
// non-2xx status code" message on failure — the real reason is in the
// response body, which this pulls out instead.
async function describeFunctionError(err) {
  if (err && err.context && typeof err.context.json === 'function') {
    try {
      const body = await err.context.json()
      if (body && body.error) return body.error
    } catch (_parseErr) {
      // Fall through to the generic message below.
    }
  }
  return err.message || 'Something went wrong.'
}

async function generateStripeLink(titleInputId, priceInputId, urlInputId, newDigitalFiles, categoryInputId, sizesInputId, stripeProductIdInputId, printfulInputId, existingFileUrl, existingTracklistSnippets, existingDownloadFiles, statusEl, button) {
  const title = document.getElementById(titleInputId).value.trim()
  const category = document.getElementById(categoryInputId).value
  const sizes = category === 'apparel' ? document.getElementById(sizesInputId).value.trim() : ''
  // Printful items never get a Payment Link — it collects a shipping
  // address but never attaches a shipping charge, so if it were ever
  // used the shipping cost would land on us instead of the buyer.
  const isPrintful = canUsePrintful(category) && !!document.getElementById(printfulInputId).value.trim()

  // categoryInputId is always `${prefix}-category` — reuse that prefix to
  // reach the pricing-mode/offer-bounds fields without a new parameter.
  const prefix = categoryInputId.replace('-category', '')
  const pricingMode = document.getElementById(`${prefix}-pricing-mode`).value || 'standard'
  // Offer Based has no fixed price — priceInputId points at the hidden,
  // meaningless price field for this mode (it's never shown or set), so
  // reading it here was tripping the $0/free-product guard below even
  // with real $1–$20 offer bounds set. The bounds themselves are what's
  // real; the buyer's actual charge is clamped from those server-side at
  // checkout (create-checkout-session), never from a price recorded here.
  const price = pricingMode === 'offer_based'
    ? parseFloat(document.getElementById(`${prefix}-offer-min`).value)
    : parseFloat(document.getElementById(priceInputId).value)
  // A static Payment Link bakes in one fixed price, which can't represent
  // a buyer-chosen offer — Offer Based is always purchased through the
  // normal cart instead, so this only needs the bare Stripe Product
  // (price_data.product at checkout references it, but never this link).
  const skipPaymentLink = isPrintful || pricingMode === 'offer_based'

  if (!title) {
    statusEl.textContent = 'Enter a title before generating a link.'
    statusEl.style.color = '#ff4d4d'
    return
  }

  if (pricingMode === 'offer_based') {
    if (!price || price < 0.5) {
      statusEl.textContent = 'Set a Minimum Offer of at least $0.50 before generating a checkout ID.'
      statusEl.style.color = '#ff4d4d'
      return
    }
  } else {
    if (price === 0) {
      statusEl.textContent = 'Free products (price $0) don’t need a Stripe link — the storefront offers them as a free download instead.'
      statusEl.style.color = '#e8b923'
      return
    }

    if (!price || price < 0.5) {
      statusEl.textContent = 'Stripe requires a price of at least $0.50 (or exactly $0 for a free download).'
      statusEl.style.color = '#ff4d4d'
      return
    }
  }

  button.disabled = true
  statusEl.textContent = 'Generating Stripe link...'
  statusEl.style.color = '#e8b923'

  try {
    // Attach whichever digital file(s) are currently in play — a freshly
    // selected single file/album/bundle, or whatever's already on the
    // product — so the buyer gets a real download after checkout instead of
    // a dead end.
    const { filePaths: newFilePaths } = await processDigitalFiles(newDigitalFiles)

    let filePaths = newFilePaths
    if (filePaths.length === 0) {
      if (Array.isArray(existingDownloadFiles) && existingDownloadFiles.length > 0) {
        filePaths = existingDownloadFiles.map(f => extractStoragePath(f.url, 'audio-vault')).filter(Boolean)
      } else if (Array.isArray(existingTracklistSnippets) && existingTracklistSnippets.length > 0) {
        filePaths = existingTracklistSnippets.map(t => extractStoragePath(t.url, 'audio-vault')).filter(Boolean)
      } else if (existingFileUrl) {
        filePaths = [extractStoragePath(existingFileUrl, 'audio-vault')].filter(Boolean)
      }
    }

    const { data, error } = await supabase.functions.invoke('create-stripe-link', {
      body: { title, priceCents: Math.round(price * 100), filePaths, category, sizes, skipPaymentLink }
    })
    if (error) throw error

    document.getElementById(urlInputId).value = data.url || ''
    document.getElementById(stripeProductIdInputId).value = data.productId || ''
    statusEl.textContent = isPrintful
      ? 'Stripe product created — no payment link needed for a Printful item.'
      : pricingMode === 'offer_based'
        ? 'Checkout ID generated — buyers set their own price in the cart, so no fixed payment link was created.'
        : (filePaths.length > 0
          ? 'Stripe link generated with download attached.'
          : 'Stripe link generated (no digital file attached).')
    statusEl.style.color = '#00ffcc'
  } catch (err) {
    statusEl.textContent = await describeFunctionError(err)
    statusEl.style.color = '#ff4d4d'
  } finally {
    button.disabled = false
  }
}

function initAdminPortal() {
  const params = new URLSearchParams(window.location.search)
  const isAdminMode = params.get('mode') === 'admin'

  const adminPortal = document.getElementById('admin-portal')
  const filterBar = document.querySelector('.filter-bar')
  const storeGrid = document.getElementById('store-grid')
  const loginView = document.getElementById('login-view')
  const dashboardView = document.getElementById('dashboard-view')
  const loginBtn = document.getElementById('admin-login-btn')
  const logoutBtn = document.getElementById('admin-logout-btn')
  const emailInput = document.getElementById('admin-email')
  const passwordInput = document.getElementById('admin-password')

  if (isAdminMode) {
    filterBar.style.display = 'none'
    storeGrid.style.display = 'none'
    const landingView = document.getElementById('landing-view')
    if (landingView) landingView.style.display = 'none'
    const productView = document.getElementById('product-view')
    if (productView) productView.style.display = 'none'
    document.querySelector('.bodega-footer').style.display = 'none'
    document.body.style.overflow = 'hidden'
    adminPortal.style.display = 'flex'
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      loginView.style.display = 'none'
      dashboardView.style.display = 'flex'
      logoutBtn.style.display = 'inline-block'
      loadAdminInventory()
      loadAdminOrders()
      loadAdminTips()
      loadAdminEmailCaptures()
      loadAdminServiceInquiries()
      loadAdminSettings()
      loadAdminLookbook()
      loadAdminVipLinks()
      loadAdminPlays()
    } else {
      loginView.style.display = 'block'
      dashboardView.style.display = 'none'
      logoutBtn.style.display = 'none'
      closeEditModal()
    }
  })

  // Admin hub hand-off: the main site's /admin hub opens this page as
  // `?mode=admin#hub=<base64url JSON {a: access_token, r: refresh_token}>` so the shared
  // login carries over. The fragment is cleared immediately; the session itself goes
  // through the normal auth flow above (onAuthStateChange shows the dashboard).
  if (isAdminMode && window.location.hash.startsWith('#hub=')) {
    const packed = window.location.hash.slice('#hub='.length)
    history.replaceState(null, '', window.location.pathname + window.location.search)
    try {
      const b64 = packed.replace(/-/g, '+').replace(/_/g, '/')
      const { a, r } = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
      if (a && r) {
        supabase.auth.setSession({ access_token: a, refresh_token: r }).then(({ error }) => {
          if (error) console.warn('Hub hand-off failed — log in normally.', error.message)
        })
      }
    } catch (err) {
      console.warn('Hub hand-off was malformed — log in normally.')
    }
  }

  loginBtn.addEventListener('click', async () => {
    const { error } = await supabase.auth.signInWithPassword({
      email: emailInput.value,
      password: passwordInput.value
    })
    if (error) alert(error.message)
  })

  logoutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut()
  })

  // Inventory/Orders/Tips/Email Captures used to each get their own narrow
  // always-visible column — cramped on desktop with four, a long stack on
  // mobile. One full-width panel at a time instead; all four still load
  // eagerly up front, this only toggles which is shown.
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab')
      document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
      document.querySelectorAll('.admin-tab-panel').forEach(panel => {
        panel.style.display = panel.getAttribute('data-tab-panel') === target ? 'flex' : 'none'
      })
    })
  })

  // Phone layout: a menu of sections (index.html, #admin-menu). Picking one shows it
  // full screen with a Back bar; the existing tab buttons are still what switch the
  // panels underneath, so desktop and phone share one code path. Classes only have
  // an effect inside the <= 768px media query.
  const adminDash = document.getElementById('dashboard-view')
  const ADMIN_SECTION_TITLES = {
    'add-product': 'Add Product', inventory: 'Inventory', orders: 'Orders', tips: 'Tips', 'email-captures': 'Email Captures',
    inquiries: 'Inquiries', 'vip-links': 'VIP Links', plays: 'Plays', messages: 'Messages', lookbook: 'Look Book', 'featured-order': 'Featured Order'
  }
  const setAdminMobileView = (key) => {
    adminDash.classList.remove('m-menu', 'm-section', 'm-add', 'm-tabs')
    if (!key) { adminDash.classList.add('m-menu') } else {
      adminDash.classList.add('m-section', key === 'add-product' ? 'm-add' : 'm-tabs')
      document.getElementById('admin-section-title').textContent = ADMIN_SECTION_TITLES[key] || ''
      if (key !== 'add-product') { const tab = document.querySelector(`.admin-tab-btn[data-tab="${key}"]`); if (tab) tab.click() }
    }
    document.getElementById('admin-portal').scrollTo(0, 0)
  }
  setAdminMobileView(null)
  // The phone's Back button / swipe goes section -> menu (and only from the menu
  // leaves the admin): opening a section pushes a history entry (same URL), and
  // the "← Admin" bar just goes back through history, so both paths agree.
  document.getElementById('admin-menu').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-admin-open]')
    if (!tile) return
    history.pushState({ adminSection: tile.dataset.adminOpen }, '')
    setAdminMobileView(tile.dataset.adminOpen)
  })
  document.getElementById('admin-section-back').addEventListener('click', () => {
    if (history.state && history.state.adminSection) history.back() // popstate below shows the menu
    else setAdminMobileView(null)
  })
  window.addEventListener('popstate', (e) => {
    setAdminMobileView(e.state && e.state.adminSection ? e.state.adminSection : null)
  })
  // Small badges on the tiles that have an easy count.
  const refreshAdminMenuCounts = () => {
    const set = (key, n) => { const el = document.querySelector(`[data-count-for="${key}"]`); if (el) el.textContent = n > 0 ? String(n) : '' }
    set('inventory', adminProductsCache.length)
    set('orders', document.querySelectorAll('#admin-orders-list .order-item').length)
  }
  ;['admin-inventory-list', 'admin-orders-list'].forEach((id) => {
    const el = document.getElementById(id)
    if (el) new MutationObserver(refreshAdminMenuCounts).observe(el, { childList: true, subtree: true })
  })

  initLookbookAdmin()
  initFeaturedOrderAdmin()
  initVipAdmin()

  const settingsSaveBtn = document.getElementById('settings-save-btn')
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', async () => {
      const statusEl = document.getElementById('settings-status')
      settingsSaveBtn.disabled = true
      statusEl.textContent = 'Saving...'
      statusEl.style.color = '#e8b923'

      const purchaseMessage = document.getElementById('settings-purchase-message').value.trim() || null
      const tipMessage = document.getElementById('settings-tip-message').value.trim() || null

      // .update() alone doesn't error when RLS blocks it or the row simply
      // doesn't match — it silently succeeds having touched zero rows.
      // .select() forces the actual affected row(s) back so a no-op save
      // can be told apart from a real one, instead of reporting "Saved."
      // when nothing was written.
      const { data, error } = await supabase
        .from('site_settings')
        .update({ purchase_thank_you_message: purchaseMessage, tip_thank_you_message: tipMessage })
        .eq('id', true)
        .select()

      if (error) {
        statusEl.textContent = error.message
        statusEl.style.color = '#ff4d4d'
      } else if (!data || data.length === 0) {
        statusEl.textContent = 'Nothing was saved — no matching settings row found.'
        statusEl.style.color = '#ff4d4d'
      } else {
        statusEl.textContent = 'Saved.'
        statusEl.style.color = '#00ffcc'
      }
      settingsSaveBtn.disabled = false
    })
  }

  const uploadForm = document.getElementById('upload-form')
  const uploadStatus = document.getElementById('upload-status')
  const uploadSubmitBtn = document.getElementById('upload-submit-btn')

  document.getElementById('upload-category').addEventListener('change', () => updatePricingModeUI('upload'))
  document.getElementById('upload-pricing-mode').addEventListener('change', () => updatePricingModeUI('upload'))
  document.getElementById('upload-price').addEventListener('input', () => updatePricingModeUI('upload'))
  updatePricingModeUI('upload')

  wireSlugAutofill('upload-title', 'upload-slug')
  wireSlugAutofill('edit-title', 'edit-slug')

  document.getElementById('upload-image').addEventListener('change', (e) => {
    uploadNewImageFiles = uploadNewImageFiles.concat(Array.from(e.target.files))
    e.target.value = '' // reset so reopening the picker starts a fresh native selection instead of showing a stale filename
    renderPickedImagesPreview(uploadNewImageFiles, document.getElementById('upload-image-preview'))
  })

  document.getElementById('upload-image-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-image-remove-btn')
    if (!removeBtn) return
    uploadNewImageFiles.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderPickedImagesPreview(uploadNewImageFiles, document.getElementById('upload-image-preview'))
  })

  document.getElementById('edit-image').addEventListener('change', (e) => {
    editNewImageFiles = editNewImageFiles.concat(Array.from(e.target.files))
    e.target.value = ''
    renderPickedImagesPreview(editNewImageFiles, document.getElementById('edit-image-new-preview'))
  })

  document.getElementById('edit-image-new-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-image-remove-btn')
    if (!removeBtn) return
    editNewImageFiles.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderPickedImagesPreview(editNewImageFiles, document.getElementById('edit-image-new-preview'))
  })

  document.getElementById('edit-image-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-image-remove-btn')
    if (!removeBtn) return
    editKeptImages.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderEditImagePreview()
  })

  document.getElementById('upload-file').addEventListener('change', (e) => {
    uploadNewDigitalFiles = uploadNewDigitalFiles.concat(Array.from(e.target.files))
    e.target.value = ''
    renderPickedFilesPreview(uploadNewDigitalFiles, document.getElementById('upload-file-preview'))
  })

  document.getElementById('upload-file-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-file-remove-btn')
    if (!removeBtn) return
    uploadNewDigitalFiles.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderPickedFilesPreview(uploadNewDigitalFiles, document.getElementById('upload-file-preview'))
  })

  document.getElementById('edit-file').addEventListener('change', (e) => {
    editNewDigitalFiles = editNewDigitalFiles.concat(Array.from(e.target.files))
    e.target.value = ''
    renderPickedFilesPreview(editNewDigitalFiles, document.getElementById('edit-file-preview'))
  })

  document.getElementById('edit-file-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-file-remove-btn')
    if (!removeBtn) return
    editNewDigitalFiles.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderPickedFilesPreview(editNewDigitalFiles, document.getElementById('edit-file-preview'))
  })

  document.getElementById('edit-file-current-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-file-remove-btn')
    if (!removeBtn) return
    editKeptDigitalFiles.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderEditCurrentFilesPreview()
  })

  const uploadGenerateStripeBtn = document.getElementById('upload-generate-stripe-btn')
  const uploadStripeStatus = document.getElementById('upload-stripe-status')

  uploadGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('upload-title', 'upload-price', 'upload-stripe-url', uploadNewDigitalFiles, 'upload-category', 'upload-sizes', 'upload-stripe-product-id', 'upload-printful-variants', null, null, null, uploadStripeStatus, uploadGenerateStripeBtn)
  })

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()

    // The file input's own required-ness can't be trusted here — its value
    // gets cleared after every pick so multi-batch selection accumulates in
    // uploadNewImageFiles instead of being wiped by the next picker open.
    if (uploadNewImageFiles.length === 0) {
      uploadStatus.textContent = 'Add at least one product photo.'
      uploadStatus.style.color = '#ff4d4d'
      return
    }

    uploadSubmitBtn.disabled = true
    uploadStatus.textContent = 'Deploying...'
    uploadStatus.style.color = '#e8b923'

    try {
      const title = document.getElementById('upload-title').value
      const slug = document.getElementById('upload-slug').value.trim() || slugify(title)
      const price = parseFloat(document.getElementById('upload-price').value)
      const description = document.getElementById('upload-description').value
      const category = document.getElementById('upload-category').value
      const sizes = category === 'apparel' ? (document.getElementById('upload-sizes').value.trim() || null) : null
      const weightRaw = SHIPPABLE_CATEGORIES.includes(category) ? document.getElementById('upload-weight').value.trim() : ''
      const weightOz = weightRaw === '' ? null : parseFloat(weightRaw)
      const printfulVariantMap = canUsePrintful(category)
        ? parsePrintfulVariantMap(document.getElementById('upload-printful-variants').value)
        : null
      const inventoryRaw = document.getElementById('upload-inventory').value.trim()
      const inventoryCount = inventoryRaw === '' ? null : parseInt(inventoryRaw, 10)
      const stripeProductId = document.getElementById('upload-stripe-product-id').value.trim() || null
      const stripeUrl = document.getElementById('upload-stripe-url').value.trim() || null
      const published = document.getElementById('upload-published').checked
      const comingSoon = document.getElementById('upload-coming-soon').checked
      const landingSlot = await resolveLandingSlot('upload-landing-slot', null)
      const { pricingMode, priceCents, offerMinCents, offerMaxCents } = readPricingModeFields('upload', price)

      const { coverUrl, galleryImages } = await processImageFiles(uploadNewImageFiles)

      const { fileUrl, downloadFiles, tracklistSnippets } = await processDigitalFiles(uploadNewDigitalFiles)

      const { error: insertError } = await supabase.from('products').insert({
        title,
        slug,
        price_cents: priceCents,
        pricing_mode: pricingMode,
        offer_min_cents: offerMinCents,
        offer_max_cents: offerMaxCents,
        description,
        category,
        sizes,
        weight_oz: weightOz,
        printful_variant_map: printfulVariantMap,
        inventory_count: inventoryCount,
        stripe_product_id: stripeProductId,
        cover_art_url: coverUrl,
        gallery_images: galleryImages,
        audio_preview_url: fileUrl,
        download_files: downloadFiles,
        tracklist_snippets: tracklistSnippets,
        stripe_url: stripeUrl,
        published,
        coming_soon: comingSoon,
        landing_slot: landingSlot
      })
      if (insertError) throw insertError

      uploadStatus.textContent = tracklistSnippets
        ? `Product Deployed Successfully (${tracklistSnippets.length}-track album)`
        : 'Product Deployed Successfully'
      uploadStatus.style.color = '#00ffcc'
      uploadForm.reset()
      updatePricingModeUI('upload')
      uploadNewImageFiles = []
      document.getElementById('upload-image-preview').innerHTML = ''
      uploadNewDigitalFiles = []
      document.getElementById('upload-file-preview').innerHTML = ''
      loadAdminInventory()
    } catch (err) {
      uploadStatus.textContent = err.message || 'Something went wrong.'
      uploadStatus.style.color = '#ff4d4d'
    } finally {
      uploadSubmitBtn.disabled = false
    }
  })

  const editForm = document.getElementById('edit-product-form')
  const editStatus = document.getElementById('edit-status')
  const editSaveBtn = document.getElementById('edit-save-btn')
  const editCancelBtn = document.getElementById('edit-cancel-btn')

  document.getElementById('edit-category').addEventListener('change', () => updatePricingModeUI('edit'))
  document.getElementById('edit-pricing-mode').addEventListener('change', () => updatePricingModeUI('edit'))
  document.getElementById('edit-price').addEventListener('input', () => updatePricingModeUI('edit'))

  const editGenerateStripeBtn = document.getElementById('edit-generate-stripe-btn')
  const editStripeStatus = document.getElementById('edit-stripe-status')

  editGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('edit-title', 'edit-price', 'edit-stripe-url', editNewDigitalFiles, 'edit-category', 'edit-sizes', 'edit-stripe-product-id', 'edit-printful-variants', editingProduct ? editingProduct.audio_preview_url : null, editingProduct ? editingProduct.tracklist_snippets : null, editingProduct ? editingProduct.download_files : null, editStripeStatus, editGenerateStripeBtn)
  })

  editCancelBtn.addEventListener('click', () => {
    closeEditModal()
  })

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    editSaveBtn.disabled = true
    editStatus.textContent = 'Saving...'
    editStatus.style.color = '#e8b923'

    try {
      const id = document.getElementById('edit-id').value
      const title = document.getElementById('edit-title').value
      const slug = document.getElementById('edit-slug').value.trim() || slugify(title)
      const price = parseFloat(document.getElementById('edit-price').value)
      const description = document.getElementById('edit-description').value
      const category = document.getElementById('edit-category').value
      const sizes = category === 'apparel' ? (document.getElementById('edit-sizes').value.trim() || null) : null
      const weightRaw = SHIPPABLE_CATEGORIES.includes(category) ? document.getElementById('edit-weight').value.trim() : ''
      const weightOz = weightRaw === '' ? null : parseFloat(weightRaw)
      const printfulVariantMap = canUsePrintful(category)
        ? parsePrintfulVariantMap(document.getElementById('edit-printful-variants').value)
        : null
      const inventoryRaw = document.getElementById('edit-inventory').value.trim()
      const inventoryCount = inventoryRaw === '' ? null : parseInt(inventoryRaw, 10)
      const stripeProductId = document.getElementById('edit-stripe-product-id').value.trim() || null
      const stripeUrl = document.getElementById('edit-stripe-url').value.trim() || null
      const published = document.getElementById('edit-published').checked
      const comingSoon = document.getElementById('edit-coming-soon').checked
      const landingSlot = await resolveLandingSlot('edit-landing-slot', id)
      const { pricingMode, priceCents, offerMinCents, offerMaxCents } = readPricingModeFields('edit', price)

      // New photos are appended to whatever's left in editKeptImages (the
      // admin can remove individual existing photos via the × on each
      // thumbnail, but simply adding more never drops the old ones). This
      // also folds the legacy image_2_url/image_3_url columns into
      // gallery_images going forward, since they're always recomputed here.
      const newPhotos = await processImageFiles(editNewImageFiles)
      const newPhotoUrls = newPhotos.coverUrl ? [newPhotos.coverUrl, ...(newPhotos.galleryImages || [])] : []
      const allImages = [...editKeptImages, ...newPhotoUrls]
      const coverUrl = allImages[0] || null
      const galleryImages = allImages.length > 1 ? allImages.slice(1) : null
      const image2Url = null
      const image3Url = null

      // Checked: drop everything currently attached (a stray/mistaken file,
      // or a product that shouldn't have one at all) regardless of what's
      // still left in editKeptDigitalFiles — the fast "start over" option.
      // Otherwise, new uploads are ADDED to whatever's left in
      // editKeptDigitalFiles (already reflects any individual × removals),
      // not a replacement for it — picking a couple of new cover images used
      // to silently wipe an entire album's audio files here (a real
      // incident), the same bug the photo picker never had.
      const keptFiles = document.getElementById('edit-file-clear').checked ? [] : editKeptDigitalFiles
      let fileUrl = null
      let downloadFiles = null
      let tracklistSnippets = null
      if (editNewDigitalFiles.length > 0) {
        const uploaded = await processDigitalFiles(editNewDigitalFiles)
        const combined = deriveDigitalFileFields([...keptFiles, ...(uploaded.downloadFiles || [])])
        fileUrl = combined.fileUrl
        downloadFiles = combined.downloadFiles
        tracklistSnippets = combined.tracklistSnippets
      } else if (keptFiles.length > 0) {
        const combined = deriveDigitalFileFields(keptFiles)
        fileUrl = combined.fileUrl
        downloadFiles = combined.downloadFiles
        tracklistSnippets = combined.tracklistSnippets
      }

      const { error: updateError } = await supabase.from('products').update({
        title,
        slug,
        price_cents: priceCents,
        pricing_mode: pricingMode,
        offer_min_cents: offerMinCents,
        offer_max_cents: offerMaxCents,
        description,
        category,
        sizes,
        weight_oz: weightOz,
        printful_variant_map: printfulVariantMap,
        inventory_count: inventoryCount,
        stripe_product_id: stripeProductId,
        cover_art_url: coverUrl,
        image_2_url: image2Url,
        image_3_url: image3Url,
        gallery_images: galleryImages,
        audio_preview_url: fileUrl,
        download_files: downloadFiles,
        tracklist_snippets: tracklistSnippets,
        stripe_url: stripeUrl,
        published,
        coming_soon: comingSoon,
        landing_slot: landingSlot
      }).eq('id', id)
      if (updateError) throw updateError

      closeEditModal()
      uploadStatus.textContent = 'Product Updated Successfully'
      uploadStatus.style.color = '#00ffcc'
      loadAdminInventory()
      loadBodega()
    } catch (err) {
      editStatus.textContent = err.message || 'Something went wrong.'
      editStatus.style.color = '#ff4d4d'
      alert(err.message || 'Something went wrong.')
    } finally {
      editSaveBtn.disabled = false
    }
  })

  return isAdminMode
}

// GLOBAL AUDIO ENGINE
// A single shared Audio() instance drives every "Play" trigger on the page,
// so only one preview can ever be playing at once. The UI around it is a
// floating mini-player plus a full-screen "Now Playing" sheet (#global-audio-player
// / #now-playing in index.html), the way streaming apps do it.
const globalAudio = new Audio()
// What's loaded (read off a trigger's data-* attributes) and the list it came
// from. Kept as plain data, not DOM nodes, so prev/next/auto-advance and the
// player keep working even after the visitor navigates and the tracklist that
// started the music is gone from the page.
let currentTrack = null
let playQueue = []
const coverColorCache = new Map()

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
}

function metaFromEl(el) {
  return {
    url: el.dataset.url,
    title: el.dataset.title || '',
    name: el.dataset.name || el.dataset.title || '',
    sub: el.dataset.sub || '',
    album: el.dataset.album || '',
    cover: el.dataset.cover || '',
    shareUrl: el.dataset.shareUrl || '',
    productSlug: el.dataset.productSlug || '',
    trackSlug: el.dataset.trackSlug || ''
  }
}

function toggleGlobalPlayback() {
  if (globalAudio.paused) globalAudio.play().catch(() => {})
  else globalAudio.pause()
}

// Fetches a fresh signed URL (audio-vault is private) and plays `meta`;
// `queue` is the list prev/next/auto-advance walk through.
async function startTrack(meta, queue) {
  const { data, error } = await supabase.functions.invoke('get-playback-url', {
    body: { url: meta.url }
  })
  if (error || !data?.url) throw error || new Error('No playback URL returned.')
  playQueue = queue && queue.length ? queue : [meta]
  currentTrack = meta
  loadTrackUI(meta)
  globalAudio.src = data.url
  globalAudio.currentTime = 0
  globalAudio.play().catch(() => {})
  refreshPlayStateUI()
}

// Moves one track forward/back in the queue. Returns false when there's
// nowhere to go (single preview, or the first/last track).
async function stepTrack(delta) {
  if (!currentTrack || playQueue.length < 2) return false
  const index = playQueue.findIndex(t => t.url === currentTrack.url)
  const next = index >= 0 ? playQueue[index + delta] : null
  if (!next) return false
  try {
    await startTrack(next, playQueue)
  } catch (err) {
    console.error('Failed to get playback URL:', err)
  }
  return true
}

// Keeps every piece of play/pause UI in step with the audio: the highlighted
// track row (animated bars while playing), the album/pill play buttons, both
// play buttons in the players, and whether prev/next have anywhere to go.
function refreshPlayStateUI() {
  const playing = !globalAudio.paused
  const url = currentTrack ? currentTrack.url : null

  document.querySelectorAll('.track-item').forEach(row => {
    const active = !!url && row.dataset.url === url
    row.classList.toggle('is-active', active)
    row.classList.toggle('is-playing', active && playing)
  })

  document.querySelectorAll('.card-play-btn').forEach(btn => {
    let on = false
    if (playing && url) {
      on = btn.classList.contains('album-big-play')
        ? [...btn.closest('.album-player-container').querySelectorAll('.track-item')].some(r => r.dataset.url === url)
        : btn.dataset.url === url
    }
    btn.classList.toggle('is-playing', on)
    const icon = btn.querySelector('.play-icon')
    if (icon) icon.innerHTML = on ? PAUSE_ICON_SVG : PLAY_ICON_SVG
  })

  const icon = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG
  const gapToggle = document.getElementById('gap-toggle')
  const npToggle = document.getElementById('np-toggle')
  if (gapToggle) gapToggle.innerHTML = icon
  if (npToggle) npToggle.innerHTML = icon

  const index = currentTrack ? playQueue.findIndex(t => t.url === currentTrack.url) : -1
  const prev = document.getElementById('np-prev')
  const next = document.getElementById('np-next')
  if (prev) prev.disabled = !(index > 0)
  if (next) next.disabled = !(index >= 0 && index < playQueue.length - 1)

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = currentTrack ? (playing ? 'playing' : 'paused') : 'none'
  }
}

// Average colour of the cover (sampled on a tiny canvas), darkened so white text
// stays readable — tints the mini-player and the top of the Now Playing sheet.
function applyCoverColor(url) {
  const player = document.getElementById('global-audio-player')
  const sheet = document.getElementById('now-playing')
  const set = (rgb) => {
    if (rgb) {
      player.style.setProperty('--gap-bg', rgb)
      sheet.style.setProperty('--np-color', rgb)
    } else {
      player.style.removeProperty('--gap-bg')
      sheet.style.removeProperty('--np-color')
    }
  }
  if (!url) { set(null); return }
  if (coverColorCache.has(url)) { set(coverColorCache.get(url)); return }
  set(null)
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.onload = () => {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 16
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, 16, 16)
      const px = ctx.getImageData(0, 0, 16, 16).data
      let r = 0, g = 0, b = 0, n = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 200) continue
        r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
      }
      if (!n) return
      r /= n; g /= n; b /= n
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      const k = lum > 85 ? 85 / lum : 1
      const rgb = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`
      coverColorCache.set(url, rgb)
      if (currentTrack && currentTrack.cover === url) set(rgb)
    } catch (err) {
      // A cover that can't be sampled (CORS, decode error) just keeps the default dark look.
    }
  }
  img.src = url
}

// Puts the track's name/artist/cover into the mini-player and the Now Playing
// sheet, and hands the same to the phone's lock screen / headset controls.
function loadTrackUI(meta) {
  const player = document.getElementById('global-audio-player')
  document.getElementById('gap-title').textContent = meta.name
  document.getElementById('gap-sub').textContent = meta.sub
  document.getElementById('np-title').textContent = meta.name
  document.getElementById('np-sub').textContent = meta.sub
  document.getElementById('np-album').textContent = meta.album
  document.getElementById('np-share').style.visibility = meta.shareUrl ? '' : 'hidden'
  ;['gap-cover', 'np-cover'].forEach(id => {
    const img = document.getElementById(id)
    if (meta.cover) {
      img.src = meta.cover
      img.alt = meta.album
      img.hidden = false
    } else {
      img.hidden = true
    }
  })
  player.style.display = 'flex'
  document.body.classList.add('audio-player-active')
  applyCoverColor(meta.cover)

  if ('mediaSession' in navigator && window.MediaMetadata) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.name,
        artist: meta.sub,
        album: meta.album,
        artwork: meta.cover ? [{ src: meta.cover }] : []
      })
    } catch (err) { /* lock-screen art is a nicety, never worth breaking playback */ }
  }
}

function initGlobalAudioPlayer() {
  const player = document.getElementById('global-audio-player')
  const sheet = document.getElementById('now-playing')
  const seekBar = document.getElementById('gap-seek')
  const fill = document.getElementById('gap-progress-fill')
  const elapsedEl = document.getElementById('np-elapsed')
  const remainingEl = document.getElementById('np-remaining')
  let dragging = false

  document.getElementById('np-prev').innerHTML = PREV_ICON_SVG
  document.getElementById('np-next').innerHTML = NEXT_ICON_SVG
  refreshPlayStateUI()

  const openSheet = () => {
    if (!currentTrack) return
    sheet.classList.add('open')
    sheet.setAttribute('aria-hidden', 'false')
    document.body.classList.add('np-open')
  }
  const closeSheet = () => {
    sheet.classList.remove('open')
    sheet.setAttribute('aria-hidden', 'true')
    document.body.classList.remove('np-open')
  }

  const showProgress = () => {
    const d = globalAudio.duration
    const t = globalAudio.currentTime
    const pct = d > 0 && isFinite(d) ? (t / d) * 100 : 0
    if (!dragging) {
      seekBar.value = pct
      seekBar.style.setProperty('--pct', pct + '%')
    }
    fill.style.width = pct + '%'
    elapsedEl.textContent = formatTime(t)
    remainingEl.textContent = d > 0 && isFinite(d) ? '-' + formatTime(d - t) : '0:00'
  }

  document.getElementById('gap-toggle').addEventListener('click', toggleGlobalPlayback)
  document.getElementById('np-toggle').addEventListener('click', toggleGlobalPlayback)
  document.getElementById('np-next').addEventListener('click', () => stepTrack(1))
  // Like every player: a second or two in, "previous" restarts the song; near
  // the start it goes to the track before.
  const goPrevious = async () => {
    if (globalAudio.currentTime > 3 || !(await stepTrack(-1))) globalAudio.currentTime = 0
  }
  document.getElementById('np-prev').addEventListener('click', goPrevious)

  const gapMain = document.getElementById('gap-main')
  gapMain.addEventListener('click', openSheet)
  gapMain.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet() }
  })
  document.getElementById('np-collapse').addEventListener('click', closeSheet)
  document.getElementById('np-share').addEventListener('click', () => {
    if (!currentTrack || !currentTrack.shareUrl) return
    openShareMenu({ url: currentTrack.shareUrl, name: currentTrack.name, album: currentTrack.album, cover: currentTrack.cover })
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.classList.contains('open')) closeSheet()
  })

  // Count a song once it has been listened to for 30 s. A song reached through a
  // shared song link counts as 'shared' so we can see whether sharing works.
  const landed = parseProductPath()
  watchPlays(globalAudio, () => currentTrack && ({
    productSlug: currentTrack.productSlug,
    trackSlug: currentTrack.trackSlug,
    trackName: currentTrack.name,
    source: (landed && landed.trackSlug && landed.slug === currentTrack.productSlug && landed.trackSlug === currentTrack.trackSlug) ? 'shared' : 'site'
  }))

  globalAudio.addEventListener('play', refreshPlayStateUI)
  globalAudio.addEventListener('pause', refreshPlayStateUI)
  globalAudio.addEventListener('timeupdate', showProgress)
  globalAudio.addEventListener('loadedmetadata', showProgress)

  globalAudio.addEventListener('ended', async () => {
    showProgress()
    refreshPlayStateUI()
    await stepTrack(1)
  })

  seekBar.addEventListener('pointerdown', () => { dragging = true })
  seekBar.addEventListener('pointerup', () => { dragging = false })
  seekBar.addEventListener('pointercancel', () => { dragging = false })
  seekBar.addEventListener('input', () => {
    seekBar.style.setProperty('--pct', seekBar.value + '%')
    if (!isNaN(globalAudio.duration) && globalAudio.duration > 0) {
      globalAudio.currentTime = (seekBar.value / 100) * globalAudio.duration
    }
  })

  document.getElementById('gap-close').addEventListener('click', () => {
    globalAudio.pause()
    globalAudio.currentTime = 0
    seekBar.value = 0
    seekBar.style.setProperty('--pct', '0%')
    fill.style.width = '0'
    player.style.display = 'none'
    document.body.classList.remove('audio-player-active')
    closeSheet()
    currentTrack = null
    playQueue = []
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null
    refreshPlayStateUI()
  })

  // Lock screen / headphones / car controls.
  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => globalAudio.play().catch(() => {}),
      pause: () => globalAudio.pause(),
      previoustrack: goPrevious,
      nexttrack: () => stepTrack(1),
      seekto: (d) => { if (d && typeof d.seekTime === 'number') globalAudio.currentTime = d.seekTime }
    }
    Object.entries(handlers).forEach(([action, fn]) => {
      try { navigator.mediaSession.setActionHandler(action, fn) } catch (err) { /* not supported here */ }
    })
  }
}

initGlobalAudioPlayer()
initShareMenu()

async function loadBodega() {
  const storeGrid = document.getElementById('store-grid')

  // INJECT 1: Custom styles overrides
  if (!document.getElementById('bodega-custom-styles')) {
    const style = document.createElement('style')
    style.id = 'bodega-custom-styles'
    style.innerHTML = `
      .tracklist-slider::-webkit-scrollbar { width: 3px; }
      .tracklist-slider::-webkit-scrollbar-track { background: #111; border-radius: 4px; }
      .tracklist-slider::-webkit-scrollbar-thumb { background: #00ffcc; border-radius: 4px; }
      .description { font-size: 0.55rem !important; line-height: 1.3 !important; }
      .size-tag { font-size: 0.48rem !important; padding: 0.15rem 0.3rem !important; }
    `
    document.head.appendChild(style)
  }

  // INJECT 2: Global Lightbox UI (Hidden by default)
  if (!document.getElementById('bodega-lightbox')) {
    const lightboxHTML = `
      <div id="bodega-lightbox" style="display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.92); z-index: 9999; justify-content: center; align-items: center; flex-direction: column; backdrop-filter: blur(5px);">
        <span id="lb-close" style="position: absolute; top: 20px; right: 30px; z-index: 1; color: white; font-size: 2.5rem; cursor: pointer; font-weight: bold; transition: color 0.2s;">&times;</span>
        <div style="display: flex; align-items: center; justify-content: center; width: 100%; max-width: 900px; position: relative;">
          <span id="lb-prev" style="color: #00ffcc; font-size: 3rem; cursor: pointer; padding: 20px; position: absolute; left: 0; user-select: none; transition: opacity 0.2s;">&#10094;</span>
          <img id="lb-img" style="max-width: 80vw; max-height: 80vh; object-fit: contain; border-radius: 4px; box-shadow: 0 10px 40px rgba(0,0,0,0.8);" src="" />
          <span id="lb-next" style="color: #00ffcc; font-size: 3rem; cursor: pointer; padding: 20px; position: absolute; right: 0; user-select: none; transition: opacity 0.2s;">&#10095;</span>
        </div>
        <div id="lb-counter" style="color: #00ffcc; margin-top: 15px; font-size: 0.8rem; letter-spacing: 2px; font-weight: bold;"></div>
      </div>
    `
    document.body.insertAdjacentHTML('beforeend', lightboxHTML)

    // Global Lightbox Logic
    window.lbImages = []
    window.lbCurrentIndex = 0

    document.getElementById('lb-close').onclick = () => document.getElementById('bodega-lightbox').style.display = 'none'
    
    window.updateLightbox = (dir) => {
      window.lbCurrentIndex += dir
      if (window.lbCurrentIndex < 0) window.lbCurrentIndex = window.lbImages.length - 1
      if (window.lbCurrentIndex >= window.lbImages.length) window.lbCurrentIndex = 0
      
      document.getElementById('lb-img').src = window.lbImages[window.lbCurrentIndex]
      document.getElementById('lb-counter').innerText = (window.lbCurrentIndex + 1) + " / " + window.lbImages.length
      
      // Hide arrows and counter if there is only 1 image
      const showControls = window.lbImages.length > 1 ? 'block' : 'none'
      document.getElementById('lb-prev').style.display = showControls
      document.getElementById('lb-next').style.display = showControls
      document.getElementById('lb-counter').style.display = showControls
    }

    document.getElementById('lb-prev').onclick = () => window.updateLightbox(-1)
    document.getElementById('lb-next').onclick = () => window.updateLightbox(1)

    window.openLightbox = (images, index) => {
      window.lbImages = images
      window.lbCurrentIndex = index
      document.getElementById('bodega-lightbox').style.display = 'flex'
      window.updateLightbox(0)
    }
  }

  // FETCH DATA
  // Explicit column list, not select('*') — stripe_url and stripe_product_id
  // are admin-only (only ever read in the edit modal/inventory list, never
  // by any storefront rendering code) and this is a public, unauthenticated
  // query. stripe_url in particular is a live, permanently price-frozen
  // Stripe Payment Link once one's been generated for a product — leaving
  // it in a public API response makes it discoverable by anyone, with no
  // relationship to the product's current (possibly since-changed) price.
  const { data: products, error } = await supabase.from('products').select(
    'id, title, type, price_cents, cover_art_url, image_2_url, image_3_url, gallery_images, description, sizes, audio_preview_url, tracklist_snippets, download_files, category, published, coming_soon, inventory_count, weight_oz, domestic_shipping_cents, international_shipping_cents, printful_variant_map, landing_slot, slug, pricing_mode, offer_min_cents, offer_max_cents, created_at, featured_order'
  ).eq('published', true)

  if (error) {
    console.error('Database connection error:', error)
    storeGrid.innerHTML = '<p style="font-size: 0.8rem;">Connection error. The Bodega is offline.</p>'
    return
  }

  if (!products || products.length === 0) {
    storeGrid.innerHTML = '<p style="font-size: 0.8rem;">The Bodega is currently empty. Add products in your Supabase dashboard.</p>'
    return
  }

  // Kept module-level so the popstate handler (fires on Back/Forward, long
  // after this function's own `products` local has gone out of scope) can
  // still resolve a URL back to a product.
  allProducts = products

  storeGrid.innerHTML = ''
  
  // BUILD CARDS
  products.forEach(product => {
   try {
    const flags = computeProductFlags(product)

    const card = document.createElement('div')
    card.className = 'product-card'
    card.setAttribute('data-category', displayCategory((product.category || '').toString().trim().toLowerCase()))
    card.setAttribute('data-product-id', product.id)
    card.innerHTML = renderProductMarkup(product, flags, { linkTitle: true, truncateDescription: true, showBuyControls: false, showDescription: false, showFullGallery: false, showAudioPreview: false })

    // A real <a href> so search engines can follow/index it and a bare
    // middle-click/ctrl-click/copy-link still gets the real URL — but a
    // plain left-click shows the dedicated product page in-app instead of
    // a full reload to a page the visitor was just clicking away from.
    const titleLink = card.querySelector('.product-title-link')
    if (titleLink) {
      titleLink.addEventListener('click', (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        showProductPage(product)
      })
    }

    // The rest of the card (photo, price/category text, size tags, or just
    // empty space) is a plain click-to-navigate area — audio preview
    // controls and the title link (handled above, with real link semantics)
    // are the only things carved out so they keep their own behavior.
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-play-btn, .track-item, .product-title-link, .share-btn')) return
      showProductPage(product)
    })

    wireProductInteractions(card, product, flags, { enableLightbox: false })
    storeGrid.appendChild(card)
   } catch (err) {
     console.error('Skipping product due to render error:', product, err)
   }
  })

  setupCategoryFilters()
  await loadLookbookPhotos()
  renderLandingPage(products)
  injectProductStructuredData(products)

  // A prerendered /products/<slug>/ page boots the exact same SPA bundle as
  // the homepage — this is what turns that static shell into the live,
  // interactive product card for a human visitor arriving from a search
  // result or shared link.
  const routedProduct = matchProductFromPath(products)
  if (routedProduct) {
    goToProduct(routedProduct)
    return
  }

  // A plain ?filter=<category> deep link — e.g. for the main website to
  // link straight into "browse all music" — since category filters are
  // otherwise pure in-app clicks with nothing reflected in the URL. Valid
  // values are read from the filter bar itself so this never drifts out of
  // sync with whatever categories actually exist.
  const filterParam = (new URLSearchParams(window.location.search).get('filter') || '').toLowerCase()
  const validFilters = Array.from(document.querySelectorAll('.filter-btn[data-filter]')).map(b => b.getAttribute('data-filter'))
  if (filterParam && validFilters.includes(filterParam)) {
    // Initial page load, not a navigation — nothing to push onto history yet.
    if (filterParam === 'home') {
      showLanding({ skipHistoryUpdate: true })
    } else {
      showStore(filterParam, { skipHistoryUpdate: true })
    }
    return
  }

  showLanding({ skipHistoryUpdate: true })
}

// Splits window.location.pathname into /products/<slug>/ and an optional
// <track> segment (/products/<slug>/<track>/ — the shareable per-song page).
function parseProductPath() {
  const match = window.location.pathname.match(/^\/products\/([^/]+)(?:\/([^/]+))?\/?$/)
  return match ? { slug: match[1], trackSlug: match[2] || null } : null
}

// Matches window.location.pathname against /products/<slug>/ — the path a
// prerendered page (see scripts/prerender-products.js) was served at. A
// per-track path resolves to its album's product.
function matchProductFromPath(products) {
  const parsed = parseProductPath()
  if (!parsed) return null
  return products.find(p => p.slug === parsed.slug) || null
}

// Every product this session has loaded — kept module-level so the popstate
// handler (fires long after loadBodega's own `products` local is gone) can
// still resolve the URL back to a product.
let allProducts = []

// Hardcoded rather than read from the live DOM at init: if the SPA happened
// to boot from a prerendered /products/<slug>/ page, the DOM's "current"
// values at that point would already be that product's tags, not the true
// homepage default — reading them would bake in the wrong reset target.
const SITE_URL = 'https://bodega.theinvisiblepanchos.com'
const DEFAULT_META = {
  title: 'Panchos Bodega | The Invisible Panchos',
  description: 'Official apparel, unreleased tracks, and digital downloads from The Invisible Panchos. Barrio roots, cosmic reach.',
  url: `${SITE_URL}/`,
  image: `${SITE_URL}/opensign.jpg`,
}

function setMetaAttr(selector, attr, value) {
  const el = document.querySelector(selector)
  if (el) el.setAttribute(attr, value)
}

function applyMetaTags({ title, description, url, image }) {
  document.title = title
  setMetaAttr('meta[name="description"]', 'content', description)
  setMetaAttr('link[rel="canonical"]', 'href', url)
  setMetaAttr('meta[property="og:url"]', 'content', url)
  setMetaAttr('meta[property="og:title"]', 'content', title)
  setMetaAttr('meta[property="og:description"]', 'content', description)
  setMetaAttr('meta[property="og:image"]', 'content', image)
  setMetaAttr('meta[name="twitter:title"]', 'content', title)
  setMetaAttr('meta[name="twitter:description"]', 'content', description)
  setMetaAttr('meta[name="twitter:image"]', 'content', image)
}

function setProductMetaTags(product) {
  applyMetaTags({
    title: `${product.title} | Panchos Bodega`,
    description: (product.description || '').slice(0, MAX_DESCRIPTION_LENGTH) || DEFAULT_META.description,
    url: `${SITE_URL}/products/${product.slug}/`,
    image: product.cover_art_url || DEFAULT_META.image,
  })
}

function resetMetaTagsToHomepage() {
  applyMetaTags(DEFAULT_META)
}

// Shared by every path that lands a visitor on a specific product (the
// title-link click, the landing carousel/side boxes via goToProduct,
// and the initial-load match) so the URL and tab title/meta always agree
// with whatever product is actually on screen.
function updateProductUrlAndMeta(product) {
  if (!product.slug) return
  const parsed = parseProductPath()
  const onThisProduct = !!parsed && parsed.slug === product.slug
  const track = onThisProduct && parsed.trackSlug ? findTrackBySlug(product, parsed.trackSlug) : null
  // Guards against a redundant history entry when this runs on the initial
  // load of that exact prerendered page (matchProductFromPath's own caller) —
  // including a per-track page, which must keep its own URL.
  if (!onThisProduct) {
    history.pushState(null, '', productPath(product.slug))
  } else if (parsed.trackSlug && !track) {
    // A track segment that isn't one of this product's songs: fall back to the product's own URL.
    history.replaceState(null, '', productPath(product.slug))
  }
  if (track) setTrackMetaTags(product, track)
  else setProductMetaTags(product)
}

function setTrackMetaTags(product, track) {
  const { title, description } = trackMeta(product, track)
  applyMetaTags({
    title,
    description,
    url: `${SITE_URL}${trackPath(product.slug, track.slug)}`,
    image: product.cover_art_url || DEFAULT_META.image,
  })
}

// Arriving on /products/<slug>/<track>/ (a shared link): mark that song's row
// and put a "Shared with you" strip with a Play button above the tracklist.
// Browsers don't allow music to start by itself on page load, so the visitor
// taps Play. Returns true if it found the song.
function focusSharedTrack(product, content) {
  const parsed = parseProductPath()
  if (!parsed || parsed.slug !== product.slug || !parsed.trackSlug) return false
  const track = findTrackBySlug(product, parsed.trackSlug)
  const list = content.querySelector('.album-player-container')
  if (!track || !list) return false
  const row = [...list.querySelectorAll('.track-item')].find(r => r.dataset.trackSlug === track.slug)
  if (!row) return false

  row.classList.add('is-shared')
  const banner = document.createElement('div')
  banner.className = 'shared-track-banner'
  banner.innerHTML = '<span class="shared-track-text"><span class="shared-track-label">Shared with you</span><span class="shared-track-name"></span></span>' +
    `<button type="button" class="shared-track-play">${PLAY_ICON_SVG} Play</button>`
  banner.querySelector('.shared-track-name').textContent = track.name
  banner.querySelector('.shared-track-play').addEventListener('click', () => row.click())
  list.insertBefore(banner, list.firstChild)
  banner.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return true
}

// Back/Forward doesn't touch the visible filter/scroll state (a title-link
// click never did either) — it only needs to keep the tab title/meta honest
// about whatever URL the visitor has landed back on.
// Doesn't try to restore whatever filter/landing state was showing before a
// product page — Back just goes to the dedicated product page for a product
// URL, or the landing page otherwise. Full browsing-history fidelity (e.g.
// returning to the exact category filter you were on) isn't attempted here.
window.addEventListener('popstate', () => {
  // The admin has its own popstate handling (section -> menu); don't redraw the hidden storefront.
  if (new URLSearchParams(window.location.search).get('mode') === 'admin') return
  const match = matchProductFromPath(allProducts)
  if (match) {
    showProductPage(match)
  } else {
    // The browser already moved history here — pushing '/' again would
    // corrupt the stack we're in the middle of navigating.
    showLanding({ skipHistoryUpdate: true })
  }
})

function injectProductStructuredData(products) {
  const items = products
    .filter(p => p.title)
    .map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Product',
        name: p.title,
        description: (p.description || '').slice(0, MAX_DESCRIPTION_LENGTH),
        image: p.cover_art_url || undefined,
        sku: String(p.id),
        offers: {
          '@type': 'Offer',
          price: ((p.price_cents || 0) / 100).toFixed(2),
          priceCurrency: 'USD',
          availability: p.coming_soon
            ? 'https://schema.org/PreOrder'
            : (p.inventory_count != null && p.inventory_count <= 0)
              ? 'https://schema.org/OutOfStock'
              : 'https://schema.org/InStock',
          url: p.slug
            ? `https://bodega.theinvisiblepanchos.com/products/${p.slug}/`
            : 'https://bodega.theinvisiblepanchos.com/'
        }
      }
    }))

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: items
  }

  let script = document.getElementById('product-jsonld')
  if (!script) {
    script = document.createElement('script')
    script.id = 'product-jsonld'
    script.type = 'application/ld+json'
    document.head.appendChild(script)
  }
  script.textContent = JSON.stringify(jsonLd)
}

// INJECT 3: Category Filter Bar Logic (local DOM filtering, no re-fetch)
// applyFilter is hoisted to module scope so the landing page can hand the
// visitor straight into a specific category.
let applyFilter = () => {}

// Mobile (<=768px) swaps the horizontally-scrolling category bar for a
// pop-out dropdown — a scrollbar-thin strip of buttons was easy to mistake
// for the entire menu. Desktop is untouched.
function closeMobileNav() {
  const scroll = document.getElementById('filter-scroll')
  const toggle = document.getElementById('mobile-nav-toggle')
  if (scroll) scroll.classList.remove('mobile-open')
  if (toggle) toggle.setAttribute('aria-expanded', 'false')
}

function setupCategoryFilters() {
  const filterButtons = document.querySelectorAll('.filter-btn[data-filter]')

  applyFilter = (filter) => {
    filterButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === filter))

    const cards = document.querySelectorAll('.product-card')
    cards.forEach(card => {
      const matches = filter === 'all' || card.getAttribute('data-category') === filter
      card.style.display = matches ? '' : 'none'
    })
  }

  // Picking a category means "take me to the shelves"; HOME is the one
  // button that goes to the landing page instead.
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter')
      if (filter === 'home') {
        showLanding()
      } else {
        showStore(filter)
      }
    })
  })

  const footerLogoBtn = document.getElementById('footer-logo-filter')
  if (footerLogoBtn) {
    footerLogoBtn.addEventListener('click', () => showLanding())
  }

  const mobileNavToggle = document.getElementById('mobile-nav-toggle')
  const filterScroll = document.getElementById('filter-scroll')
  if (mobileNavToggle && filterScroll) {
    mobileNavToggle.addEventListener('click', () => {
      const isOpen = filterScroll.classList.toggle('mobile-open')
      mobileNavToggle.setAttribute('aria-expanded', String(isOpen))
    })
    document.addEventListener('click', (e) => {
      if (!filterScroll.classList.contains('mobile-open')) return
      if (filterScroll.contains(e.target) || mobileNavToggle.contains(e.target)) return
      closeMobileNav()
    })
  }

  applyFilter('all')
}

// LANDING PAGE — the first thing a visitor sees after the Enter gate.
// Everything it shows is driven by each product's `landing_slot`.
let landingFeatured = []
let landingIndex = 0
let landingTimer = null
const LANDING_ROTATE_MS = 5000

function productImages(product) {
  const images = []
  if (product.cover_art_url) images.push(product.cover_art_url)
  if (product.image_2_url) images.push(product.image_2_url)
  if (product.image_3_url) images.push(product.image_3_url)
  if (Array.isArray(product.gallery_images)) images.push(...product.gallery_images)
  return images
}

// `skipHistoryUpdate` is true only when the browser itself already changed
// the URL (a popstate) or on the very first page load — anywhere else this
// runs from a click, so if the visitor was looking at a product page, that
// needs its own history entry back to '/'. Without it, leaving a product via
// this button/tab/link never touched history at all, so two products
// visited in a row pushed straight onto each other with no grid entry
// between them — Back from the second product landed on the first, not on
// the grid you'd actually just been looking at.
function showLanding({ skipHistoryUpdate = false } = {}) {
  // The admin panel owns the whole viewport — never surface the storefront
  // landing page underneath it.
  if (new URLSearchParams(window.location.search).get('mode') === 'admin') return

  const landing = document.getElementById('landing-view')
  const storeGrid = document.getElementById('store-grid')
  if (!landing || !storeGrid) return

  if (!skipHistoryUpdate && matchProductFromPath(allProducts)) {
    history.pushState(null, '', '/')
  }

  // Nothing slotted yet — don't strand the visitor on an empty page.
  if (landing.getAttribute('data-empty') === 'true') {
    showStore('all', { skipHistoryUpdate: true })
    return
  }

  hideProductPage()
  landing.style.display = 'flex'
  storeGrid.style.display = 'none'
  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === 'home'))
  resetMetaTagsToHomepage()
  startLandingRotation()
  closeMobileNav()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// See showLanding's comment for why skipHistoryUpdate exists.
function showStore(filter = 'all', { skipHistoryUpdate = false } = {}) {
  const landing = document.getElementById('landing-view')
  const storeGrid = document.getElementById('store-grid')
  if (!storeGrid) return

  if (!skipHistoryUpdate && matchProductFromPath(allProducts)) {
    history.pushState(null, '', '/')
  }

  hideProductPage()
  if (landing) landing.style.display = 'none'
  stopLandingRotation()
  storeGrid.style.display = 'grid'
  // A filter that matches no tab (e.g. a raw category with no filter of its
  // own — this is exactly how the "Back to the Bodega" bug happened)
  // previously fell through to applyFilter silently hiding every card,
  // since no card's data-category could match it either. Falling back to
  // 'all' here means a bad filter value is merely wrong, not a blank page.
  const validFilters = Array.from(document.querySelectorAll('.filter-btn[data-filter]')).map(b => b.getAttribute('data-filter'))
  applyFilter(validFilters.includes(filter) ? filter : 'all')
  resetMetaTagsToHomepage()
  closeMobileNav()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function hideProductPage() {
  const view = document.getElementById('product-view')
  if (view) view.style.display = 'none'
}

// The dedicated single-product page — a real product-detail view, not just
// the grid with a card scrolled into focus. Built from the same
// renderProductMarkup/wireProductInteractions the grid card uses, just with
// the title unlinked (a page doesn't need to link to itself) and the full
// untruncated description (the grid card's length cap exists for a small
// tile, which doesn't apply here).
function showProductPage(product) {
  if (new URLSearchParams(window.location.search).get('mode') === 'admin') return

  const view = document.getElementById('product-view')
  const content = document.getElementById('product-view-content')
  const landing = document.getElementById('landing-view')
  const storeGrid = document.getElementById('store-grid')
  if (!view || !content) return

  if (landing) landing.style.display = 'none'
  if (storeGrid) storeGrid.style.display = 'none'
  stopLandingRotation()
  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.remove('active'))
  closeMobileNav()

  const flags = computeProductFlags(product)
  content.innerHTML = renderProductMarkup(product, flags, { linkTitle: false, truncateDescription: false, showBuyControls: true, showDescription: true, showFullGallery: true, showAudioPreview: true })
  wireProductInteractions(content, product, flags, { enableLightbox: true })

  const backBtn = document.getElementById('product-back-btn')
  if (backBtn) {
    // Must go through displayCategory — a Printful category has no filter
    // tab of its own (see isPrintfulCategory/displayCategory above), so
    // using the raw category here filtered every card out silently instead
    // of falling back to a real tab (confirmed live: this exact bug, found
    // and fixed 2026-09-12).
    backBtn.onclick = () => showStore(displayCategory((product.category || '').toString().trim().toLowerCase()) || 'all')
  }

  view.style.display = 'block'
  updateProductUrlAndMeta(product)
  if (!focusSharedTrack(product, content)) window.scrollTo({ top: 0, behavior: 'smooth' })
}

// Sends the visitor from a landing box (carousel photo, Latest Release,
// Panchos Pick) or the initial /products/<slug>/ route match to that
// product's dedicated page.
function goToProduct(product) {
  showProductPage(product)
}

function startLandingRotation() {
  stopLandingRotation()
  if (landingFeatured.length < 2) return
  landingTimer = setInterval(() => {
    setLandingSlide((landingIndex + 1) % landingFeatured.length)
  }, LANDING_ROTATE_MS)
}

function stopLandingRotation() {
  if (landingTimer) clearInterval(landingTimer)
  landingTimer = null
}

function setLandingSlide(index) {
  landingIndex = index
  const track = document.getElementById('landing-carousel-track')
  if (track) track.style.transform = `translateX(-${index * 100}%)`
  document.querySelectorAll('.landing-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === index)
  })
  renderLandingDetail(landingFeatured[index])
}

// The description panel beside the carousel. Mirrors the product card's
// buy logic (size gate, free downloads, inert states) rather than assuming
// every featured product is a plain paid item.
// No buy controls here by design — the featured panel is informational
// (title/price/category/description); purchasing happens on the product's
// own dedicated page.
function renderLandingDetail(product) {
  const detail = document.getElementById('landing-detail')
  if (!detail || !product) return

  const pricingMode = product.pricing_mode || 'standard'
  const isFree = pricingMode === 'free' || (pricingMode === 'standard' && (product.price_cents || 0) === 0)
  const formattedPrice =
    product.category === 'services' ? (isFree ? 'Custom Pricing' : `Starting at $${((product.price_cents || 0) / 100).toFixed(2)}`) :
    pricingMode === 'offer_based' ? (product.offer_min_cents != null ? `From $${(product.offer_min_cents / 100).toFixed(2)}` : 'Name Your Price') :
    isFree ? 'FREE' : `$${((product.price_cents || 0) / 100).toFixed(2)}`

  ensureLandingDetailSkeleton(detail)
  document.getElementById('landing-detail-text').innerHTML = `
    <h3 class="landing-detail-title">${product.title}</h3>
    <p class="landing-detail-price">${formattedPrice}</p>
    <p class="landing-detail-category">${(displayCategory(product.category) || 'uncategorized').toUpperCase()}</p>
    ${product.description ? `<p class="landing-detail-description">${product.description.slice(0, MAX_DESCRIPTION_LENGTH)}</p>` : ''}
  `
  // Reassigned on every slide change so it always points at whichever
  // product is currently showing, same as the side boxes.
  detail.onclick = (e) => {
    if (e.target.closest('#landing-lookbook')) return // ad photos aren't product links
    goToProduct(product)
  }
}

// LOOK BOOK — one shared set of up to 4 ad / look-book photos (table
// lookbook_photos), shown as a scrolling strip under the description in the
// Featured detail panel. Not tied to any one product. See the admin side
// (loadAdminLookbook) for how photos get added and the oldest dropped.
const LOOKBOOK_MAX = 4
let lookbookPhotos = []

async function loadLookbookPhotos() {
  const { data, error } = await supabase
    .from('lookbook_photos')
    .select('id, image_url, source, created_at')
    .order('created_at', { ascending: true })
  if (error) {
    // A missing look book must never take the storefront down with it.
    console.error('Failed to load look book photos:', error)
    lookbookPhotos = []
    return
  }
  lookbookPhotos = (data || []).slice(-LOOKBOOK_MAX)
}

// Same behavior as the Featured carousel (slide transition, dots, pause on
// hover, LANDING_ROTATE_MS rotation) but with its own index/timer, started half
// an interval out of phase so the two never change at the same moment. Built
// once into a persistent #landing-lookbook — renderLandingDetail rewrites only
// the text above it, so a Featured slide change doesn't restart this.
let lookbookIndex = 0
let lookbookTimer = null
let lookbookStartTimeout = null

function stopLookbookRotation() {
  if (lookbookTimer) clearInterval(lookbookTimer)
  if (lookbookStartTimeout) clearTimeout(lookbookStartTimeout)
  lookbookTimer = null
  lookbookStartTimeout = null
}

function advanceLookbook() {
  setLookbookSlide((lookbookIndex + 1) % lookbookPhotos.length)
}

// offsetMs: delay before the first advance (half an interval on first load,
// to stay out of phase with Featured; a full interval after hover/dot clicks).
function startLookbookRotation(offsetMs = LANDING_ROTATE_MS) {
  stopLookbookRotation()
  if (lookbookPhotos.length < 2) return
  lookbookStartTimeout = setTimeout(() => {
    advanceLookbook()
    lookbookTimer = setInterval(advanceLookbook, LANDING_ROTATE_MS)
  }, offsetMs)
}

function setLookbookSlide(index) {
  lookbookIndex = index
  const track = document.getElementById('landing-lookbook-track')
  if (track) track.style.transform = `translateX(-${index * 100}%)`
  document.querySelectorAll('.lookbook-dot').forEach((dot, i) => dot.classList.toggle('active', i === index))
}

function renderLookbookCarousel() {
  const el = document.getElementById('landing-lookbook')
  if (!el) return
  stopLookbookRotation()
  if (lookbookPhotos.length === 0) {
    el.style.display = 'none'
    el.innerHTML = ''
    return
  }
  el.style.display = 'block'
  el.innerHTML = `
    <div class="landing-lookbook-track" id="landing-lookbook-track">
      ${lookbookPhotos.map(p => `<div class="landing-lookbook-slide"><img src="${p.image_url}" alt="The Invisible Panchos look book" loading="lazy" decoding="async"></div>`).join('')}
    </div>
    <div class="landing-lookbook-dots">
      ${lookbookPhotos.length > 1 ? lookbookPhotos.map((_p, i) => `<button type="button" class="lookbook-dot" data-idx="${i}" aria-label="Look book photo ${i + 1}"></button>`).join('') : ''}
    </div>
  `
  el.querySelectorAll('.lookbook-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      setLookbookSlide(parseInt(dot.getAttribute('data-idx'), 10))
      startLookbookRotation()
    })
  })
  // Pause-on-hover only where a real hover exists — on a phone a tap leaves
  // mouseenter "stuck" with no matching mouseleave, which would freeze it.
  if (window.matchMedia('(hover: hover)').matches) {
    el.onmouseenter = stopLookbookRotation
    el.onmouseleave = () => startLookbookRotation()
  }
  lookbookIndex = 0
  setLookbookSlide(0)
  // Half an interval out of phase with the Featured carousel.
  startLookbookRotation(LANDING_ROTATE_MS / 2)
}

// The detail panel is two parts: a text area that is rewritten on every
// Featured slide change, and the persistent Look Book below it.
function ensureLandingDetailSkeleton(detail) {
  if (document.getElementById('landing-detail-text')) return
  detail.innerHTML = '<div id="landing-detail-text"></div><div class="landing-lookbook" id="landing-lookbook"></div>'
  renderLookbookCarousel()
}

function renderLandingSideBox(el, product, label) {
  if (!el) return

  if (!product) {
    el.style.display = 'none'
    return
  }

  el.style.display = 'flex'
  const image = productImages(product)[0]
  el.innerHTML = `
    <span class="landing-side-label">${label}</span>
    ${image ? `<img src="${image}" alt="${product.title}">` : ''}
    <span class="landing-side-title">${product.title}</span>
    <span class="landing-side-cta">View Product</span>
  `
  el.onclick = () => goToProduct(product)
}

// Renders however many Spotlight products are actually assigned (1-4) —
// the column count is set to match, so a partial set still fills the row
// evenly instead of leaving empty grid cells (a fixed 4-column grid would
// do that with only 1-3 items).
function renderLandingSpotlight(el, products) {
  if (!el) return

  if (products.length === 0) {
    el.style.display = 'none'
    return
  }

  el.style.display = 'grid'
  el.style.gridTemplateColumns = `repeat(${products.length}, 1fr)`
  el.innerHTML = products.map((p, idx) => {
    const image = productImages(p)[0]
    // Alternates in pairs by position, not per-product config: 1st and 2nd
    // boxes gold, 3rd and 4th red.
    const colorClass = Math.floor(idx / 2) % 2 === 0 ? 'spotlight-gold' : 'spotlight-red'
    return `
      <button type="button" class="landing-spotlight-box ${colorClass}" data-product-id="${p.id}">
        ${image ? `<img src="${image}" alt="${p.title}" loading="lazy" decoding="async">` : ''}
        <span class="landing-spotlight-title">${p.title}</span>
        <span class="landing-spotlight-cta">View Product</span>
      </button>
    `
  }).join('')

  el.querySelectorAll('.landing-spotlight-box').forEach(box => {
    const match = products.find(p => p.id === box.getAttribute('data-product-id'))
    if (match) box.onclick = () => goToProduct(match)
  })
}

function renderLandingPage(products) {
  const landing = document.getElementById('landing-view')
  if (!landing) return

  landingFeatured = products.filter(p => p.landing_slot === 'featured').sort(byFeaturedOrder).slice(0, MAX_FEATURED_PRODUCTS)
  const latestRelease = products.find(p => p.landing_slot === 'latest_release') || null
  const panchoPick = products.find(p => p.landing_slot === 'pancho_pick') || null
  const landingSpotlight = products.filter(p => p.landing_slot === 'spotlight').slice(0, MAX_SPOTLIGHT_PRODUCTS)

  const hasContent = landingFeatured.length > 0 || latestRelease || panchoPick || landingSpotlight.length > 0
  landing.setAttribute('data-empty', hasContent ? 'false' : 'true')
  if (!hasContent) return

  const track = document.getElementById('landing-carousel-track')
  const dots = document.getElementById('landing-carousel-dots')
  const carousel = document.getElementById('landing-carousel')
  const featuredLabel = document.getElementById('landing-featured-label')

  if (landingFeatured.length === 0) {
    carousel.style.display = 'none'
    featuredLabel.style.display = 'none'
    document.getElementById('landing-detail').style.display = 'none'
  } else {
    featuredLabel.style.display = 'inline-block'
    track.innerHTML = landingFeatured.map(p => {
      const image = productImages(p)[0]
      return `<div class="landing-carousel-slide">${image
        ? `<img src="${image}" alt="${p.title}" data-product-id="${p.id}" loading="lazy" decoding="async">`
        : '<div class="no-image">NO IMAGE</div>'}</div>`
    }).join('')

    dots.innerHTML = landingFeatured.length > 1
      ? landingFeatured.map((_p, i) => `<button type="button" class="landing-dot" data-idx="${i}" aria-label="Featured item ${i + 1}"></button>`).join('')
      : ''

    dots.querySelectorAll('.landing-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        setLandingSlide(parseInt(dot.getAttribute('data-idx'), 10))
        startLandingRotation()
      })
    })

    // Clicking the photo itself goes to that product's card.
    track.querySelectorAll('img[data-product-id]').forEach(img => {
      img.addEventListener('click', () => {
        const match = landingFeatured.find(p => p.id === img.getAttribute('data-product-id'))
        if (match) goToProduct(match)
      })
    })

    carousel.addEventListener('mouseenter', stopLandingRotation)
    carousel.addEventListener('mouseleave', startLandingRotation)

    setLandingSlide(0)
  }

  renderLandingSideBox(document.getElementById('landing-latest-release'), latestRelease, 'Latest Release')
  renderLandingSideBox(document.getElementById('landing-pancho-pick'), panchoPick, 'Panchos Pick')
  renderLandingSpotlight(document.getElementById('landing-spotlight'), landingSpotlight)

  const shopNowBtn = document.getElementById('landing-shop-now')
  if (shopNowBtn) shopNowBtn.addEventListener('click', () => showStore('all'))
}

// INJECT 4: First-visit "Enter" gate. Shown once per browser session (sessionStorage),
// so it reappears only after the visitor closes/leaves and comes back in a new tab/session.
function initEnterOverlay() {
  const overlay = document.getElementById('enter-overlay')
  const enterBtn = document.getElementById('enter-btn')
  if (!overlay || !enterBtn) return

  // A link straight to a product or song (/products/<slug>/...) goes right to
  // it — the gate is only the front door of the main address. Counts as having
  // entered, so going Home or refreshing in that session doesn't show it either.
  if (parseProductPath()) sessionStorage.setItem('bodegaEntered', 'true')

  if (sessionStorage.getItem('bodegaEntered') !== 'true') {
    overlay.style.display = 'flex'
    document.body.classList.add('overlay-open')
  }

  enterBtn.addEventListener('click', () => {
    sessionStorage.setItem('bodegaEntered', 'true')
    overlay.style.display = 'none'
    document.body.classList.remove('overlay-open')
  })
}

// TIP MODAL — presets plus a custom amount, handed to create-tip-session,
// which re-checks the bounds server-side (this is the one amount on the site
// the customer picks, so the client value is a suggestion, never the source
// of truth).
const TIP_MIN = 1
const TIP_MAX = 500

function openTipModal() {
  document.getElementById('tip-amount').value = ''
  document.getElementById('tip-name').value = ''
  document.getElementById('tip-message').value = ''
  document.getElementById('tip-status').textContent = ''
  document.querySelectorAll('.tip-preset-btn').forEach(b => b.classList.remove('selected'))
  document.getElementById('tip-modal').style.display = 'flex'
}

function closeTipModal() {
  document.getElementById('tip-modal').style.display = 'none'
}

function initTipModal() {
  const openBtn = document.getElementById('tip-open-btn')
  const modal = document.getElementById('tip-modal')
  if (!openBtn || !modal) return

  const amountInput = document.getElementById('tip-amount')
  const submitBtn = document.getElementById('tip-submit-btn')
  const statusEl = document.getElementById('tip-status')

  openBtn.addEventListener('click', openTipModal)
  // The footer jar is a second door into the same modal.
  const jarBtn = document.getElementById('tip-jar-btn')
  if (jarBtn) jarBtn.addEventListener('click', openTipModal)
  document.getElementById('tip-cancel-btn').addEventListener('click', closeTipModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeTipModal() })

  // Presets and the custom field are two views of one value — picking either
  // clears the other so there's never an ambiguous "which amount wins".
  document.querySelectorAll('.tip-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tip-preset-btn').forEach(b => b.classList.toggle('selected', b === btn))
      amountInput.value = btn.getAttribute('data-amount')
      statusEl.textContent = ''
    })
  })

  amountInput.addEventListener('input', () => {
    document.querySelectorAll('.tip-preset-btn').forEach(b => {
      b.classList.toggle('selected', b.getAttribute('data-amount') === amountInput.value)
    })
  })

  submitBtn.addEventListener('click', async () => {
    const dollars = parseFloat(amountInput.value)
    if (!Number.isFinite(dollars) || dollars < TIP_MIN) {
      statusEl.textContent = `Enter an amount of $${TIP_MIN} or more.`
      statusEl.style.color = '#ff4d4d'
      return
    }
    if (dollars > TIP_MAX) {
      statusEl.textContent = `$${TIP_MAX} is the max here — reach out directly for anything bigger.`
      statusEl.style.color = '#ff4d4d'
      return
    }

    submitBtn.disabled = true
    statusEl.textContent = 'Sending you to checkout...'
    statusEl.style.color = '#e8b923'

    try {
      const { data, error } = await supabase.functions.invoke('create-tip-session', {
        body: {
          amountCents: Math.round(dollars * 100),
          name: document.getElementById('tip-name').value.trim(),
          message: document.getElementById('tip-message').value.trim(),
        }
      })
      if (error) throw error
      if (!data?.url) throw new Error('Could not start checkout. Try again in a moment.')
      window.location.href = data.url
    } catch (err) {
      statusEl.textContent = await describeFunctionError(err)
      statusEl.style.color = '#ff4d4d'
      submitBtn.disabled = false
    }
  })
}

initFreeDownloadModal()
initServiceInquiryModal()
initOfferModal()
initReserveModal()
initFeaturedFullModal()
initPrintfulLookupModal()
initShippingCheckoutModal()
initCartModal()
initTipModal()
updateCartBadge()

const isAdminMode = initAdminPortal()
if (!isAdminMode) {
  loadBodega()
  initEnterOverlay()
  initInAppBrowserNotice()
}

