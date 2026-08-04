import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ADMIN PORTAL
function initAdminPortal() {
  const params = new URLSearchParams(window.location.search)
  const isAdminMode = params.get('mode') === 'admin'

  const adminPortal = document.getElementById('admin-portal')
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
    adminPortal.style.display = 'flex'
  }

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      loginView.style.display = 'none'
      dashboardView.style.display = 'block'
    } else {
      loginView.style.display = 'block'
      dashboardView.style.display = 'none'
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
        <span id="lb-close" style="position: absolute; top: 20px; right: 30px; color: white; font-size: 2.5rem; cursor: pointer; font-weight: bold; transition: color 0.2s;">&times;</span>
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
  const { data: products, error } = await supabase.from('products').select('*')

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
    const formattedPrice = (product.price_cents / 100).toFixed(2)
    
    const card = document.createElement('div')
    card.className = 'product-card'
    card.setAttribute('data-category', (product.category || '').toString().trim().toLowerCase())

    // Consolidate images into an array for the lightbox
    const availableImages = []
    if (product.cover_art_url) availableImages.push(product.cover_art_url)
    if (product.image_2_url) availableImages.push(product.image_2_url)
    if (product.image_3_url) availableImages.push(product.image_3_url)

    let galleryHTML = ''
    if (availableImages.length > 0) {
      const imageTags = availableImages.map((url, idx) => `<img src="${url}" alt="${product.title}" class="lightbox-trigger" data-idx="${idx}" style="cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity=0.8" onmouseout="this.style.opacity=1">`).join('')
      galleryHTML = `<div class="image-gallery">${imageTags}</div>`
    } else {
      galleryHTML = `<div class="no-image">NO IMAGE</div>`
    }

    const descriptionHTML = product.description 
      ? `<p class="description">${product.description}</p>` 
      : ''

    const sizesHTML = product.sizes 
      ? `<div class="sizes-container">${product.sizes.split(',').map(s => `<span class="size-tag">${s.trim()}</span>`).join('')}</div>`
      : ''

    let audioHTML = ''

    if (product.tracklist_snippets && product.tracklist_snippets.length > 0) {
      audioHTML = `
        <div class="album-player-container" style="background: #111; padding: 0.5rem; border-radius: 6px; margin-bottom: 1rem; border: 1px solid #333;">
          <button class="card-play-btn" data-url="${product.tracklist_snippets[0].url}" data-title="${product.title} — ${product.tracklist_snippets[0].title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 0.5rem; padding: 0.4rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
            <span class="play-icon">▶</span> Play Preview
          </button>
          <p style="font-size: 0.5rem; color: #888; margin: 0 0 0.4rem 0; text-transform: uppercase; letter-spacing: 1px;">Preview Tracklist</p>
          <div class="tracklist-slider" style="max-height: 80px; overflow-y: auto; padding-right: 5px;">
            <ul style="list-style: none; padding: 0; margin: 0;">
              ${product.tracklist_snippets.map((track) => `
                <li class="track-item" data-url="${track.url}" data-title="${product.title} — ${track.title}" style="font-size: 0.55rem; color: #ccc; margin-bottom: 0.2rem; cursor: pointer; padding: 4px; background: #222; border-radius: 3px; display: flex; align-items: center; gap: 6px; transition: background 0.2s;">
                  <span class="play-icon" style="color: #00ffcc; font-size: 0.45rem;">▶</span> ${track.trackNumber}. ${track.title}
                </li>
              `).join('')}
            </ul>
          </div>
        </div>
      `
    } else if (product.audio_preview_url) {
      audioHTML = `
        <button class="card-play-btn" data-url="${product.audio_preview_url}" data-title="${product.title}" style="display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; margin-bottom: 1rem; padding: 0.5rem; background: rgba(0, 255, 204, 0.1); color: #00ffcc; border: 1px solid #00ffcc; border-radius: 4px; font-size: 0.55rem; font-weight: bold; letter-spacing: 1px; text-transform: uppercase; cursor: pointer;">
          <span class="play-icon">▶</span> Play Preview
        </button>
      `
    }

    card.innerHTML = `
      ${galleryHTML}
      <h3 style="margin-top: 0; font-size: 0.7rem; line-height: 1.2;">${product.title}</h3>
      <p class="price" style="margin: 0.3rem 0; font-size: 0.65rem;">$${formattedPrice}</p>
      <p style="font-size: 0.5rem; letter-spacing: 1px; color: #aaa; margin-bottom: 0.4rem;">${product.type.toUpperCase()}</p>
      ${descriptionHTML}
      ${sizesHTML}
      ${audioHTML}
      <button class="buy-btn" style="margin-top: auto; width: 100%; padding: 0.5rem; background: #00ffcc; color: #111; border: none; border-radius: 4px; font-weight: bold; font-size: 0.55rem; cursor: pointer; text-transform: uppercase;">
        Buy Now
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

    // Wire up Stripe Link
    const buyButton = card.querySelector('.buy-btn')
    buyButton.addEventListener('click', () => {
      if (product.stripe_url) {
        window.open(product.stripe_url, '_blank')
      } else {
        alert('Checkout link is currently being generated. Check back soon!')
      }
    })

    storeGrid.appendChild(card)
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
}

const isAdminMode = initAdminPortal()
if (!isAdminMode) {
  loadBodega()
}