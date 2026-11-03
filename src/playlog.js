// Counts a song as "played" once a visitor has actually listened to 30 seconds
// of it (real listening time - skipping ahead doesn't add to it), then tells the
// log-play edge function once. Shared by the store's player (main.js) and the
// VIP folder page (vip.js).
const PLAY_SECONDS = 30
const LISTENER_KEY = 'bodegaListenerId'

let memoryId = null
// A random id this browser makes for itself so "unique listeners" can be counted
// without knowing who anyone is (no email, no IP). If storage is blocked it
// lasts for the page visit only.
function listenerId() {
  try {
    let id = localStorage.getItem(LISTENER_KEY)
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
      localStorage.setItem(LISTENER_KEY, id)
    }
    return id
  } catch {
    if (!memoryId) memoryId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36))
    return memoryId
  }
}

function sendPlay(track) {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/log-play`
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: import.meta.env.VITE_SUPABASE_ANON_KEY },
    body: JSON.stringify({ ...track, listenerId: listenerId() }),
    keepalive: true
  }).catch(() => {})
}

// `getTrack()` returns { productSlug, trackSlug, trackName, source } for what is
// loaded right now, or null when it shouldn't be counted.
export function watchPlays(audio, getTrack) {
  let heard = 0
  let lastTime = null
  let logged = false
  const reset = () => { heard = 0; lastTime = null; logged = false }

  audio.addEventListener('loadstart', reset)
  audio.addEventListener('ended', reset)
  audio.addEventListener('pause', () => { lastTime = null })
  audio.addEventListener('seeking', () => { lastTime = null })
  audio.addEventListener('timeupdate', () => {
    if (audio.paused || audio.seeking) { lastTime = null; return }
    const t = audio.currentTime
    if (lastTime !== null) {
      const delta = t - lastTime
      if (delta > 0 && delta < 2) heard += delta
    }
    lastTime = t
    if (!logged && heard >= PLAY_SECONDS) {
      logged = true
      const track = getTrack()
      if (track && track.productSlug) sendPlay(track)
    }
  })
}
