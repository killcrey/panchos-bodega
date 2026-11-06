import { createClient } from 'npm:@supabase/supabase-js@2'

// The VIP folder: a private page (vip.html) handed out hand-to-hand at events
// on an NFC keychain. A link is a row in vip_links (a long random token, an
// expiry 7 days after it was made, and a by-hand off switch); this function is
// the only thing that ever reads that table.
//
//   GET ?t=<token>          -> JSON for the page: note, songs, covers (signed links)
//   GET ?t=<token>&zip=1    -> everything as ONE .zip (streamed, nothing stored)
//
// The expiry and the off switch are checked on EVERY request, including the zip
// and including the signed file links' creation — so a closed link stops
// handing out anything straight away. (A signed song link already handed to a
// page still works for the hour it was signed for; that is the price of
// streaming straight from storage.)
//
// The zip is built the same way as download-zip (see its header for why): a
// "stored" zip in two passes — pass 1 reads each file once for size + CRC-32,
// pass 2 streams headers and bytes — so memory stays flat for any album size.
// It also carries the thank-you note as "Thank You.txt".
//
// VIP-only extras: print-size covers live in the private audio-vault bucket
// under vip/<product slug>/ (e.g. "Memories Of Home - Front Cover.jpg"). Any
// image dropped there is picked up automatically — no code change, no deploy.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const enc = new TextEncoder()

const ARTIST = 'The Invisible Panchos'
const SIGNATURE = `KILLcRey x Gene Flo — ${ARTIST}`
// Used whenever a link has no note of its own (vip_links.note blank). The album
// name is the only part that changes between folders.
const defaultNote = (album: string) => [
  'Thank you for showing up.',
  `This is ${album}. Every song, the covers. Yours to keep.`,
  'We make this for the people. You are the reason it is worth making.',
  'Play it loud.',
]
const CLOSED_MESSAGE = 'This link has closed.'

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac']
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const hasExt = (url: string, exts: string[]) => {
  const clean = (url || '').split('?')[0].toLowerCase()
  return exts.some(e => clean.endsWith(e))
}

// "01 - The Invisible Panchos - Same Same" -> "Same Same" (same rule as the storefront)
function cleanTrackTitle(title: string): string {
  const t = String(title || '').replace(/^\s*\d{1,3}\s*[-–—.:)]\s*/, '')
  const stripped = t.replace(new RegExp('^\\s*' + ARTIST + '\\s*[-–—:]\\s*', 'i'), '')
  return stripped || t
}

// "THE INVISIBLE PANCHOS- MEMORIES OF HOME (DOWNLOAD)" -> "Memories Of Home"
function albumName(title: string): string {
  const raw = String(title || '')
  const cleaned = raw
    .replace(/\s*\((?:digital )?download\)\s*$/i, '')
    .replace(new RegExp('^\\s*' + ARTIST + '\\s*[-–—:]\\s*', 'i'), '')
    .trim() || raw
  return cleaned.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase())
}

function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const marker = '/storage/v1/object/public/audio-vault/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const raw = url.slice(idx + marker.length).split('?')[0]
  try { return decodeURIComponent(raw) } catch { return raw }
}

// The stored object name starts with an upload timestamp ("1793516373592-01 - ...");
// the person downloading it should see the real file name.
const fileNameFromPath = (path: string) => path.replace(/^\d+-/, '')

function noteParagraphs(note: string, album: string): string[] {
  const own = String(note || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  return own.length ? own : defaultNote(album)
}

// CRC-32 (IEEE) — the checksum every zip entry carries.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crcUpdate(crc: number, chunk: Uint8Array): number {
  for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8)
  return crc
}

// Size + CRC-32 of each file, remembered in zip_file_meta so a zip can start
// right away instead of first re-reading the whole album. A cached row is only
// trusted while the object's size and ETag (from a 1-byte range request) still
// match, so a file replaced at the same path is re-read, never zipped with a
// stale checksum.
type MetaRow = { size: number; crc: number; etag: string }
// deno-lint-ignore no-explicit-any
async function loadMetaCache(supabase: any, keys: string[]): Promise<Map<string, MetaRow>> {
  const out = new Map<string, MetaRow>()
  if (!keys.length) return out
  const { data, error } = await supabase.from('zip_file_meta').select('path, size, crc, etag').in('path', keys)
  if (error) { console.error('zip meta cache read failed (continuing without it):', error); return out }
  for (const r of data || []) out.set(r.path, { size: Number(r.size), crc: Number(r.crc), etag: r.etag })
  return out
}

async function probeFile(url: string): Promise<{ size: number; etag: string } | null> {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  await res.body?.cancel()
  if (!res.ok) return null
  const range = res.headers.get('content-range')
  const size = range ? parseInt(range.split('/')[1], 10) : parseInt(res.headers.get('content-length') || '', 10)
  return Number.isFinite(size) ? { size, etag: res.headers.get('etag') || '' } : null
}

// deno-lint-ignore no-explicit-any
async function fileMeta(supabase: any, cache: Map<string, MetaRow>, key: string, url: string): Promise<{ size: number; crc: number } | null> {
  const probe = await probeFile(url)
  if (!probe) return null
  const hit = cache.get(key)
  if (hit && probe.etag && hit.etag === probe.etag && hit.size === probe.size) return { size: hit.size, crc: hit.crc }
  const res = await fetch(url)
  if (!res.ok || !res.body) return null
  let crc = 0xffffffff, size = 0
  const reader = res.body.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    crc = crcUpdate(crc, value)
    size += value.length
  }
  crc = (crc ^ 0xffffffff) >>> 0
  if (size !== probe.size) return null
  if (probe.etag) {
    const { error } = await supabase.from('zip_file_meta').upsert({ path: key, size, crc, etag: probe.etag, updated_at: new Date().toISOString() })
    if (error) console.error('zip meta cache write failed (continuing):', error)
  }
  return { size, crc }
}


function u16(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255]) }
function u32(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]) }
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

type Entry = { name: string; nameBytes: Uint8Array; url?: string; data?: Uint8Array; size: number; crc: number; offset: number }

type Item = { url: string; name?: string; title?: string; trackNumber?: number }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } })
  const fail = (status: number, msg: string) => json(status, { error: msg })

  try {
    const q = new URL(req.url).searchParams
    const token = (q.get('t') || '').trim()
    // Not a token we could ever have made — don't even touch the database.
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return fail(404, CLOSED_MESSAGE)

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')

    const { data: link } = await supabase
      .from('vip_links')
      .select('id, label, note, download_url, product_slug, expires_at, revoked, open_count')
      .eq('token', token)
      .maybeSingle()
    if (!link) return fail(404, CLOSED_MESSAGE)
    if (link.revoked || new Date(link.expires_at).getTime() <= Date.now()) return fail(410, CLOSED_MESSAGE)

    const { data: product } = await supabase
      .from('products')
      .select('title, cover_art_url, download_files, tracklist_snippets')
      .eq('slug', link.product_slug)
      .maybeSingle()
    if (!product) return fail(404, 'The folder is not available right now.')

    // What is in the folder: the product's CURRENT files (never a copy that can
    // go stale when songs are swapped out in the admin). Same precedence as
    // download-zip: the full bundle if there is one, else the tracklist.
    const bundle: Item[] = Array.isArray(product.download_files) ? product.download_files : []
    const tracklist: Item[] = Array.isArray(product.tracklist_snippets)
      ? [...product.tracklist_snippets].sort((a: Item, b: Item) => (a.trackNumber || 0) - (b.trackNumber || 0))
      : []
    const zipItems = bundle.length ? bundle : tracklist
    const trackItems = tracklist.length
      ? tracklist.map((t: Item) => ({ title: t.title || '', url: t.url }))
      : bundle.filter(f => hasExt(f.url, AUDIO_EXTENSIONS)).map(f => ({ title: (f.name || '').replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?)$/i, ''), url: f.url }))
    // Covers are the image files in the bundle; if none were ever uploaded as
    // files, fall back to the product's own (public, site-sized) cover art.
    const bundleCovers = bundle.filter(f => hasExt(f.url, IMAGE_EXTENSIONS))
    // Print-size VIP covers replace the bundle's covers, but the tracklist
    // image (only ever in the bundle) must still reach the folder.
    const isTracklistImage = (f: Item) => /tracklist/i.test(f.name || '')
    const bundleTracklists = bundleCovers.filter(isTracklistImage)
    const album = albumName(product.title)
    const note = noteParagraphs(link.note, album)

    // The front cover goes first (it is the hero image on the page), the rest
    // alphabetical. "Front Cover" and a plain "<Album> Cover" both count as front.
    const frontRank = (file: string) => (/front/i.test(file) || (/cover/i.test(file) && !/back/i.test(file))) ? 0 : 1

    // Print-size covers kept just for this folder.
    const extrasDir = `vip/${link.product_slug}`
    const { data: extras } = await supabase.storage.from('audio-vault').list(extrasDir)
    const vipCovers = (extras || [])
      .filter((o: { id?: string | null; name: string }) => o.id && hasExt(o.name, IMAGE_EXTENSIONS))
      .map((o: { name: string }) => ({ path: `${extrasDir}/${o.name}`, file: o.name }))
      .sort((a: { file: string }, b: { file: string }) => frontRank(a.file) - frontRank(b.file) || a.file.localeCompare(b.file))
    // Shown name: the file name without the extension or the album prefix, in
    // Title Case when it was typed in capitals ("LAYERS COVER" -> "Cover").
    const albumPrefix = new RegExp('^' + album.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–—:]?\\s*', 'i')
    const coverLabel = (file: string) => {
      const base = file.replace(/\.[^/.]+$/, '')
      const label = base.replace(albumPrefix, '').trim() || 'Cover'
      return label === label.toUpperCase() ? label.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()) : label
    }

    // ---------------------------------------------------------------- zip
    if (q.get('zip') === '1') {
      type Source = { name: string; fetchUrl: string; key: string }
      const sources: Source[] = []
      const used = new Set<string>()
      const uniqueName = (name: string) => {
        let out = name
        if (used.has(out.toLowerCase())) {
          const dot = name.lastIndexOf('.')
          const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ''
          let n = 2
          while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n++
          out = `${stem} (${n})${ext}`
        }
        used.add(out.toLowerCase())
        return out
      }

      for (const item of zipItems) {
        // When print-size VIP covers exist they replace any covers in the bundle.
        // The tracklist image is the exception: it always goes in the folder.
        if (vipCovers.length && hasExt(item.url, IMAGE_EXTENSIONS) && !isTracklistImage(item)) continue
        const path = pathFromUrl(item.url)
        if (!path) continue
        const { data: signed, error } = await supabase.storage.from('audio-vault').createSignedUrl(path, 900)
        if (error || !signed) { console.error('vip zip: cannot sign', path, error); continue }
        sources.push({ name: fileNameFromPath(path), fetchUrl: signed.signedUrl, key: path })
      }
      for (const c of vipCovers) {
        const { data: signed, error } = await supabase.storage.from('audio-vault').createSignedUrl(c.path, 900)
        if (error || !signed) { console.error('vip zip: cannot sign', c.path, error); continue }
        sources.push({ name: c.file, fetchUrl: signed.signedUrl, key: c.path })
      }
      if (vipCovers.length === 0 && bundleCovers.length === 0 && product.cover_art_url) {
        const ext = (product.cover_art_url.split('?')[0].match(/\.[A-Za-z0-9]+$/) || ['.jpg'])[0]
        sources.push({ name: `${album} - Cover${ext}`, fetchUrl: product.cover_art_url, key: `url:${product.cover_art_url}` })
      }

      // ---- pass 1: size + CRC of every file (from zip_file_meta when still valid; any file that is missing is skipped)
      const entries: Entry[] = []
      const noteText = [...note, SIGNATURE, ''].join('\r\n\r\n')
      const noteBytes = enc.encode(noteText)
      const noteName = uniqueName('Thank You.txt')
      entries.push({ name: noteName, nameBytes: enc.encode(noteName), data: noteBytes, size: noteBytes.length, crc: (crcUpdate(0xffffffff, noteBytes) ^ 0xffffffff) >>> 0, offset: 0 })

      const metaCache = await loadMetaCache(supabase, sources.map(s => s.key))
      const metas = await Promise.all(sources.map(s => fileMeta(supabase, metaCache, s.key, s.fetchUrl)))
      sources.forEach((s, i) => {
        const m = metas[i]
        if (!m) { console.error('vip zip: cannot read', s.name); return }
        const name = uniqueName(s.name)
        entries.push({ name, nameBytes: enc.encode(name), url: s.fetchUrl, size: m.size, crc: m.crc, offset: 0 })
      })
      if (entries.length < 2) return fail(404, 'The files for this folder are not available right now.')

      // ---- layout: exact byte offsets, so Content-Length is known up front
      const now = new Date()
      const dosTime = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1)
      const dosDate = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate()
      let offset = 0
      for (const e of entries) { e.offset = offset; offset += 30 + e.nameBytes.length + e.size }
      const cdOffset = offset
      const centralDir = concat(...entries.map(e => concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
        u32(e.crc), u32(e.size), u32(e.size), u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset), e.nameBytes,
      )))
      const eocd = concat(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralDir.length), u32(cdOffset), u16(0))
      const totalLength = cdOffset + centralDir.length + eocd.length

      // ---- pass 2: stream it, pulling only as fast as the connection takes it
      async function* generate() {
        for (const e of entries) {
          yield concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(e.crc), u32(e.size), u32(e.size), u16(e.nameBytes.length), u16(0), e.nameBytes)
          if (e.data) { yield e.data; continue }
          const res = await fetch(e.url as string)
          if (!res.ok || !res.body) throw new Error(`Could not read ${e.name}`)
          const reader = res.body.getReader()
          let sent = 0
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            sent += value.length
            yield value
          }
          if (sent !== e.size) throw new Error(`${e.name} changed while downloading`)
        }
        yield centralDir
        yield eocd
      }
      const it = generate()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await it.next()
            if (done) controller.close(); else controller.enqueue(value)
          } catch (err) { controller.error(err) }
        },
        cancel() { it.return(undefined) },
      })

      const zipName = `${album.replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'Folder'} - ${ARTIST}.zip`
      return new Response(body, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/zip',
          'Content-Length': String(totalLength),
          'Content-Disposition': `attachment; filename="${zipName}"`,
          'Cache-Control': 'private, no-store',
        },
      })
    }

    // --------------------------------------------------------------- page data
    // Signed for an hour, with the real file name as the download name, so the
    // same link plays in the page and saves under a sensible name.
    const sign = async (url: string) => {
      const path = pathFromUrl(url)
      if (!path) return url // a public file (e.g. the site cover art) needs no signing
      const { data, error } = await supabase.storage.from('audio-vault').createSignedUrl(path, 3600, { download: fileNameFromPath(path) })
      if (error || !data) return null
      return data.signedUrl
    }

    const tracks = (await Promise.all(trackItems.map(async (t) => {
      const url = await sign(t.url)
      return url ? { name: cleanTrackTitle(t.title), url } : null
    }))).filter(Boolean)

    const coverSources = vipCovers.length
      ? [
        ...await Promise.all(vipCovers.map(async (c) => {
          const { data, error } = await supabase.storage.from('audio-vault').createSignedUrl(c.path, 3600, { download: c.file })
          return { name: coverLabel(c.file), url: error || !data ? null : data.signedUrl }
        })),
        ...await Promise.all(bundleTracklists.map(async (c) => ({ name: coverLabel(c.name || 'Tracklist'), url: await sign(c.url) }))),
      ]
      : bundleCovers.length
        ? await Promise.all([...bundleCovers]
          .sort((a, b) => frontRank(a.name || '') - frontRank(b.name || '') || (a.name || '').localeCompare(b.name || ''))
          .map(async (c) => ({ name: coverLabel(c.name || 'Cover'), url: await sign(c.url) })))
        : (product.cover_art_url ? [{ name: 'Cover', url: product.cover_art_url as string | null }] : [])
    const covers = coverSources.filter(c => c.url)

    // Best-effort tally for the admin list — never worth failing the page over.
    supabase.from('vip_links')
      .update({ open_count: (link.open_count || 0) + 1, last_opened_at: new Date().toISOString() })
      .eq('id', link.id)
      .then(({ error }: { error: unknown }) => { if (error) console.error('vip-folder: open tally failed:', error) })

    return json(200, {
      label: link.label,
      expiresAt: link.expires_at,
      productSlug: link.product_slug,
      album,
      note,
      // Where "Download everything" goes instead of the built-in zip. Only ever a
      // Google Drive link: this value is typed by whoever is logged in, and our own
      // page must not be usable to bounce visitors to an arbitrary site.
      downloadUrl: /^https:\/\/drive\.google\.com\//.test(String(link.download_url || '').trim()) ? String(link.download_url).trim() : '',
      signature: SIGNATURE,
      tracks,
      covers,
    })
  } catch (err) {
    console.error('vip-folder failed:', err)
    return fail(500, 'Something went wrong. Please try again.')
  }
})
