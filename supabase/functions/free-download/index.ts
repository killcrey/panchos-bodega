import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

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
      .select('price_cents, audio_preview_url, published')
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

    const targetFilename = extractStoragePath(product.audio_preview_url, 'audio-vault')
    if (!targetFilename) {
      throw new Error("No digital file attached to this product.")
    }

    await supabase.from('email_captures').insert({ product_id: productId, email })

    const downloadFilename = targetFilename.replace(/^\d+-/, '')

    const { data, error } = await supabase
      .storage
      .from('audio-vault')
      .createSignedUrl(targetFilename, 3600, { download: downloadFilename })

    if (error) throw error

    return new Response(
      JSON.stringify({ downloadUrl: data.signedUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
