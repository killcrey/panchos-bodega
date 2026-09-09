import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SITE_URL = 'https://bodega.theinvisiblepanchos.com'

// Services never have a cart entry point at all, so Reserve and a service's
// Offer Based both need their own standalone Stripe session instead of the
// normal cart/create-checkout-session pipeline — same shape as
// create-tip-session (ad-hoc price_data, no persisted stripe_product_id, no
// shipping/inventory/order_items concept to fit into). Non-service Offer
// Based items go through the normal cart instead, since a physical item
// still needs shipping/inventory — this function rejects those.
const RESERVE_DEPOSIT_CENTS = 2500

// Same rationale as tips: a deposit or a custom offer for a service isn't a
// sale of tangible goods, so Stripe Tax shouldn't add sales tax to it.
const NONTAXABLE_TAX_CODE = 'txcd_00000000'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, amountCents } = await req.json()
    if (!productId) throw new Error('Missing product.')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('id, title, category, published, pricing_mode, offer_min_cents, offer_max_cents')
      .eq('id', productId)
      .single()

    if (productError || !product) throw new Error('Product not found.')
    if (!product.published) throw new Error('This item is not available.')
    // Reserve is deliberately services-only — "applied toward the final
    // price" only means something when there's a booking to apply it to.
    if (product.category !== 'services') throw new Error('This payment type is only available for services.')

    let finalAmountCents: number
    let productName: string
    let productDescription: string

    if (product.pricing_mode === 'reserve') {
      finalAmountCents = RESERVE_DEPOSIT_CENTS
      productName = `Reservation Deposit — ${product.title}`
      productDescription = 'Non-refundable. Applied toward the final price once details are worked out.'
    } else if (product.pricing_mode === 'offer_based') {
      const min = product.offer_min_cents ?? 100
      const max = product.offer_max_cents ?? 100000
      const requested = Math.round(Number(amountCents))
      if (!Number.isFinite(requested)) throw new Error('Enter an offer amount.')
      finalAmountCents = Math.min(Math.max(requested, min), max)
      productName = `Custom Offer — ${product.title}`
      productDescription = 'Thanks for supporting The Invisible Panchos.'
    } else {
      throw new Error('This product is not set up for direct payment.')
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: finalAmountCents,
          product_data: {
            name: productName,
            description: productDescription,
            tax_code: NONTAXABLE_TAX_CODE,
          },
        },
        quantity: 1,
      }],
      automatic_tax: { enabled: false },
      // `productPayment` is what stripe-webhook branches on, mirroring how
      // it already branches on `tip` — skips every fulfillment step
      // (inventory, downloads, shipping labels, Printful) that a real
      // product line item would otherwise trigger.
      metadata: {
        productPayment: 'true',
        productId: product.id,
        productTitle: product.title,
        pricingMode: product.pricing_mode,
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
