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
    //    present, the buyer gets a real download after checkout.
    const { title, priceCents, filePath } = await req.json()
    if (!title || !priceCents || priceCents <= 0) {
      throw new Error('A product title and a positive price are required.')
    }

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
