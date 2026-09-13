import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SITE_URL = 'https://bodega.theinvisiblepanchos.com'

// Services never have a cart entry point at all, so a service's PAYMENT
// button needs its own standalone Stripe session instead of the normal
// cart/create-checkout-session pipeline — same shape as create-tip-session
// (ad-hoc price_data, no persisted stripe_product_id, no shipping/inventory/
// order_items concept to fit into).
//
// There's no fixed price here and nothing non-refundable — the admin tells
// the customer what to pay off-site (a message, a call, however scope got
// worked out), and the customer types that amount into the PAYMENT modal
// themselves. $50 cents is Stripe's own minimum charge, not a business rule.
const MIN_PAYMENT_CENTS = 50

// A custom payment for a service isn't a sale of tangible goods, so Stripe
// Tax shouldn't add sales tax to it (same rationale as tips).
const NONTAXABLE_TAX_CODE = 'txcd_00000000'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, amountCents } = await req.json()
    if (!productId) throw new Error('Missing product.')

    const requested = Math.round(Number(amountCents))
    if (!Number.isFinite(requested) || requested < MIN_PAYMENT_CENTS) {
      throw new Error(`Enter an amount of at least $${(MIN_PAYMENT_CENTS / 100).toFixed(2)}.`)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, title, category, published')
      .eq('id', productId)
      .single()

    if (productError || !product) throw new Error('Product not found.')
    if (!product.published) throw new Error('This item is not available.')
    if (product.category !== 'services') throw new Error('This payment type is only available for services.')

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: requested,
          product_data: {
            name: `Payment — ${product.title}`,
            description: 'Thanks for supporting The Invisible Panchos.',
            tax_code: NONTAXABLE_TAX_CODE,
          },
        },
        quantity: 1,
      }],
      automatic_tax: { enabled: false },
      // `productPayment` is what stripe-webhook branches on, mirroring how
      // it already branches on `tip` — skips every fulfillment step
      // (inventory, downloads, shipping labels, Printful) that a real
      // product line item would otherwise trigger. `pricingMode` is a fixed
      // label now (every service payment is the same shape) — kept only
      // because product_payments.pricing_mode is NOT NULL in the DB.
      metadata: {
        productPayment: 'true',
        productId: product.id,
        productTitle: product.title,
        pricingMode: 'payment',
      },
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&service=1`,
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
