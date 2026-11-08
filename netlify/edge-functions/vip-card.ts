// Link-preview card for a VIP link (/vip/<token>). vip.html is one static file,
// so every link would unfurl identically; this fills in the card from the link's
// own event name (the "title" the admin edits) before the page is sent.
// Crawlers (iMessage, WhatsApp, Facebook, X, Slack ...) read these tags without
// running the page's JavaScript.
//
// It only asks the public vip-folder function for ?meta=1 — the label, album
// name and the album's public cover — which gives nothing away that signed
// links don't, signs nothing and does not count as an open. A closed, expired or
// unknown link (or any failure here) leaves the plain page untouched.

const META_URL = 'https://defanfglngsszhyurpfn.supabase.co/functions/v1/vip-folder'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export default async (request: Request, context: { next: () => Promise<Response> }) => {
  const response = await context.next()
  try {
    const type = response.headers.get('content-type') || ''
    if (!type.includes('text/html')) return response
    const m = new URL(request.url).pathname.match(/^\/vip\/([A-Za-z0-9_-]{20,128})\/?$/)
    if (!m) return response

    const res = await fetch(`${META_URL}?t=${m[1]}&meta=1`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return response
    const meta = await res.json() as { label?: string; album?: string; image?: string | null }
    const title = (meta.label || '').trim() || (meta.album ? `${meta.album} — The Invisible Panchos` : '')
    if (!title) return response

    const description = `${meta.album ? meta.album + ' — ' : ''}Songs, covers and a thank-you note from The Invisible Panchos. Yours to keep.`
    const tags = [
      `<meta property="og:type" content="website">`,
      `<meta property="og:site_name" content="The Invisible Panchos">`,
      `<meta property="og:title" content="${esc(title)}">`,
      `<meta property="og:description" content="${esc(description)}">`,
      meta.image ? `<meta property="og:image" content="${esc(meta.image)}">` : '',
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
      `<meta name="twitter:title" content="${esc(title)}">`,
      `<meta name="twitter:description" content="${esc(description)}">`,
      meta.image ? `<meta name="twitter:image" content="${esc(meta.image)}">` : '',
    ].filter(Boolean).join('\n    ')

    let html = await response.text()
    html = html.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${esc(title)}</title>`)
    html = html.replace(/<\/head>/i, () => `    ${tags}\n  </head>`)
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.set('cache-control', 'private, no-store')
    return new Response(html, { status: response.status, headers })
  } catch (err) {
    console.error('vip-card: left the page as is:', err)
    return response
  }
}

