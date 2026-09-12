import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Admin-only reference tool: lists every product already synced to this
// store's Printful account, with each variant's IDs pre-formatted exactly
// as parsePrintfulVariantMap (main.js) expects — S:variantId:syncVariantId
// per size, comma-joined, or a bare variantId:syncVariantId with no prefix
// for a single sizeless variant (matches the 'default' key convention).
// Exists because Printful's own dashboard doesn't reliably surface the
// plain numeric IDs in one obvious place — confirmed live against a real
// synced product before building this.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // verify_jwt (config.toml) only checks that *some* valid JWT is
    // present — the public anon key embedded in the client bundle counts,
    // so it doesn't actually require a logged-in admin (confirmed live: a
    // plain anon-key request got through). This is the real gate: it asks
    // Supabase who the token actually belongs to, and only a real
    // authenticated session resolves to a user.
    const authHeader = req.headers.get('Authorization') ?? ''
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'Admin login required.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    const printfulKey = Deno.env.get('PRINTFUL_API_KEY')
    if (!printfulKey) throw new Error('Printful is not configured yet.')

    const listRes = await fetch('https://api.printful.com/store/products', {
      headers: { 'Authorization': `Bearer ${printfulKey}` },
    })
    const listBody = await listRes.json()
    if (!listRes.ok) throw new Error(listBody?.result || 'Failed to reach Printful.')

    const products = []
    for (const item of listBody.result || []) {
      const detailRes = await fetch(`https://api.printful.com/store/products/${item.id}`, {
        headers: { 'Authorization': `Bearer ${printfulKey}` },
      })
      const detailBody = await detailRes.json()
      if (!detailRes.ok) continue

      const variants = (detailBody.result?.sync_variants || []).map((v: any) => ({
        size: v.size || null,
        variantId: v.variant_id,
        syncVariantId: v.id,
      }))

      // A single variant needs no size prefix regardless of what Printful
      // labels it ("One size", etc.) — parsePrintfulVariantMap (main.js)
      // treats a bare "variantId:syncVariantId" with no comma as the
      // sizeless 'default' key, which is what a one-variant product is.
      const formatted = variants.length === 1
        ? `${variants[0].variantId}:${variants[0].syncVariantId}`
        : variants
            .filter((v: any) => v.size)
            .map((v: any) => `${v.size}:${v.variantId}:${v.syncVariantId}`)
            .join(', ')

      products.push({
        syncProductId: item.id,
        name: item.name,
        thumbnailUrl: item.thumbnail_url || null,
        variants,
        formatted,
      })
    }

    return new Response(
      JSON.stringify({ products }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
