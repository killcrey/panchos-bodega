import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

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

// Matches the maxlength on #upload-description / #edit-description in index.html.
// Enforced again here at render time so descriptions saved before this limit
// existed can't blow out the product card either.
const MAX_DESCRIPTION_LENGTH = 200

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
  const files = Array.from(document.getElementById(fileInputId).files)

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

function updateSizesVisibility(categoryValue, groupId) {
  document.getElementById(groupId).style.display = categoryValue === 'apparel' ? 'block' : 'none'
}

function parseShippingCents(inputId, category) {
  if (category !== 'apparel') return null
  const raw = document.getElementById(inputId).value.trim()
  if (raw === '') return null
  return Math.round(parseFloat(raw) * 100)
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
  document.getElementById('edit-domestic-shipping').value = product.domestic_shipping_cents != null ? (product.domestic_shipping_cents / 100).toFixed(2) : ''
  document.getElementById('edit-international-shipping').value = product.international_shipping_cents != null ? (product.international_shipping_cents / 100).toFixed(2) : ''
  updateSizesVisibility(product.category, 'edit-sizes-group')
  updateSizesVisibility(product.category, 'edit-shipping-group')
  document.getElementById('edit-image').value = ''
  document.getElementById('edit-file').value = ''

  const imageCount = [product.cover_art_url, product.image_2_url, product.image_3_url]
    .filter(Boolean).length + (Array.isArray(product.gallery_images) ? product.gallery_images.length : 0)
  document.getElementById('edit-image-current-info').textContent = imageCount > 0
    ? `Currently: ${imageCount} photo${imageCount === 1 ? '' : 's'}`
    : 'Currently: no photos'

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

async function generateStripeLink(titleInputId, priceInputId, urlInputId, fileInputId, categoryInputId, sizesInputId, domesticShippingInputId, internationalShippingInputId, stripeProductIdInputId, existingFileUrl, existingTracklistSnippets, existingDownloadFiles, statusEl, button) {
  const title = document.getElementById(titleInputId).value.trim()
  const price = parseFloat(document.getElementById(priceInputId).value)
  const category = document.getElementById(categoryInputId).value
  const sizes = category === 'apparel' ? document.getElementById(sizesInputId).value.trim() : ''
  const domesticShippingCents = parseShippingCents(domesticShippingInputId, category)
  const internationalShippingCents = parseShippingCents(internationalShippingInputId, category)

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
      body: { title, priceCents: Math.round(price * 100), filePaths, category, sizes, domesticShippingCents, internationalShippingCents }
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
  const adminLogo = document.querySelector('.admin-logo')
  const headerContainer = document.querySelector('.header-container')
  const storeGrid = document.getElementById('store-grid')
  const loginView = document.getElementById('login-view')
  const dashboardView = document.getElementById('dashboard-view')
  const loginBtn = document.getElementById('admin-login-btn')
  const logoutBtn = document.getElementById('admin-logout-btn')
  const emailInput = document.getElementById('admin-email')
  const passwordInput = document.getElementById('admin-password')

  if (isAdminMode) {
    headerContainer.style.display = 'none'
    storeGrid.style.display = 'none'
    document.querySelector('.bodega-footer').style.display = 'none'
    document.body.style.overflow = 'hidden'
    adminPortal.style.display = 'flex'
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      loginView.style.display = 'none'
      dashboardView.style.display = 'flex'
      adminLogo.classList.add('admin-logo-compact')
      loadAdminInventory()
    } else {
      loginView.style.display = 'block'
      dashboardView.style.display = 'none'
      adminLogo.classList.remove('admin-logo-compact')
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
    updateSizesVisibility(e.target.value, 'upload-shipping-group')
  })

  const uploadGenerateStripeBtn = document.getElementById('upload-generate-stripe-btn')
  const uploadStripeStatus = document.getElementById('upload-stripe-status')

  uploadGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('upload-title', 'upload-price', 'upload-stripe-url', 'upload-file', 'upload-category', 'upload-sizes', 'upload-domestic-shipping', 'upload-international-shipping', 'upload-stripe-product-id', null, null, null, uploadStripeStatus, uploadGenerateStripeBtn)
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
      const domesticShippingCents = parseShippingCents('upload-domestic-shipping', category)
      const internationalShippingCents = parseShippingCents('upload-international-shipping', category)
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
        domestic_shipping_cents: domesticShippingCents,
        international_shipping_cents: internationalShippingCents,
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
    updateSizesVisibility(e.target.value, 'edit-shipping-group')
  })

  const editGenerateStripeBtn = document.getElementById('edit-generate-stripe-btn')
  const editStripeStatus = document.getElementById('edit-stripe-status')

  editGenerateStripeBtn.addEventListener('click', () => {
    generateStripeLink('edit-title', 'edit-price', 'edit-stripe-url', 'edit-file', 'edit-category', 'edit-sizes', 'edit-domestic-shipping', 'edit-international-shipping', 'edit-stripe-product-id', editingProduct ? editingProduct.audio_preview_url : null, editingProduct ? editingProduct.tracklist_snippets : null, editingProduct ? editingProduct.download_files : null, editStripeStatus, editGenerateStripeBtn)
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
      const domesticShippingCents = parseShippingCents('edit-domestic-shipping', category)
      const internationalShippingCents = parseShippingCents('edit-international-shipping', category)
      const inventoryRaw = document.getElementById('edit-inventory').value.trim()
      const inventoryCount = inventoryRaw === '' ? null : parseInt(inventoryRaw, 10)
      const stripeProductId = document.getElementById('edit-stripe-product-id').value.trim() || null
      const stripeUrl = document.getElementById('edit-stripe-url').value.trim() || null
      const published = document.getElementById('edit-published').checked

      let coverUrl = editingProduct ? editingProduct.cover_art_url : null
      let galleryImages = editingProduct ? editingProduct.gallery_images : null
      let image2Url = editingProduct ? editingProduct.image_2_url : null
      let image3Url = editingProduct ? editingProduct.image_3_url : null
      if (document.getElementById('edit-image').files.length > 0) {
        const result = await processImageFiles('edit-image')
        coverUrl = result.coverUrl
        galleryImages = result.galleryImages
        // New photos fully replace the old set, including the legacy
        // image_2_url/image_3_url columns pre-dating the gallery feature.
        image2Url = null
        image3Url = null
      }

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
        domestic_shipping_cents: domesticShippingCents,
        international_shipping_cents: internationalShippingCents,
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

    let galleryHTML = ''
    if (availableImages.length > 0) {
      const imageTags = availableImages.map((url, idx) => `<img src="${url}" alt="${product.title}" class="lightbox-trigger" data-idx="${idx}" style="cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity=0.8" onmouseout="this.style.opacity=1">`).join('')
      galleryHTML = `<div class="image-gallery">${imageTags}</div>`
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
    const playableTracks = (product.tracklist_snippets && product.tracklist_snippets.length > 0)
      ? product.tracklist_snippets
      : (Array.isArray(product.download_files)
          ? product.download_files
              .filter(f => isAudioUrl(f.url))
              .map((f, idx) => ({ trackNumber: idx + 1, title: (f.name || '').replace(/\.[^/.]+$/, ''), url: f.url }))
          : [])

    if (playableTracks.length > 1) {
      audioHTML = `
        <div class="album-player-container" style="background: #111; padding: 0.5rem; border-radius: 6px; margin-bottom: 1rem; border: 1px solid #333;">
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
        <button class="card-play-btn" data-url="${playableTracks[0].url}" data-title="${product.title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 1rem; padding: 0.5rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
          <span class="play-icon">▶</span> Play Preview
        </button>
      `
    } else if (isAudioUrl(product.audio_preview_url)) {
      audioHTML = `
        <button class="card-play-btn" data-url="${product.audio_preview_url}" data-title="${product.title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 1rem; padding: 0.5rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
          <span class="play-icon">▶</span> Play Preview
        </button>
      `
    }

    card.innerHTML = `
      ${galleryHTML}
      <h3 style="margin: 0 0 0.15rem 0; font-size: 0.7rem; line-height: 1.2;">${product.title}</h3>
      <p class="price" style="margin: 0 0 0.15rem 0; font-size: 0.65rem;">${formattedPrice}</p>
      <p style="font-size: 0.5rem; letter-spacing: 1px; color: #aaa; margin: 0 0 0.2rem 0;">${(product.category || 'UNCATEGORIZED').toUpperCase()}</p>
      ${descriptionHTML}
      ${sizesHTML}
      ${audioHTML}
      <button class="buy-btn" ${isSoldOut ? 'disabled' : ''} style="margin-top: auto; width: 100%; padding: 0.5rem; background: ${isSoldOut ? '#444' : '#00ffcc'}; color: ${isSoldOut ? '#999' : '#111'}; border: none; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: ${isSoldOut ? 'not-allowed' : 'pointer'}; text-transform: uppercase;">
        ${isSoldOut ? 'Sold Out' : (isFree ? 'Get It Free' : 'Buy Now')}
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

    // Wire up Play triggers (routed through the global audio engine)
    const playTriggers = card.querySelectorAll('.card-play-btn, .track-item')
    playTriggers.forEach(trigger => {
      trigger.addEventListener('click', () => {
        playGlobalTrack(trigger.getAttribute('data-url'), trigger.getAttribute('data-title'), trigger)
      })
    })

    // Wire up purchase / free download
    const buyButton = card.querySelector('.buy-btn')
    buyButton.addEventListener('click', () => {
      if (isSoldOut) {
        return
      } else if (isFree) {
        openFreeDownloadModal(product)
      } else if (product.stripe_url) {
        window.open(product.stripe_url, '_blank')
      } else {
        alert('Checkout link is currently being generated. Check back soon!')
      }
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
  const logoLink = document.getElementById('logo-home-filter')

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

  if (logoLink) {
    logoLink.addEventListener('click', () => applyFilter('all'))
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

const isAdminMode = initAdminPortal()
if (!isAdminMode) {
  loadBodega()
  initEnterOverlay()
}