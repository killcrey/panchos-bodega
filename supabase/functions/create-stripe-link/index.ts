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

    // 2. Read the product details supplied by the admin form. `filePath` is the
    //    object's key in the audio-vault bucket (not the full public URL) — when
    //    present, the buyer gets a real download after checkout. `category` and
    //    `sizes` drive apparel-specific checkout behavior (shipping + a size
    //    picker) further down.
    const { title, priceCents, filePath, category, sizes } = await req.json()
    if (!title || !priceCents || priceCents <= 0) {
      throw new Error('A product title and a positive price are required.')
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
      ...(filePath ? { metadata: { file: filePath } } : {})
    })

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(priceCents),
      currency: 'usd',
    })

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      // Only digital products need to land on the download page after checkout.
      ...(filePath ? {
        after_completion: {
          type: 'redirect',
          redirect: { url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}` }
        }
      } : {}),
      // Apparel is physical: collect a shipping address, and if the admin
      // listed sizes, make the buyer pick one at checkout.
      ...(isApparel ? { shipping_address_collection: { allowed_countries: ['US'] } } : {}),
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
      JSON.stringify({ url: paymentLink.url }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
