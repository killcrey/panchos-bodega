import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@12.0.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mirrors the same helpers in stripe-webhook/index.ts and download-zip/index.ts.
// A zip link is signed (HMAC over session + product + expiry, using
// UNSUBSCRIBE_SECRET with a "zip|" prefix) and only ever minted here after the
// payment was verified, so download-zip needs no Stripe call of its own.
async function buildZipUrl(sessionId: string, stripeProductId: string, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(Deno.env.get('UNSUBSCRIBE_SECRET') ?? ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`zip|${sessionId}|${stripeProductId}|${exp}`))
  const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  const base = Deno.env.get('SUPABASE_URL') ?? ''
  return `${base}/functions/v1/download-zip?s=${encodeURIComponent(sessionId)}&p=${encodeURIComponent(stripeProductId)}&e=${exp}&t=${token}`
}

// The public URL stored on a product row -> the object's path in audio-vault.
function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const marker = '/storage/v1/object/public/audio-vault/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  try { return decodeURIComponent(url.slice(idx + marker.length).split('?')[0]) } catch { return url.slice(idx + marker.length).split('?')[0] }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { session_id } = await req.json()

    if (!session_id) {
      throw new Error("Missing receipt. Access denied.")
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ['line_items.data.price.product']
    })

    if (session.payment_status !== 'paid') {
      throw new Error("Payment failed or incomplete. Access denied.")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // A cart can hold several products in one order — walk every line item
    // and build a download block for whichever ones have a digital file
    // attached (apparel, or a digital item with none, are skipped rather
    // than erroring the whole receipt).
    const lineItems = session.line_items?.data || []
    const downloads: { title: string; files: { name: string; url: string }[] }[] = []
    let skippedCount = 0

    for (const item of lineItems) {
      // @ts-ignore - bypassing strict type checking for the expanded product
      const product = item.price?.product as { id?: string; name?: string; metadata?: Record<string, string> } | undefined
      const metadata = product?.metadata || {}

      // The files a buyer gets come from the product's CURRENT files in the
      // database, not the copy saved on the Stripe product when its Checkout ID
      // was generated — that copy goes stale the moment audio is replaced in
      // the admin (two live albums were left pointing at deleted files).
      // Stripe's copy is only a fallback for a product with no database row.
      let paths: string[] = []
      let rowFound = false
      if (product?.id) {
        const { data: row } = await supabase
          .from('products')
          .select('download_files, tracklist_snippets, audio_preview_url')
          .eq('stripe_product_id', product.id)
          .maybeSingle()
        if (row) {
          rowFound = true
          const dl = Array.isArray(row.download_files) ? row.download_files : []
          const tr = Array.isArray(row.tracklist_snippets) ? row.tracklist_snippets : []
          const rowItems = dl.length ? dl : tr
          paths = (rowItems.length ? rowItems.map((i: { url: string }) => pathFromUrl(i.url)) : [pathFromUrl(row.audio_preview_url)]).filter(Boolean) as string[]
        }
      }
      if (!rowFound && paths.length === 0) {
        if (metadata.file_count) {
          const count = parseInt(metadata.file_count, 10)
          for (let i = 0; i < count; i++) if (metadata[`file_${i}`]) paths.push(metadata[`file_${i}`])
        } else if (metadata.file) {
          paths.push(metadata.file)
        }
      }

      if (paths.length === 0) {
        skippedCount++
        continue
      }

      const files: { name: string; url: string }[] = []
      if (paths.length > 1 && product?.id) {
        // More than one file: one .zip, assembled on the fly by download-zip.
        const title = (product.name || 'Download').replace(/[^A-Za-z0-9._ -]/g, '_').trim() || 'Download'
        files.push({ name: `${title}.zip`, url: await buildZipUrl(session_id, product.id, 3600) })
      } else {
        for (const path of paths) {
          // Uploads are stored as "<timestamp>-<original name>" to avoid
          // collisions in the bucket — strip that prefix so the file saves
          // locally under its original name.
          const downloadFilename = path.replace(/^\d+-/, '')
          const { data, error } = await supabase
            .storage
            .from('audio-vault')
            .createSignedUrl(path, 3600, { download: downloadFilename })
          if (error) { console.error('secure-download: cannot sign', path, error); continue }
          files.push({ name: downloadFilename, url: data.signedUrl })
        }
      }

      if (files.length === 0) {
        skippedCount++
        continue
      }
      downloads.push({ title: product?.name || 'Download', files })
    }

    if (downloads.length === 0) {
      throw new Error("No digital file attached to this order.")
    }

    return new Response(
      JSON.stringify({ downloads, skippedCount }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400
      }
    )
  }
})
