import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'
import Stripe from 'https://esm.sh/stripe@11.1.0?target=deno'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SITE_URL = 'https://bodega.theinvisiblepanchos.com'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Only a logged-in admin may generate a checkout link, not just anyone
    //    holding the public anon key.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace('Bearer ', '')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      throw new Error('You must be logged in as an admin to generate a checkout link.')
    }

    // 2. Read the product details supplied by the admin form. `filePaths` are the
    //    object's key(s) in the audio-vault bucket (not the full public URL) — when
    //    present, the buyer gets a real download after checkout. A multi-track
    //    album is several individual track keys (never bundled into one big zip
    //    at upload time, so each stays well under Storage's per-file size cap);
    //    the zip a buyer actually receives is assembled on demand at download
    //    time by secure-download, from these same individual files. `category`
    //    and `sizes` drive apparel-specific checkout behavior (a size picker)
    //    further down — apparel's actual shipping cost is calculated live via
    //    Shippo at checkout time (see get-shipping-rates / create-checkout-session),
    //    not through this static link.
    const { title, priceCents, filePaths, category, sizes } = await req.json()
    if (!title || !priceCents || priceCents <= 0) {
      throw new Error('A product title and a positive price are required.')
    }

    const hasFiles = Array.isArray(filePaths) && filePaths.length > 0
    // Stripe metadata values are capped at 500 chars each, which a long file
    // path list could exceed — so each file gets its own numbered key instead
    // of packing them into one JSON string.
    const fileMetadata: Record<string, string> = {}
    if (hasFiles) {
      fileMetadata.file_count = String(filePaths.length)
      filePaths.forEach((path: string, i: number) => { fileMetadata[`file_${i}`] = path })
    }

    const isApparel = category === 'apparel'
    const sizeOptions = isApparel && typeof sizes === 'string'
      ? sizes.split(',').map((s: string) => s.trim()).filter(Boolean)
      : []

    // 3. Create the Stripe Product, Price, and a reusable Payment Link
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const product = await stripe.products.create({
      name: title,
      ...(hasFiles ? { metadata: fileMetadata } : {})
    })

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(priceCents),
      currency: 'usd',
    })

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      // Only digital products need to land on the download page after checkout.
      ...(hasFiles ? {
        after_completion: {
          type: 'redirect',
          redirect: { url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}` }
        }
      } : {}),
      // Apparel is physical: collect a US shipping address. This static link
      // has no shipping cost attached to it — apparel is actually sold
      // through the live Shippo-calculated checkout on the storefront, not
      // through this link.
      ...(isApparel ? { shipping_address_collection: { allowed_countries: ['US'] } } : {}),
      // Stripe Tax needs the buyer's location to calculate tax — it prefers
      // the shipping address when one's being collected (apparel), and
      // falls back to billing address otherwise (everything else).
      automatic_tax: { enabled: true },
      billing_address_collection: 'required',
      ...(sizeOptions.length > 0 ? {
        custom_fields: [{
          key: 'size',
          label: { type: 'custom', custom: 'Size' },
          type: 'dropdown',
          dropdown: {
            options: sizeOptions.map((size: string, i: number) => ({
              label: size.slice(0, 100),
              value: `size${i}${size.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 100)
            }))
          }
        }]
      } : {})
    })

    return new Response(
      JSON.stringify({ url: paymentLink.url, productId: product.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
