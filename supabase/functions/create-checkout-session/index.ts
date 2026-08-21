import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno"

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
    const { productId, rateId, size, toAddress } = await req.json()

    if (!productId || !rateId) {
      throw new Error('Missing product or shipping rate.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('title, price_cents, category, stripe_product_id, published, inventory_count')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      throw new Error('Product not found.')
    }
    if (!product.published) {
      throw new Error('This product is not available.')
    }
    if (product.category !== 'apparel') {
      throw new Error('This product does not use the shipping checkout flow.')
    }
    if (!product.stripe_product_id) {
      throw new Error('This product has no checkout configured yet.')
    }
    if (product.inventory_count != null && product.inventory_count <= 0) {
      throw new Error('This item is sold out.')
    }
    if (!product.price_cents || product.price_cents <= 0) {
      throw new Error('This product has no price set.')
    }

    const shippoKey = Deno.env.get('SHIPPO_API_KEY')
    if (!shippoKey) {
      throw new Error('Shipping is not configured yet.')
    }

    // Re-fetch the rate server-side instead of trusting whatever amount the
    // client sends back — the client only ever picks a rate ID, never a price.
    const rateRes = await fetch(`https://api.goshippo.com/rates/${rateId}`, {
      headers: { 'Authorization': `ShippoToken ${shippoKey}` },
    })
    const rate = await rateRes.json()
    if (!rateRes.ok || !rate?.amount) {
      throw new Error('That shipping option is no longer available. Please pick a rate again.')
    }

    const shippingAmountCents = Math.round(parseFloat(rate.amount) * 100)
    const shippingLabel = `${rate.provider} ${rate.servicelevel?.name || 'Shipping'}`.trim()

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // The address was already collected to price the shipping rate, so it's
    // attached as metadata for fulfillment instead of asking for it again on
    // Stripe's page.
    const metadata: Record<string, string> = {
      shipping_name: toAddress?.name || '',
      shipping_street1: toAddress?.street1 || '',
      shipping_street2: toAddress?.street2 || '',
      shipping_city: toAddress?.city || '',
      shipping_state: toAddress?.state || '',
      shipping_zip: toAddress?.zip || '',
      shipping_country: toAddress?.country || '',
      shipping_service: shippingLabel,
    }
    if (size) metadata.size = size

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product: product.stripe_product_id,
          unit_amount: Math.round(product.price_cents),
        },
        quantity: 1,
      }],
      shipping_options: [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: shippingAmountCents, currency: 'usd' },
          display_name: shippingLabel,
        },
      }],
      metadata,
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/`,
    })

    return new Response(
      JSON.stringify({ url: session.url }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
