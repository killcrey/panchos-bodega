import { createClient } from 'npm:@supabase/supabase-js@2'

// Streams a product's files to the buyer as ONE .zip. Nothing is stored: the
// zip is assembled on the fly from the audio-vault files and sent as it's
// built, so memory stays small no matter how big the album is.
//
// Access is by a signed link minted by secure-download (the post-payment page)
// or stripe-webhook (the order email) only AFTER payment was verified:
//   ?s=<checkout session id>&p=<stripe product id>&e=<expiry unix secs>&t=<hmac>
// The HMAC (UNSUBSCRIBE_SECRET, same signing approach as the unsubscribe link,
// with its own "zip|" prefix so tokens can't be swapped between features)
// binds session + product + expiry, so a link can't be edited to fetch another
// product or live past its expiry.
//
// The zip is "stored" (no compression — mp3/png don't compress) and built in
// two passes so it's a plain, fully standard zip every OS opens: pass 1 reads
// each file once to get its exact size and CRC-32, pass 2 streams the headers
// (which need those numbers up front) and the file bytes. That avoids the
// streaming "data descriptor" variant some unzip tools handle badly.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const enc = new TextEncoder()

async function hmacHex(message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('UNSUBSCRIBE_SECRET') ?? ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
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

function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const marker = '/storage/v1/object/public/audio-vault/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  try { return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]) } catch { return url.slice(idx + marker.length).split('?')[0] }
}

function u16(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255]) }
function u32(n: number) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]) }
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

type Entry = { name: string; nameBytes: Uint8Array; url: string; size: number; crc: number; offset: number }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  const fail = (status: number, msg: string) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  try {
    const q = new URL(req.url).searchParams
    const sid = q.get('s') || '', pid = q.get('p') || '', exp = q.get('e') || '', tok = q.get('t') || ''
    if (!sid || !pid || !exp || !tok) return fail(400, 'This download link is incomplete.')
    if (!(Number(exp) > Date.now() / 1000)) return fail(410, 'This download link has expired. Open your order email or the order page again for a fresh one.')
    if (!safeEqual(await hmacHex(`zip|${sid}|${pid}|${exp}`), tok)) return fail(403, 'This download link is not valid.')

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
    const { data: product } = await supabase
      .from('products')
      .select('title, download_files, tracklist_snippets, audio_preview_url')
      .eq('stripe_product_id', pid)
      .maybeSingle()
    if (!product) return fail(404, 'We could not find that product.')

    // Same file selection as free-download: the full bundle if there is one,
    // else the tracklist, else the single legacy file.
    const dl = Array.isArray(product.download_files) ? product.download_files : []
    const tr = Array.isArray(product.tracklist_snippets) ? product.tracklist_snippets : []
    const items = dl.length ? dl : tr
    const paths = (items.length ? items.map((i: { url: string }) => pathFromUrl(i.url)) : [pathFromUrl(product.audio_preview_url)]).filter(Boolean) as string[]
    if (paths.length === 0) return fail(404, 'There are no files attached to this product.')

    // ---- pass 1: size + CRC of every file (skipping any that are missing)
    const entries: Entry[] = []
    const used = new Set<string>()
    for (const path of paths) {
      const { data: signed, error } = await supabase.storage.from('audio-vault').createSignedUrl(path, 900)
      if (error || !signed) { console.error('zip: cannot sign', path, error); continue }
      const res = await fetch(signed.signedUrl)
      if (!res.ok || !res.body) { console.error('zip: cannot read', path, res.status); continue }
      let crc = 0xffffffff, size = 0
      const reader = res.body.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        crc = crcUpdate(crc, value)
        size += value.length
      }
      let name = path.replace(/^\d+-/, '')
      if (used.has(name.toLowerCase())) {
        const dot = name.lastIndexOf('.')
        let n = 2
        const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : ''
        while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n++
        name = `${stem} (${n})${ext}`
      }
      used.add(name.toLowerCase())
      entries.push({ name, nameBytes: enc.encode(name), url: signed.signedUrl, size, crc: (crc ^ 0xffffffff) >>> 0, offset: 0 })
    }
    if (entries.length === 0) return fail(404, 'The files for this download are not available right now.')

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

    // ---- pass 2: stream it, pulling only as fast as the buyer's connection takes it
    async function* generate() {
      for (const e of entries) {
        yield concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(e.crc), u32(e.size), u32(e.size), u16(e.nameBytes.length), u16(0), e.nameBytes)
        const res = await fetch(e.url)
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

    const title = (product.title || 'download').replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'download'
    return new Response(body, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/zip',
        'Content-Length': String(totalLength),
        'Content-Disposition': `attachment; filename="${title}.zip"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    console.error('download-zip failed:', err)
    return fail(500, 'Something went wrong preparing your download. Please try again.')
  }
})
