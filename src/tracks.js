// Track helpers shared by the storefront (src/main.js) and the build-time
// prerender (scripts/prerender-products.js). Pure functions only — no DOM —
// so the browser and Node derive the SAME track list and the SAME per-track
// URL slugs; if they drifted, a shared /products/<slug>/<track>/ link would
// get the wrong social card or fail to find its song.

export const PLAYER_ARTIST = 'The Invisible Panchos'

const AUDIO_URL_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']

export function isAudioUrl(url) {
  if (!url) return false
  const clean = url.split('?')[0].toLowerCase()
  return AUDIO_URL_EXTENSIONS.some(ext => clean.endsWith(ext))
}

// Mirrors the backfill regex in the products_slug migration, so an admin
// typing a title sees the same slug the DB would have generated for it.
export function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

// Track titles come from the uploaded file names ("10 - The Invisible Panchos -
// Get The"), which already start with their own number, and the tracklist adds
// its own "10." in front — so rows read "10. 10 - ...". Drops a leading 1-3
// digit number plus its separator for display only; the stored title and the
// player's own title are left alone. A title with no separator after the
// number ("2 Chainz") or a 4-digit year ("1999 - ...") is not touched.
export function stripLeadingTrackNumber(title) {
  return String(title || '').replace(/^\s*\d{1,3}\s*[-–—.:)]\s*/, '')
}

// The player rows/mini-player show the song name with the artist on its own
// line, so a file name that already starts with "The Invisible Panchos - " has
// that prefix dropped for display (the artist is shown separately).
export function cleanTrackTitle(title) {
  const t = stripLeadingTrackNumber(title)
  const prefix = new RegExp('^\\s*' + PLAYER_ARTIST + '\\s*[-–—:]\\s*', 'i')
  return t.replace(prefix, '') || t
}

// Product titles are written for the store ("THE INVISIBLE PANCHOS- MEMORIES OF
// HOME (DOWNLOAD)"); wherever a title is shown as a song/album name to the
// public (share sheet, Stories card, social-card text) drop the artist prefix
// and the "(DOWNLOAD)" tag so it reads "MEMORIES OF HOME".
export function albumDisplayName(title) {
  const raw = String(title || '')
  const cleaned = raw
    .replace(/\s*\((?:digital )?download\)\s*$/i, '')
    .replace(new RegExp('^\\s*' + PLAYER_ARTIST + '\\s*[-–—:]\\s*', 'i'), '')
    .trim()
  return cleaned || raw
}

// How a song's album is credited in "from ..." lines (share sheet, Stories card,
// social-card text). Most albums are just "from <album>"; an album listed here
// gets its own wording, keyed by its display name in lower case.
const ALBUM_CREDITS = {
  'memories of home': 'the soundtrack Memories Of Home',
  'layers': 'the soundtrack Layers',
}
export function albumCredit(title) {
  const name = albumDisplayName(title)
  return ALBUM_CREDITS[name.toLowerCase()] || name
}

// The playable tracks of a product, in play order, each with its display name
// and a URL slug. `tracklist_snippets` (an album's saved tracklist) wins; a
// bundle saved before that existed is re-derived from its audio files in
// `download_files`. Slugs come from the song name (not its position) so
// re-ordering an album never breaks links already shared; two songs with the
// same name get -2, -3 suffixes.
export function getPlayableTracks(product) {
  const raw = (product.tracklist_snippets && product.tracklist_snippets.length > 0)
    ? [...product.tracklist_snippets].sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0))
    : (Array.isArray(product.download_files)
        ? product.download_files
            .filter(f => isAudioUrl(f.url))
            .map((f, idx) => ({ trackNumber: idx + 1, title: (f.name || '').replace(/\.[^/.]+$/, ''), url: f.url }))
        : [])

  const seen = new Map()
  return raw.map((track, idx) => {
    const name = cleanTrackTitle(track.title)
    let slug = slugify(name) || `track-${track.trackNumber || idx + 1}`
    const count = (seen.get(slug) || 0) + 1
    seen.set(slug, count)
    if (count > 1) slug = `${slug}-${count}`
    return { ...track, name, slug }
  })
}

// Only an album (2+ tracks) has per-track pages; a single's own product page
// already is that song's page.
export function findTrackBySlug(product, trackSlug) {
  const tracks = getPlayableTracks(product)
  if (tracks.length < 2) return null
  return tracks.find(t => t.slug === trackSlug) || null
}

export const productPath = (slug) => `/products/${slug}/`
export const trackPath = (slug, trackSlug) => `/products/${slug}/${trackSlug}/`

// Title + description for a track's page and social card. Same strings in the
// browser tab and in the prerendered HTML crawlers read.
export function trackMeta(product, track) {
  return {
    title: `${track.name} — ${PLAYER_ARTIST} | Panchos Bodega`,
    description: `Listen to “${track.name}” from ${albumCredit(product.title)} by ${PLAYER_ARTIST} on the Panchos Bodega.`,
  }
}
