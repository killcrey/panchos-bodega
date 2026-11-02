// Sharing a song: a small bottom sheet with "Share link" and "Image for
// Stories". The link is the song's own URL (/products/<slug>/<track>/, which has
// its own social card when prerendered); the Stories image is a 1080x1920
// card drawn on a canvas, so a fan can post it and add a link sticker.
import { PLAYER_ARTIST, slugify, albumDisplayName } from './tracks.js'

// What the share sheet and the Stories card print for a song: the track name,
// and the album it's from (nothing when the thing shared IS the album/single).
function displayNames(meta) {
  const name = albumDisplayName(meta.name)
  const album = meta.album ? albumDisplayName(meta.album) : ''
  return { name, album: album && album !== name ? album : '' }
}

export const SHARE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11.5"/><path d="M7.8 7.6 12 3.4l4.2 4.2"/><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>'

// The two lines printed on the Stories card besides the song. Kept as plain
// constants: the "hear it first" line is only true while a release is
// website-exclusive, so it is one edit (or an empty string) when that ends.
const STORY_TAGLINE = 'HEAR IT FIRST'
const STORY_SITE_TEXT = 'bodega.theinvisiblepanchos.com'

const STORY_W = 1080
const STORY_H = 1920

let menuMeta = null
let toastTimer = null

// A phone's own share sheet is the right place for "send this to a friend /
// post this to Stories"; on a desktop browser people expect "copy link" and
// "download the image" instead of the OS share dialog.
const prefersNativeShare = () =>
  !!navigator.share && window.matchMedia && window.matchMedia('(pointer: coarse)').matches

function showToast(message) {
  const toast = document.getElementById('share-toast')
  if (!toast) return
  toast.textContent = message
  toast.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    // Older browsers / non-secure contexts: the textarea fallback.
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch (e) { ok = false }
    area.remove()
    return ok
  }
}

function closeMenu() {
  const menu = document.getElementById('share-menu')
  if (!menu) return
  menu.classList.remove('open')
  menu.setAttribute('aria-hidden', 'true')
  menuMeta = null
}

export function openShareMenu(meta) {
  const menu = document.getElementById('share-menu')
  if (!menu || !meta || !meta.url) return
  menuMeta = meta
  const names = displayNames(meta)
  document.getElementById('share-menu-title').textContent = names.name
  document.getElementById('share-menu-sub').textContent = names.album ? `from ${names.album}` : PLAYER_ARTIST
  document.getElementById('share-link-btn').textContent = prefersNativeShare() ? 'Share link' : 'Copy link'
  const storyBtn = document.getElementById('share-story-btn')
  storyBtn.textContent = 'Image for Stories'
  storyBtn.disabled = false
  menu.classList.add('open')
  menu.setAttribute('aria-hidden', 'false')
}

async function shareLink(meta) {
  const { name } = displayNames(meta)
  const shareData = { title: `${name} — ${PLAYER_ARTIST}`, text: `Listen to ${name} by ${PLAYER_ARTIST}`, url: meta.url }
  if (prefersNativeShare()) {
    try {
      await navigator.share(shareData)
      closeMenu()
    } catch (err) {
      // Dismissing the share sheet isn't an error worth reporting.
      if (err && err.name !== 'AbortError') showToast("Couldn't open sharing")
    }
    return
  }
  const ok = await copyText(meta.url)
  showToast(ok ? 'Link copied' : "Couldn't copy the link")
  if (ok) closeMenu()
}

function loadCover(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(null); return }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

// Average colour of the cover, darkened — the same look as the player.
function coverBackdropColor(img) {
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 16
    const cx = c.getContext('2d')
    cx.drawImage(img, 0, 0, 16, 16)
    const px = cx.getImageData(0, 0, 16, 16).data
    let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 200) continue
      r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
    }
    if (!n) return null
    r /= n; g /= n; b /= n
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const k = lum > 90 ? 90 / lum : 1
    return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`
  } catch (err) {
    return null
  }
}

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (!line || ctx.measureText(test).width <= maxWidth) line = test
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)
  return lines
}

// A single line shortened with "…" until it fits.
function fitLine(ctx, text, maxWidth) {
  let t = String(text)
  if (ctx.measureText(t).width <= maxWidth) return t
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

// Biggest title size (down to a floor) that fits in 3 lines of the card width
// and in a fixed block height, so the lines below it never get pushed into the
// tagline at the bottom of the card.
const TITLE_MAX_BLOCK_HEIGHT = 300
function fitTitle(ctx, text, maxWidth) {
  for (let size = 104; size >= 56; size -= 4) {
    ctx.font = `800 ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    const lines = wrapLines(ctx, text, maxWidth)
    if (lines.length <= 3 && lines.length * size * 1.1 <= TITLE_MAX_BLOCK_HEIGHT && lines.every(l => ctx.measureText(l).width <= maxWidth)) return { size, lines }
  }
  ctx.font = '800 56px "Helvetica Neue", Helvetica, Arial, sans-serif'
  const lines = wrapLines(ctx, text, maxWidth).slice(0, 3)
  const last = lines.length - 1
  if (last >= 0) {
    while (lines[last].length > 1 && ctx.measureText(`${lines[last]}…`).width > maxWidth) lines[last] = lines[last].slice(0, -1)
    lines[last] = `${lines[last]}…`
  }
  return { size: 56, lines }
}

// Draws the 1080x1920 card. Content stays inside the middle of the frame —
// Instagram covers roughly the top 250px and bottom 340px of a Story with its
// own buttons — so nothing important sits under them, and the fan has room to
// drop a link sticker.
function drawStoryCard(meta, cover) {
  const canvas = document.createElement('canvas')
  canvas.width = STORY_W
  canvas.height = STORY_H
  const ctx = canvas.getContext('2d')
  const font = '"Helvetica Neue", Helvetica, Arial, sans-serif'

  const tint = (cover && coverBackdropColor(cover)) || '#33302b'
  const bg = ctx.createLinearGradient(0, 0, 0, STORY_H)
  bg.addColorStop(0, tint)
  bg.addColorStop(0.7, '#101010')
  bg.addColorStop(1, '#080808')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, STORY_W, STORY_H)

  const names = displayNames(meta)
  const coverSize = 800
  const coverX = (STORY_W - coverSize) / 2
  const coverY = 270
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
  ctx.shadowBlur = 60
  ctx.shadowOffsetY = 24
  roundedRectPath(ctx, coverX, coverY, coverSize, coverSize, 28)
  ctx.fillStyle = '#1a1a1a'
  ctx.fill()
  ctx.restore()
  if (cover) {
    ctx.save()
    roundedRectPath(ctx, coverX, coverY, coverSize, coverSize, 28)
    ctx.clip()
    ctx.drawImage(cover, coverX, coverY, coverSize, coverSize)
    ctx.restore()
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffffff'
  const { size, lines } = fitTitle(ctx, names.name, 900)
  ctx.font = `800 ${size}px ${font}`
  let y = coverY + coverSize + 50 + size
  lines.forEach((line) => {
    ctx.fillText(line, STORY_W / 2, y)
    y += size * 1.1
  })

  y += 10
  ctx.font = `700 38px ${font}`
  ctx.fillStyle = '#e8b923'
  if ('letterSpacing' in ctx) ctx.letterSpacing = '6px'
  ctx.fillText(PLAYER_ARTIST.toUpperCase(), STORY_W / 2, y)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'

  if (names.album) {
    y += 56
    ctx.font = `500 36px ${font}`
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
    ctx.fillText(fitLine(ctx, `from ${names.album}`, 900), STORY_W / 2, y)
  }

  const baseY = 1650
  if (STORY_TAGLINE) {
    ctx.font = `800 34px ${font}`
    ctx.fillStyle = '#00ffcc'
    if ('letterSpacing' in ctx) ctx.letterSpacing = '8px'
    ctx.fillText(STORY_TAGLINE, STORY_W / 2, baseY - 52)
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  }
  ctx.font = `600 40px ${font}`
  ctx.fillStyle = '#ffffff'
  ctx.fillText(STORY_SITE_TEXT, STORY_W / 2, baseY)

  return canvas
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image export failed'))), 'image/jpeg', 0.92)
    } catch (err) {
      reject(err)
    }
  })
}

async function shareStoryImage(meta) {
  const storyBtn = document.getElementById('share-story-btn')
  storyBtn.disabled = true
  storyBtn.textContent = 'Making image…'
  try {
    let cover = await loadCover(meta.cover)
    let blob
    try {
      blob = await canvasToBlob(drawStoryCard(meta, cover))
    } catch (err) {
      // A cover the browser won't let us read back (cross-origin) taints the
      // canvas — still make the card, just without the artwork.
      blob = await canvasToBlob(drawStoryCard(meta, null))
    }
    const file = new File([blob], `${slugify(displayNames(meta).name) || 'panchos'}-story.jpg`, { type: 'image/jpeg' })

    if (prefersNativeShare() && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: meta.name })
        closeMenu()
        return
      } catch (err) {
        if (err && err.name === 'AbortError') return
        // Any other failure falls through to a plain download below.
      }
    }

    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 10000)
    showToast('Image saved — add it to your Story')
    closeMenu()
  } catch (err) {
    console.error('Story image failed:', err)
    showToast("Couldn't make the image")
  } finally {
    storyBtn.disabled = false
    storyBtn.textContent = 'Image for Stories'
  }
}

export function initShareMenu() {
  const menu = document.getElementById('share-menu')
  if (!menu) return
  menu.querySelectorAll('[data-share-close]').forEach(el => el.addEventListener('click', closeMenu))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) closeMenu()
  })
  document.getElementById('share-link-btn').addEventListener('click', () => { if (menuMeta) shareLink(menuMeta) })
  document.getElementById('share-story-btn').addEventListener('click', () => { if (menuMeta) shareStoryImage(menuMeta) })
}
