import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@12.0.0"
import JSZip from "https://esm.sh/jszip@3.10.1"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

    // @ts-ignore - bypassing strict type checking for the expanded product
    const product = session.line_items.data[0].price.product
    const metadata = product.metadata || {}

    // Albums are stored as individual track keys (file_0, file_1, ...) rather
    // than one pre-made zip, since a single big zip object can exceed
    // Storage's per-file size cap. `file_count` marks that scheme; `file` is
    // the older single-file format, kept for products created before this.
    let targetFilenames: string[] = []
    if (metadata.file_count) {
      const count = parseInt(metadata.file_count, 10)
      for (let i = 0; i < count; i++) {
        if (metadata[`file_${i}`]) targetFilenames.push(metadata[`file_${i}`])
      }
    } else if (metadata.file) {
      targetFilenames = [metadata.file]
    }

    if (targetFilenames.length === 0) {
      throw new Error("No digital file attached to this product in Stripe Metadata.")
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    if (targetFilenames.length === 1) {
      // Uploads are stored as "<timestamp>-<original name>" to avoid collisions
      // in the bucket. Strip that prefix so the file saves locally under its
      // original name instead of the storage key.
      const downloadFilename = targetFilenames[0].replace(/^\d+-/, '')

      // Passing a filename (rather than just `true`) for `download` tells
      // Supabase Storage to send Content-Disposition: attachment with that name
      // on the signed URL itself, so the browser downloads the file under a
      // clean name instead of opening it in an inline player (the HTML
      // `download` attribute alone is ignored for cross-origin links like this).
      const { data, error } = await supabase
        .storage
        .from('audio-vault')
        .createSignedUrl(targetFilenames[0], 3600, { download: downloadFilename })

      if (error) throw error

      return new Response(
        JSON.stringify({ secureUrl: data.signedUrl }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200
        }
      )
    }

    // Multiple tracks: fetch each from Storage server-side and zip them here,
    // streaming the finished zip straight back in this response. Nothing gets
    // written back to Storage, so there's no risk of the assembled zip itself
    // hitting the per-file size cap.
    const zip = new JSZip()
    for (const path of targetFilenames) {
      const { data, error } = await supabase.storage.from('audio-vault').download(path)
      if (error) throw error
      zip.file(path.replace(/^\d+-/, ''), await data.arrayBuffer())
    }
    const zipBytes = await zip.generateAsync({ type: 'uint8array' })
    const zipFilename = `${(product.name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`

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
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400 
      }
    )
  }
})