import { createClient } from '@supabase/supabase-js'
import { loadStripe } from '@stripe/stripe-js'
import { getCart, addToCart, removeFromCart, setCartQuantity, cartCount, cartSubtotalCents, cartHasPhysicalItems } from './cart.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ADMIN PORTAL
let editingProduct = null

async function loadAdminInventory() {
  const listEl = document.getElementById('admin-inventory-list')
  if (!listEl) return

  const { data: products, error } = await supabase.from('products').select('*')

  if (error) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #ff4d4d;">Failed to load inventory.</p>'
    return
  }

  if (!products || products.length === 0) {
    listEl.innerHTML = '<p style="font-size: 0.65rem; color: #888;">No products yet.</p>'
    return
  }

  listEl.innerHTML = ''

  products.forEach(product => {
    const item = document.createElement('div')
    item.className = 'inventory-item'
    const isPublished = product.published !== false
    const isFree = (product.price_cents || 0) === 0
    const hasStripeUrl = !!(product.stripe_url && product.stripe_url.trim())
    const trackCount = Array.isArray(product.tracklist_snippets) ? product.tracklist_snippets.length : 0
    const isTracked = product.inventory_count != null
    const isSoldOut = isTracked && product.inventory_count <= 0
    item.innerHTML = `
      <div class="inventory-item-info">
        <div class="inventory-item-title">${product.title || 'Untitled'}</div>
        <div class="inventory-item-meta">${isFree ? 'FREE' : `$${((product.price_cents || 0) / 100).toFixed(2)}`} — ${(product.category || 'uncategorized').toUpperCase()}${trackCount > 0 ? ` — ${trackCount} TRACKS` : ''}${isTracked ? ` — ${product.inventory_count} IN STOCK` : ''}</div>
        <span class="inventory-status-badge ${isPublished ? 'status-published' : 'status-draft'}">${isPublished ? 'Published' : 'Draft'}</span>
        ${isFree ? '<span class="inventory-status-badge status-free">Free</span>' : ''}
        ${isSoldOut ? '<span class="inventory-status-badge status-warning">Sold Out</span>' : ''}
        ${(!isFree && !hasStripeUrl) ? '<span class="inventory-status-badge status-warning">No Checkout Link</span>' : ''}
      </div>
      <div class="inventory-item-actions">
        <button type="button" class="inventory-edit-btn">Edit</button>
        <button type="button" class="inventory-delete-btn">Delete</button>
      </div>
    `
    item.querySelector('.inventory-edit-btn').addEventListener('click', () => openEditModal(product))
    item.querySelector('.inventory-delete-btn').addEventListener('click', () => deleteProduct(product))
    listEl.appendChild(item)
  })
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
    const items = Array.isArray(order.order_items) ? order.order_items : []
    const itemsSummary = items.length > 0
      ? items.map(oi => `${oi.quantity > 1 ? `${oi.quantity} × ` : ''}${oi.product_title}${oi.size ? ` — Size ${oi.size}` : ''}`).join(', ')
      : (order.product_title || 'Order')

    const statusLabel = order.label_status === 'purchased' ? 'Label Ready' : order.label_status === 'failed' ? 'Label Failed' : 'Label Pending'

    item.innerHTML = `
      <div class="order-item-title">${itemsSummary}</div>
      <div class="order-item-meta">
        ${amount} — ${orderDate}${order.customer_email ? `<br><strong>Email:</strong> ${order.customer_email}` : ''}
        ${hasShipping ? `<br><strong>Ship to:</strong> ${addressLines || 'No address on file'}` : '<br><strong>Digital order</strong> — no shipping required'}
        ${order.shipping_service ? `<br><strong>Service:</strong> ${order.shipping_service}` : ''}
        ${order.tracking_number ? `<br><strong>Tracking:</strong> ${order.tracking_number}` : ''}
        ${hasShipping && order.label_status === 'failed' && order.label_error ? `<br><strong>Error:</strong> ${order.label_error}` : ''}
      </div>
      ${hasShipping ? `<span class="order-status-badge status-${order.label_status}">${statusLabel}</span>` : ''}
      <div class="order-item-actions">
        ${hasShipping ? (order.label_status === 'purchased'
          ? `<a href="${order.label_url}" target="_blank" rel="noopener noreferrer">Print Label</a>`
          : `<button type="button" class="buy-label-btn">${order.label_status === 'failed' ? 'Retry Label' : 'Buy Label'}</button>`
        ) : ''}
        ${order.tracking_url ? `<a href="${order.tracking_url}" target="_blank" rel="noopener noreferrer">Track</a>` : ''}
        ${hasShipping ? `<button type="button" class="mark-shipped-btn">Mark Shipped</button>` : ''}
      </div>
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

const AUDIO_URL_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']

function isAudioUrl(url) {
  if (!url) return false
  const clean = url.split('?')[0].toLowerCase()
  return AUDIO_URL_EXTENSIONS.some(ext => clean.endsWith(ext))
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

async function uploadToVault(file) {
  const path = `${Date.now()}-${file.name}`
  const { error } = await supabase.storage.from('audio-vault').upload(path, file)
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
async function processDigitalFiles(fileInputId) {
  // The browser's file picker can hand back a multi-select in click order
  // rather than filename order, which would otherwise number tracks in
  // whatever order they happened to be selected. Sort by filename first
  // (numeric-aware, so "2 - Song.mp3" sorts before "10 - Song.mp3") so
  // track numbering follows the filenames instead.
  const files = Array.from(document.getElementById(fileInputId).files)
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

// Uploads every image currently selected in the given file input to
// bodega-images. The first becomes the product's main/cover photo; the rest
// become the scrollable gallery.
async function processImageFiles(fileInputId) {
  const files = Array.from(document.getElementById(fileInputId).files)
  if (files.length === 0) {
    return { coverUrl: null, galleryImages: null }
  }

  const urls = []
  for (const file of files) {
    const path = `${Date.now()}-${file.name}`
    const { error } = await supabase.storage.from('bodega-images').upload(path, file)
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

function updateSizesVisibility(categoryValue, groupId) {
  document.getElementById(groupId).style.display = categoryValue === 'apparel' ? 'block' : 'none'
}

function updateWeightVisibility(categoryValue, groupId) {
  document.getElementById(groupId).style.display = SHIPPABLE_CATEGORIES.includes(categoryValue) ? 'block' : 'none'
}

// Shows small thumbnails of whichever files are currently selected in a
// photo file input, so the admin can see what they're about to upload
// before submitting.
function previewSelectedImages(fileInput, previewEl) {
  const files = Array.from(fileInput.files)
  previewEl.innerHTML = files
    .map(file => `<img src="${URL.createObjectURL(file)}" alt="${file.name}">`)
    .join('')
}

// The edit form's existing-photo thumbnails, each with a remove button —
// separate from previewSelectedImages's newly-picked-file preview so newly
// added photos never clobber this list. Saving combines whatever's left
// here with any newly selected files, so editing photos is additive
// (add more, remove individual ones) instead of replace-the-whole-set.
let editKeptImages = []

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
  document.getElementById('edit-price').value = product.price_cents != null ? (product.price_cents / 100).toFixed(2) : ''
  document.getElementById('edit-inventory').value = product.inventory_count != null ? product.inventory_count : ''
  document.getElementById('edit-stripe-product-id').value = product.stripe_product_id || ''
  document.getElementById('edit-description').value = product.description || ''
  document.getElementById('edit-category').value = product.category || ''
  document.getElementById('edit-sizes').value = product.sizes || ''
  document.getElementById('edit-weight').value = product.weight_oz != null ? product.weight_oz : ''
  updateSizesVisibility(product.category, 'edit-sizes-group')
  updateWeightVisibility(product.category, 'edit-weight-group')
  document.getElementById('edit-image').value = ''
  document.getElementById('edit-file').value = ''
  document.getElementById('edit-image-new-preview').innerHTML = ''

  editKeptImages = [product.cover_art_url, product.image_2_url, product.image_3_url]
    .concat(Array.isArray(product.gallery_images) ? product.gallery_images : [])
    .filter(Boolean)
  renderEditImagePreview()

  const trackCount = Array.isArray(product.tracklist_snippets) ? product.tracklist_snippets.length : 0
  const fileCount = Array.isArray(product.download_files) ? product.download_files.length : 0
  const currentFileInfo = document.getElementById('edit-file-current-info')
  currentFileInfo.textContent = trackCount > 0
    ? `Currently: ${trackCount}-track album`
    : fileCount > 1
      ? `Currently: ${fileCount}-file bundle`
      : product.audio_preview_url
        ? 'Currently: digital file attached'
        : 'Currently: no digital file attached'

  document.getElementById('edit-stripe-url').value = product.stripe_url || ''
  document.getElementById('edit-published').checked = product.published !== false
  document.getElementById('edit-status').textContent = ''
  document.getElementById('edit-stripe-status').textContent = ''
  document.getElementById('edit-modal').style.display = 'flex'
}

function closeEditModal() {
  editingProduct = null
  editKeptImages = []
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
        body: { items: cart.map(i => ({ productId: i.productId, quantity: i.quantity, size: i.size })) }
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
    const physicalItems = cart.filter(i => i.weightOz != null && i.weightOz > 0)
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
        body: { items: physicalItems.map(i => ({ productId: i.productId, quantity: i.quantity })), toAddress }
      })
      if (error) throw error

      lastToAddress = toAddress

      ratesList.innerHTML = data.rates.map((rate, i) => `
        <label style="display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem; border: 1px solid #333; border-radius: 4px; margin-bottom: 0.5rem; cursor: pointer; font-size: 0.7rem;">
          <input type="radio" name="shipping-rate" value="${rate.id}" ${i === 0 ? 'checked' : ''}>
          <span style="flex: 1;">${rate.provider} ${rate.service}${rate.estimatedDays ? ` — ${rate.estimatedDays}d` : ''}</span>
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
          items: cart.map(i => ({ productId: i.productId, quantity: i.quantity, size: i.size })),
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

async function generateStripeLink(titleInputId, priceInputId, urlInputId, fileInputId, categoryInputId, sizesInputId, stripeProductIdInputId, existingFileUrl, existingTracklistSnippets, existingDownloadFiles, statusEl, button) {
  const title = document.getElementById(titleInputId).value.trim()
  const price = parseFloat(document.getElementById(priceInputId).value)
  const category = document.getElementById(categoryInputId).value
  const sizes = category === 'apparel' ? document.getElementById(sizesInputId).value.trim() : ''

  if (!title) {
    statusEl.textContent = 'Enter a title before generating a link.'
    statusEl.style.color = '#ff4d4d'
    return
  }

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

  button.disabled = true
  statusEl.textContent = 'Generating Stripe link...'
  statusEl.style.color = '#e8b923'

  try {
    // Attach whichever digital file(s) are currently in play — a freshly
    // selected single file/album/bundle, or whatever's already on the
    // product — so the buyer gets a real download after checkout instead of
    // a dead end.
    const { filePaths: newFilePaths } = await processDigitalFiles(fileInputId)

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
      body: { title, priceCents: Math.round(price * 100), filePaths, category, sizes }
    })
    if (error) throw error

    document.getElementById(urlInputId).value = data.url
    document.getElementById(stripeProductIdInputId).value = data.productId || ''
    statusEl.textContent = filePaths.length > 0
      ? 'Stripe link generated with download attached.'
      : 'Stripe link generated (no digital file attached).'
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
    } else {
      loginView.style.display = 'block'
      dashboardView.style.display = 'none'
      logoutBtn.style.display = 'none'
      closeEditModal()
    }
  })

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

  const uploadForm = document.getElementById('upload-form')
  const uploadStatus = document.getElementById('upload-status')
  const uploadSubmitBtn = document.getElementById('upload-submit-btn')

  document.getElementById('upload-category').addEventListener('change', (e) => {
    updateSizesVisibility(e.target.value, 'upload-sizes-group')
    updateWeightVisibility(e.target.value, 'upload-weight-group')
  })

  document.getElementById('upload-image').addEventListener('change', (e) => {
    previewSelectedImages(e.target, document.getElementById('upload-image-preview'))
  })

  document.getElementById('edit-image').addEventListener('change', (e) => {
    previewSelectedImages(e.target, document.getElementById('edit-image-new-preview'))
  })

  document.getElementById('edit-image-preview').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.admin-image-remove-btn')
    if (!removeBtn) return
    editKeptImages.splice(parseInt(removeBtn.getAttribute('data-idx'), 10), 1)
    renderEditImagePreview()
  })

  const uploadGenerateStripeBtn = document.getElementById('upload-generate-stripe-btn')
  const uploadStripeStatus = document.getElementById('upload-stripe-status')

  uploadGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('upload-title', 'upload-price', 'upload-stripe-url', 'upload-file', 'upload-category', 'upload-sizes', 'upload-stripe-product-id', null, null, null, uploadStripeStatus, uploadGenerateStripeBtn)
  })

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    uploadSubmitBtn.disabled = true
    uploadStatus.textContent = 'Deploying...'
    uploadStatus.style.color = '#e8b923'

    try {
      const title = document.getElementById('upload-title').value
      const price = parseFloat(document.getElementById('upload-price').value)
      const description = document.getElementById('upload-description').value
      const category = document.getElementById('upload-category').value
      const sizes = category === 'apparel' ? (document.getElementById('upload-sizes').value.trim() || null) : null
      const weightRaw = SHIPPABLE_CATEGORIES.includes(category) ? document.getElementById('upload-weight').value.trim() : ''
      const weightOz = weightRaw === '' ? null : parseFloat(weightRaw)
      const inventoryRaw = document.getElementById('upload-inventory').value.trim()
      const inventoryCount = inventoryRaw === '' ? null : parseInt(inventoryRaw, 10)
      const stripeProductId = document.getElementById('upload-stripe-product-id').value.trim() || null
      const stripeUrl = document.getElementById('upload-stripe-url').value.trim() || null
      const published = document.getElementById('upload-published').checked

      const { coverUrl, galleryImages } = await processImageFiles('upload-image')

      const { fileUrl, downloadFiles, tracklistSnippets } = await processDigitalFiles('upload-file')

      const { error: insertError } = await supabase.from('products').insert({
        title,
        price_cents: Math.round(price * 100),
        description,
        category,
        sizes,
        weight_oz: weightOz,
        inventory_count: inventoryCount,
        stripe_product_id: stripeProductId,
        cover_art_url: coverUrl,
        gallery_images: galleryImages,
        audio_preview_url: fileUrl,
        download_files: downloadFiles,
        tracklist_snippets: tracklistSnippets,
        stripe_url: stripeUrl,
        published
      })
      if (insertError) throw insertError

      uploadStatus.textContent = tracklistSnippets
        ? `Product Deployed Successfully (${tracklistSnippets.length}-track album)`
        : 'Product Deployed Successfully'
      uploadStatus.style.color = '#00ffcc'
      uploadForm.reset()
      document.getElementById('upload-image-preview').innerHTML = ''
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

  document.getElementById('edit-category').addEventListener('change', (e) => {
    updateSizesVisibility(e.target.value, 'edit-sizes-group')
    updateWeightVisibility(e.target.value, 'edit-weight-group')
  })

  const editGenerateStripeBtn = document.getElementById('edit-generate-stripe-btn')
  const editStripeStatus = document.getElementById('edit-stripe-status')

  editGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('edit-title', 'edit-price', 'edit-stripe-url', 'edit-file', 'edit-category', 'edit-sizes', 'edit-stripe-product-id', editingProduct ? editingProduct.audio_preview_url : null, editingProduct ? editingProduct.tracklist_snippets : null, editingProduct ? editingProduct.download_files : null, editStripeStatus, editGenerateStripeBtn)
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
      const price = parseFloat(document.getElementById('edit-price').value)
      const description = document.getElementById('edit-description').value
      const category = document.getElementById('edit-category').value
      const sizes = category === 'apparel' ? (document.getElementById('edit-sizes').value.trim() || null) : null
      const weightRaw = SHIPPABLE_CATEGORIES.includes(category) ? document.getElementById('edit-weight').value.trim() : ''
      const weightOz = weightRaw === '' ? null : parseFloat(weightRaw)
      const inventoryRaw = document.getElementById('edit-inventory').value.trim()
      const inventoryCount = inventoryRaw === '' ? null : parseInt(inventoryRaw, 10)
      const stripeProductId = document.getElementById('edit-stripe-product-id').value.trim() || null
      const stripeUrl = document.getElementById('edit-stripe-url').value.trim() || null
      const published = document.getElementById('edit-published').checked

      // New photos are appended to whatever's left in editKeptImages (the
      // admin can remove individual existing photos via the × on each
      // thumbnail, but simply adding more never drops the old ones). This
      // also folds the legacy image_2_url/image_3_url columns into
      // gallery_images going forward, since they're always recomputed here.
      const newPhotos = await processImageFiles('edit-image')
      const newPhotoUrls = newPhotos.coverUrl ? [newPhotos.coverUrl, ...(newPhotos.galleryImages || [])] : []
      const allImages = [...editKeptImages, ...newPhotoUrls]
      const coverUrl = allImages[0] || null
      const galleryImages = allImages.length > 1 ? allImages.slice(1) : null
      const image2Url = null
      const image3Url = null

      let fileUrl = editingProduct ? editingProduct.audio_preview_url : null
      let downloadFiles = editingProduct ? editingProduct.download_files : null
      let tracklistSnippets = editingProduct ? editingProduct.tracklist_snippets : null
      if (document.getElementById('edit-file').files.length > 0) {
        const result = await processDigitalFiles('edit-file')
        fileUrl = result.fileUrl
        downloadFiles = result.downloadFiles
        tracklistSnippets = result.tracklistSnippets
      }

      const { error: updateError } = await supabase.from('products').update({
        title,
        price_cents: Math.round(price * 100),
        description,
        category,
        sizes,
        weight_oz: weightOz,
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
        published
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
// so only one preview can ever be playing at once.
const globalAudio = new Audio()
let activePlayTrigger = null

function setTriggerPlayingState(el, isPlaying) {
  if (!el) return
  const icon = el.querySelector('.play-icon')
  if (icon) icon.textContent = isPlaying ? '❚❚' : '▶'

  if (el.classList.contains('track-item')) {
    el.style.background = isPlaying ? '#333' : '#222'
    el.style.color = isPlaying ? '#fff' : '#ccc'
  } else if (el.classList.contains('card-play-btn')) {
    el.style.background = isPlaying ? 'rgba(0, 255, 204, 0.3)' : 'rgba(0, 255, 204, 0.1)'
  }
}

function playGlobalTrack(url, title, triggerEl) {
  if (activePlayTrigger && activePlayTrigger !== triggerEl) {
    setTriggerPlayingState(activePlayTrigger, false)
  }
  activePlayTrigger = triggerEl

  const player = document.getElementById('global-audio-player')
  document.getElementById('gap-title').textContent = title
  player.style.display = 'flex'
  document.body.classList.add('audio-player-active')

  globalAudio.src = url
  globalAudio.currentTime = 0
  globalAudio.play()
}

function initGlobalAudioPlayer() {
  const player = document.getElementById('global-audio-player')
  const toggleBtn = document.getElementById('gap-toggle')
  const seekBar = document.getElementById('gap-seek')
  const closeBtn = document.getElementById('gap-close')

  toggleBtn.addEventListener('click', () => {
    if (globalAudio.paused) {
      globalAudio.play()
    } else {
      globalAudio.pause()
    }
  })

  globalAudio.addEventListener('play', () => {
    toggleBtn.textContent = '❚❚'
    setTriggerPlayingState(activePlayTrigger, true)
  })

  globalAudio.addEventListener('pause', () => {
    toggleBtn.textContent = '▶'
    setTriggerPlayingState(activePlayTrigger, false)
  })

  globalAudio.addEventListener('timeupdate', () => {
    if (!isNaN(globalAudio.duration) && globalAudio.duration > 0) {
      seekBar.value = (globalAudio.currentTime / globalAudio.duration) * 100
    }
  })

  globalAudio.addEventListener('ended', () => {
    seekBar.value = 0
    setTriggerPlayingState(activePlayTrigger, false)
  })

  seekBar.addEventListener('input', () => {
    if (!isNaN(globalAudio.duration) && globalAudio.duration > 0) {
      globalAudio.currentTime = (seekBar.value / 100) * globalAudio.duration
    }
  })

  closeBtn.addEventListener('click', () => {
    globalAudio.pause()
    globalAudio.currentTime = 0
    seekBar.value = 0
    player.style.display = 'none'
    document.body.classList.remove('audio-player-active')
    setTriggerPlayingState(activePlayTrigger, false)
    activePlayTrigger = null
  })
}

initGlobalAudioPlayer()

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
  const { data: products, error } = await supabase.from('products').select('*').eq('published', true)

  if (error) {
    console.error('Database connection error:', error)
    storeGrid.innerHTML = '<p style="font-size: 0.8rem;">Connection error. The Bodega is offline.</p>'
    return
  }

  if (!products || products.length === 0) {
    storeGrid.innerHTML = '<p style="font-size: 0.8rem;">The Bodega is currently empty. Add products in your Supabase dashboard.</p>'
    return
  }

  storeGrid.innerHTML = ''
  
  // BUILD CARDS
  products.forEach(product => {
   try {
    const isFree = (product.price_cents || 0) === 0
    const formattedPrice = isFree ? 'FREE' : `$${(product.price_cents / 100).toFixed(2)}`
    const isSoldOut = product.inventory_count != null && product.inventory_count <= 0

    const card = document.createElement('div')
    card.className = 'product-card'
    card.setAttribute('data-category', (product.category || '').toString().trim().toLowerCase())

    // Consolidate images into an array for the lightbox
    const availableImages = []
    if (product.cover_art_url) availableImages.push(product.cover_art_url)
    if (product.image_2_url) availableImages.push(product.image_2_url)
    if (product.image_3_url) availableImages.push(product.image_3_url)
    if (Array.isArray(product.gallery_images)) availableImages.push(...product.gallery_images)

    // Shows one image at a time with click-through arrows instead of a
    // scrolling strip. The <img> itself is swapped in place on each click
    // rather than rebuilding the gallery, since there's only ever one
    // element to update.
    let galleryHTML = ''
    if (availableImages.length > 0) {
      galleryHTML = `
        <div class="image-gallery">
          <img src="${availableImages[0]}" alt="${product.title}" class="lightbox-trigger gallery-current-img" data-idx="0">
          ${availableImages.length > 1 ? `
            <button type="button" class="gallery-arrow gallery-prev" aria-label="Previous photo">&#10094;</button>
            <button type="button" class="gallery-arrow gallery-next" aria-label="Next photo">&#10095;</button>
            <div class="gallery-counter">1 / ${availableImages.length}</div>
          ` : ''}
        </div>
      `
    } else {
      galleryHTML = `<div class="no-image">NO IMAGE</div>`
    }

    const descriptionHTML = product.description
      ? `<p class="description">${product.description.slice(0, MAX_DESCRIPTION_LENGTH)}</p>`
      : ''

    const sizesHTML = product.sizes 
      ? `<div class="sizes-container">${product.sizes.split(',').map(s => `<span class="size-tag">${s.trim()}</span>`).join('')}</div>`
      : ''

    let audioHTML = ''

    // Prefer the saved tracklist_snippets, but fall back to deriving tracks
    // from download_files directly (filtering to just the audio ones) — this
    // is what makes bundles saved before this fallback existed, or bundles
    // that mix audio with cover art/tracklist images, still get a player.
    // Each track's own trackNumber is the source of truth for play order —
    // the array itself isn't guaranteed to already be in that order (e.g.
    // it reflects whatever order the files were selected in at upload time).
    const playableTracks = (product.tracklist_snippets && product.tracklist_snippets.length > 0)
      ? [...product.tracklist_snippets].sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
      : (Array.isArray(product.download_files)
          ? product.download_files
              .filter(f => isAudioUrl(f.url))
              .map((f, idx) => ({ trackNumber: idx + 1, title: (f.name || '').replace(/\.[^/.]+$/, ''), url: f.url }))
          : [])

    if (playableTracks.length > 1) {
      audioHTML = `
        <div class="album-player-container" style="background: #111; padding: 0.5rem; border-radius: 6px; margin-bottom: 0.3rem; border: 1px solid #333;">
          <button class="card-play-btn" data-url="${playableTracks[0].url}" data-title="${product.title} — ${playableTracks[0].title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 0.5rem; padding: 0.4rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
            <span class="play-icon">▶</span> Play Preview
          </button>
          <p style="font-size: 0.5rem; color: #888; margin: 0 0 0.4rem 0; text-transform: uppercase; letter-spacing: 1px;">Preview Tracklist</p>
          <div class="tracklist-slider" style="max-height: 66px; overflow-y: auto; padding-right: 5px;">
            <ul style="list-style: none; padding: 0; margin: 0;">
              ${playableTracks.map((track) => `
                <li class="track-item" data-url="${track.url}" data-title="${product.title} — ${track.title}" style="font-size: 0.55rem; color: #ccc; margin-bottom: 0.2rem; cursor: pointer; padding: 4px; background: #222; border-radius: 3px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                  <span class="play-icon" style="color: #00ffcc; font-size: 0.45rem;">▶</span> ${track.trackNumber}. ${track.title}
                </li>
              `).join('')}
            </ul>
          </div>
        </div>
      `
    } else if (playableTracks.length === 1) {
      audioHTML = `
        <button class="card-play-btn" data-url="${playableTracks[0].url}" data-title="${product.title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 0.3rem; padding: 0.5rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
          <span class="play-icon">▶</span> Play Preview
        </button>
      `
    } else if (isAudioUrl(product.audio_preview_url)) {
      audioHTML = `
        <button class="card-play-btn" data-url="${product.audio_preview_url}" data-title="${product.title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 0.3rem; padding: 0.5rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
          <span class="play-icon">▶</span> Play Preview
        </button>
      `
    }

    const needsSize = !isFree && !isSoldOut && product.category === 'apparel' && product.sizes
    const sizeSelectHTML = needsSize
      ? `<select class="card-size-select admin-input">
          <option value="" disabled selected>Select Size</option>
          ${product.sizes.split(',').map(s => s.trim()).filter(Boolean).map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>`
      : ''

    card.innerHTML = `
      ${galleryHTML}
      <h3 style="margin: 0 0 0.15rem 0; font-size: 0.7rem; line-height: 1.2;">${product.title}</h3>
      <p class="price" style="margin: 0 0 0.15rem 0; font-size: 0.65rem;">${formattedPrice}</p>
      <p style="font-size: 0.5rem; letter-spacing: 1px; color: #aaa; margin: 0 0 0.2rem 0;">${(product.category || 'UNCATEGORIZED').toUpperCase()}</p>
      ${descriptionHTML}
      ${sizesHTML}
      <div style="margin-top: auto;"></div>
      ${audioHTML}
      ${sizeSelectHTML}
      <button class="buy-btn" ${isSoldOut ? 'disabled' : ''} style="margin-top: 0.3rem; width: 100%; padding: 0.5rem; background: ${isSoldOut ? '#444' : '#00ffcc'}; color: ${isSoldOut ? '#999' : '#111'}; border: none; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: ${isSoldOut ? 'not-allowed' : 'pointer'}; text-transform: uppercase;">
        ${isSoldOut ? 'Sold Out' : (isFree ? 'Get It Free' : 'Add to Cart')}
      </button>
    `

    // Wire up Lightbox Clicks
    const images = card.querySelectorAll('.lightbox-trigger')
    images.forEach(img => {
      img.addEventListener('click', (e) => {
        const idx = parseInt(e.target.getAttribute('data-idx'))
        window.openLightbox(availableImages, idx)
      })
    })

    // Wire up gallery prev/next arrows — swap the single <img>'s src rather
    // than scrolling, since only one photo shows at a time now.
    const galleryImg = card.querySelector('.gallery-current-img')
    const galleryCounter = card.querySelector('.gallery-counter')
    const galleryPrevBtn = card.querySelector('.gallery-prev')
    const galleryNextBtn = card.querySelector('.gallery-next')
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

    // Wire up Play triggers (routed through the global audio engine)
    const playTriggers = card.querySelectorAll('.card-play-btn, .track-item')
    playTriggers.forEach(trigger => {
      trigger.addEventListener('click', () => {
        playGlobalTrack(trigger.getAttribute('data-url'), trigger.getAttribute('data-title'), trigger)
      })
    })

    // Wire up purchase / free download
    const buyButton = card.querySelector('.buy-btn')
    const sizeSelect = card.querySelector('.card-size-select')
    buyButton.addEventListener('click', () => {
      if (isSoldOut) {
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

    storeGrid.appendChild(card)
   } catch (err) {
     console.error('Skipping product due to render error:', product, err)
   }
  })

  setupCategoryFilters()
}

// INJECT 3: Category Filter Bar Logic (local DOM filtering, no re-fetch)
function setupCategoryFilters() {
  const filterButtons = document.querySelectorAll('.filter-btn[data-filter]')

  function applyFilter(filter) {
    filterButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-filter') === filter))

    const cards = document.querySelectorAll('.product-card')
    cards.forEach(card => {
      const matches = filter === 'all' || card.getAttribute('data-category') === filter
      card.style.display = matches ? '' : 'none'
    })
  }

  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => applyFilter(btn.getAttribute('data-filter')))
  })

  const footerLogoBtn = document.getElementById('footer-logo-filter')
  if (footerLogoBtn) {
    footerLogoBtn.addEventListener('click', () => applyFilter('all'))
  }

  // Land on the MUSIC filter by default
  applyFilter('music')
}

// INJECT 4: First-visit "Enter" gate. Shown once per browser session (sessionStorage),
// so it reappears only after the visitor closes/leaves and comes back in a new tab/session.
function initEnterOverlay() {
  const overlay = document.getElementById('enter-overlay')
  const enterBtn = document.getElementById('enter-btn')
  if (!overlay || !enterBtn) return

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

initFreeDownloadModal()
initShippingCheckoutModal()
initCartModal()
updateCartBadge()

const isAdminMode = initAdminPortal()
if (!isAdminMode) {
  loadBodega()
  initEnterOverlay()
}