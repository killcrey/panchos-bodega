// The VIP folder page (vip.html), opened from an NFC keychain at
// /vip/<token>. All content comes from the vip-folder edge function, which
// checks the link is live; this page only draws what it is given. Everything
// from the response goes in with textContent/attributes, never as HTML.
import { watchPlays } from './src/playlog.js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const API = `${supabaseUrl}/functions/v1/vip-folder`
const SITE = 'https://bodega.theinvisiblepanchos.com'
const GAME_URL = 'https://game.theinvisiblepanchos.com/'
const GAME_POSTER = 'https://defanfglngsszhyurpfn.supabase.co/storage/v1/object/public/bodega-images/gameposter-1792682886734-60.webp'

const app = document.getElementById('app')

function tokenFromUrl() {
  const m = window.location.pathname.match(/^\/vip\/([A-Za-z0-9_-]+)\/?$/)
  return m ? m[1] : (new URLSearchParams(window.location.search).get('t') || '')
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function showClosed() {
  app.replaceChildren()
  const box = el('div', 'closed')
  box.append(
    el('p', 'glyph', '❌👁️'),
    el('h1', null, 'This link has closed.'),
    el('p', null, 'These stay open for a week. Catch us at the next one.'),
  )
  const p = el('p')
  const a = el('a', null, 'bodega.theinvisiblepanchos.com')
  a.href = SITE
  p.append(a)
  box.append(p)
  app.append(box)
}

function daysLeftText(expiresAt) {
  const ms = new Date(expiresAt).getTime() - Date.now()
  const days = Math.ceil(ms / 86400000)
  const when = new Date(expiresAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const left = days <= 1 ? 'less than a day left' : `${days} days left`
  return `Link closes ${when} · ${left}`
}

// The "packing" popup: the zip is built while the browser waits (up to a minute),
// so the tap opens this - the game poster and a link to the game - instead of
// leaving a blank, awkward wait. The download itself is a normal link
// navigation, so the browser can't tell us when it starts; the popup stays until
// it is closed, and after a while it admits it is taking long.
let packModal = null
function openPackModal() {
  if (!packModal) {
    const backdrop = el('div', 'pack-backdrop')
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-modal', 'true')
    backdrop.setAttribute('aria-label', 'Packing up your order')
    const box = el('div', 'pack-box')
    const close = el('button', 'pack-close', '×')
    close.type = 'button'
    close.setAttribute('aria-label', 'Close')
    const poster = el('img', 'pack-poster')
    poster.src = GAME_POSTER
    poster.alt = 'The Invisible Panchos video game'
    const sub = el('p', 'pack-sub', 'Your download starts by itself. It can take up to a minute.')
    const game = el('a', 'pack-game', 'Play the game while you wait')
    game.href = GAME_URL
    game.target = '_blank'
    game.rel = 'noopener'
    box.append(
      close,
      el('h2', 'pack-title', 'Packing up your order, Pancho!'),
      el('p', 'pack-text', 'Hold tight and don’t steal anything. The cameras are on. \u{1F441}️'),
      sub, poster, game,
    )
    backdrop.append(box)
    const hide = () => { backdrop.classList.remove('open'); clearTimeout(backdrop._late) }
    close.addEventListener('click', hide)
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) hide() })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() })
    backdrop._sub = sub
    document.body.append(backdrop)
    packModal = backdrop
  }
  packModal._sub.textContent = 'Your download starts by itself. It can take up to a minute.'
  packModal.classList.add('open')
  clearTimeout(packModal._late)
  packModal._late = setTimeout(() => {
    packModal._sub.textContent = 'Taking a while? Check your downloads, or close this and tap once more.'
  }, 75000)
}

function render(data, token) {
  app.replaceChildren()
  document.title = `Thank You | ${data.album} | The Invisible Panchos`

  app.append(el('p', 'glyph', '❌👁️'), el('h1', null, 'Thank you'))

  if (data.covers.length > 0) {
    const cover = el('img', 'cover')
    cover.src = data.covers[0].url
    cover.alt = `${data.album} cover`
    app.append(cover)
  }

  const note = el('div', 'note')
  data.note.forEach(line => note.append(el('p', null, line)))
  app.append(note, el('p', 'signature', data.signature))

  // Either a Google Drive folder/zip the band set up for this link, or our own
  // zip. Drive does the heavy lifting on a slow signal; the built-in zip is the
  // fallback and always matches the album's current files.
  const useDrive = !!data.downloadUrl
  const zip = el('a', 'zip-btn', useDrive ? 'Download everything' : 'Download everything (.zip)')
  zip.href = useDrive ? data.downloadUrl : `${API}?t=${encodeURIComponent(token)}&zip=1`
  if (useDrive) zip.rel = 'noopener'
  const zipMeta = el('p', 'zip-meta', useDrive
    ? 'All the songs, the covers and this note. Opens in Google Drive — tap Download all.'
    : `${data.tracks.length} songs, the covers and this note in one file.`)
  // The zip is assembled while the browser waits, so nothing visibly happens for
  // up to a minute after the tap. Say so up front (and again once tapped) so
  // nobody gives up and leaves.
  if (!useDrive) new Image().src = GAME_POSTER
  let zipWait = null
  if (!useDrive) {
    const wait = el('p', 'zip-wait', 'Heads up: it takes up to a minute to start after you tap. Keep this page open and tap once.')
    wait.id = 'zip-wait'
    zipWait = wait
    zip.addEventListener('click', () => {
      wait.textContent = 'Packaging your download now. This can take up to a minute to start. Keep this page open.'
      wait.style.fontWeight = 'bold'
      openPackModal()
    })
  }
  app.append(zip, zipMeta)
  if (zipWait) app.append(zipWait)

  // ---- songs: one shared audio element, one song at a time, auto-advance
  const audio = new Audio()
  audio.preload = 'none'
  let activeIndex = -1
  const rows = []

  const paint = () => {
    rows.forEach((row, i) => {
      const active = i === activeIndex
      row.li.classList.toggle('is-active', active)
      row.btn.textContent = active && !audio.paused ? '❚❚' : '▶'
      row.btn.setAttribute('aria-label', `${active && !audio.paused ? 'Pause' : 'Play'} ${data.tracks[i].name}`)
    })
  }
  const playIndex = (i) => {
    if (i === activeIndex) {
      if (audio.paused) audio.play().catch(() => {}); else audio.pause()
      return
    }
    activeIndex = i
    audio.src = data.tracks[i].url
    audio.play().catch(() => {})
    paint()
  }
  // A song listened to for 30 s counts as a play (source 'vip'), same as on the store.
  watchPlays(audio, () => activeIndex >= 0 && ({ productSlug: data.productSlug, trackSlug: '', trackName: data.tracks[activeIndex].name, source: 'vip' }))
  audio.addEventListener('play', paint)
  audio.addEventListener('pause', paint)
  audio.addEventListener('ended', () => {
    if (activeIndex + 1 < data.tracks.length) playIndex(activeIndex + 1)
    else { activeIndex = -1; paint() }
  })

  app.append(el('h2', null, 'Songs'))
  const list = el('ol')
  data.tracks.forEach((track, i) => {
    const li = el('li', 'track')
    const btn = el('button', 'track-play', '▶')
    btn.type = 'button'
    btn.addEventListener('click', () => playIndex(i))
    const name = el('span', 'track-name')
    name.append(el('span', 'track-n', String(i + 1).padStart(2, '0')), document.createTextNode(track.name))
    const save = el('a', 'save', 'save')
    save.href = track.url
    save.rel = 'noopener'
    save.setAttribute('aria-label', `Save ${track.name}`)
    li.append(btn, name, save)
    list.append(li)
    rows.push({ li, btn })
  })
  app.append(list)
  paint()

  if (data.covers.length > 0) {
    app.append(el('h2', null, 'Covers'))
    const grid = el('div', 'covers')
    data.covers.forEach((c) => {
      const fig = el('figure')
      const img = el('img')
      img.src = c.url
      img.alt = c.name
      img.loading = 'lazy'
      const cap = el('figcaption')
      cap.append(el('span', null, c.name))
      const save = el('a', 'save', 'save')
      save.href = c.url
      save.rel = 'noopener'
      cap.append(save)
      fig.append(img, cap)
      grid.append(fig)
    })
    app.append(grid)
  }

  app.append(el('p', 'closes', daysLeftText(data.expiresAt)))
  const foot = el('p', 'foot')
  foot.append(document.createTextNode('Stay invisible. '))
  const home = el('a', null, 'bodega.theinvisiblepanchos.com')
  home.href = SITE
  foot.append(home)
  app.append(foot)
}

async function main() {
  const token = tokenFromUrl()
  if (!token) { showClosed(); return }
  try {
    const res = await fetch(`${API}?t=${encodeURIComponent(token)}`)
    // 404 (not a link we made) and 410 (expired or shut off) read the same
    // to a visitor — nothing to learn about which links exist.
    if (res.status === 404 || res.status === 410) { showClosed(); return }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    render(await res.json(), token)
  } catch (err) {
    console.error('vip: could not load the folder', err)
    app.replaceChildren(el('p', 'glyph', '❌👁️'), el('h1', null, 'Try again'), el('p', null, 'The folder did not load. Check your signal and refresh.'))
  }
}

main()
