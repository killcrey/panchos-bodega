import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import JSZip from "https://esm.sh/jszip@3.10.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function extractStoragePath(url: string, bucket: string): string | null {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(url.slice(idx + marker.length))
}

async function sendDownloadEmail(email: string, title: string, downloadUrl: string) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="letter-spacing: 1px;">Thanks for grabbing "${title}"!</h2>
      <p>Here's your download link — it's good for the next 60 minutes:</p>
      <p style="margin: 1.5rem 0;">
        <a href="${downloadUrl}" style="display: inline-block; padding: 0.9rem 1.5rem; background: #000; color: #fff; text-decoration: none; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Download Now</a>
      </p>
      <p><strong>Windows / Android:</strong> Right-click (or tap and hold) the button above and choose "Save Link As" / "Download Link."</p>
      <p><strong>Mac (Safari):</strong> Right-click the button and choose "Download Linked File."</p>
      <p><strong>iPhone / iPad (Safari):</strong> Tap and hold the button, then choose "Download Linked File" — it saves to your Files app.</p>
      <p><strong>Multiple files?</strong> This downloads as a single .ZIP file — unzip it to get everything inside.</p>
      <p style="margin-top: 2rem; color: #666; font-size: 0.85rem;">— The Invisible Panchos</p>
    </div>
  `

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Panchos Bodega <downloads@theinvisiblepanchos.com>',
        to: [email],
        subject: `Your download: ${title}`,
        html
      })
    })
  } catch (err) {
    // A failed email should never block the buyer from getting their file.
    console.error('Failed to send download email:', err)
  }
}

// Multi-track albums aren't pre-zipped in Storage (a single big zip object
// can exceed the per-file size cap), so there's no one link to email. Instead
// email every track's own signed link — the buyer downloading right now in
// the browser still gets a single assembled zip (see below), this is just
// the fallback for opening the email later or on another device.
async function sendTrackListEmail(email: string, title: string, tracks: { title: string; url: string }[]) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const trackRows = tracks.map((t, i) => `
    <p style="margin: 0.5rem 0;">
      <a href="${t.url}" style="color: #000;">${i + 1}. ${t.title}</a>
    </p>
  `).join('')

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="letter-spacing: 1px;">Thanks for grabbing "${title}"!</h2>
      <p>Your browser should already be downloading a zip of the full album. These individual track links are good for the next 60 minutes as a backup, or for opening on another device:</p>
      <div style="margin: 1.5rem 0;">${trackRows}</div>
      <p><strong>Windows / Android:</strong> Right-click (or tap and hold) a link and choose "Save Link As" / "Download Link."</p>
      <p><strong>Mac (Safari):</strong> Right-click a link and choose "Download Linked File."</p>
      <p><strong>iPhone / iPad (Safari):</strong> Tap and hold a link, then choose "Download Linked File" — it saves to your Files app.</p>
      <p style="margin-top: 2rem; color: #666; font-size: 0.85rem;">— The Invisible Panchos</p>
    </div>
  `

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Panchos Bodega <downloads@theinvisiblepanchos.com>',
        to: [email],
        subject: `Your download: ${title}`,
        html
      })
    })
  } catch (err) {
    console.error('Failed to send track list email:', err)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, email } = await req.json()

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.")
    }

    if (!productId) {
      throw new Error("Missing product.")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('title, price_cents, audio_preview_url, tracklist_snippets, published')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      throw new Error("Product not found.")
    }

    // Server-side gate: only genuinely free, published products can be
    // fetched through this endpoint — otherwise anyone could grab a paid
    // product for free just by knowing its id.
    if (!product.published) {
      throw new Error("This product is not available.")
    }
    if ((product.price_cents ?? 0) !== 0) {
      throw new Error("This product is not free.")
    }

    // Albums are stored as individual track files rather than one pre-made
    // zip (a single big zip object can exceed Storage's per-file size cap),
    // so build the array from tracklist_snippets when present.
    const tracks = Array.isArray(product.tracklist_snippets) ? product.tracklist_snippets : []
    const targetFilenames = tracks.length > 0
      ? tracks.map((t: { url: string }) => extractStoragePath(t.url, 'audio-vault')).filter(Boolean)
      : [extractStoragePath(product.audio_preview_url, 'audio-vault')].filter(Boolean)

    if (targetFilenames.length === 0) {
      throw new Error("No digital file attached to this product.")
    }

    await supabase.from('email_captures').insert({ product_id: productId, email })

    if (targetFilenames.length === 1) {
      const downloadFilename = targetFilenames[0].replace(/^\d+-/, '')

      const { data, error } = await supabase
        .storage
        .from('audio-vault')
        .createSignedUrl(targetFilenames[0], 3600, { download: downloadFilename })

      if (error) throw error

      await sendDownloadEmail(email, product.title || 'your download', data.signedUrl)

      return new Response(
        JSON.stringify({ downloadUrl: data.signedUrl }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
      )
    }

    // Multiple tracks: email each track's own signed link as a backup/other-
    // device fallback, and hand the requesting browser one zip assembled
    // here on the fly — nothing gets written back to Storage, so the
    // assembled zip itself never risks hitting the per-file size cap.
    const trackLinks: { title: string; url: string }[] = []
    for (let i = 0; i < targetFilenames.length; i++) {
      const downloadFilename = targetFilenames[i].replace(/^\d+-/, '')
      const { data, error } = await supabase
        .storage
        .from('audio-vault')
        .createSignedUrl(targetFilenames[i], 3600, { download: downloadFilename })
      if (error) throw error
      trackLinks.push({ title: tracks[i]?.title || `Track ${i + 1}`, url: data.signedUrl })
    }
    await sendTrackListEmail(email, product.title || 'your download', trackLinks)

    const zip = new JSZip()
    for (const path of targetFilenames) {
      const { data, error } = await supabase.storage.from('audio-vault').download(path)
      if (error) throw error
      zip.file(path.replace(/^\d+-/, ''), await data.arrayBuffer())
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array' })
    const zipFilename = `${(product.title || 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`

    return new Response(zipBytes, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFilename}"`
      },
      status: 200
    })

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
