import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@12.0.0"

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
      const product = item.price?.product as { name?: string; metadata?: Record<string, string> } | undefined
      const metadata = product?.metadata || {}

      const filenames: string[] = []
      if (metadata.file_count) {
        const count = parseInt(metadata.file_count, 10)
        for (let i = 0; i < count; i++) {
          if (metadata[`file_${i}`]) filenames.push(metadata[`file_${i}`])
        }
      } else if (metadata.file) {
        filenames.push(metadata.file)
      }

      if (filenames.length === 0) {
        skippedCount++
        continue
      }

      const files: { name: string; url: string }[] = []
      for (const path of filenames) {
        // Uploads are stored as "<timestamp>-<original name>" to avoid
        // collisions in the bucket — strip that prefix so the file saves
        // locally under its original name.
        const downloadFilename = path.replace(/^\d+-/, '')
        const { data, error } = await supabase
          .storage
          .from('audio-vault')
          .createSignedUrl(path, 3600, { download: downloadFilename })
        if (error) throw error
        files.push({ name: downloadFilename, url: data.signedUrl })
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
