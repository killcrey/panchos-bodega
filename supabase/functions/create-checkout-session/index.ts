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
    const { items, rateId, toAddress } = await req.json()

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Your cart is empty.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const productIds = [...new Set(items.map((i: any) => i.productId))]
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, title, price_cents, category, stripe_product_id, published, inventory_count, weight_oz, sizes')
      .in('id', productIds)

    if (productsError) throw productsError
    const productsById = new Map((products || []).map(p => [p.id, p]))

    // Re-validate every line against the database instead of trusting
    // whatever price/availability the client sent back — the client only
    // ever picks a product id, size, and quantity.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
    const orderItems: Array<{
      id: string; title: string; category: string | null; size: string | null
      quantity: number; unitAmountCents: number; weightOz: number | null
    }> = []
    let hasApparel = false

    for (const item of items) {
      const product = productsById.get(item.productId)
      if (!product) throw new Error('One of the items in your cart no longer exists.')
      if (!product.published) throw new Error(`"${product.title}" is not available.`)
      if (!product.stripe_product_id) throw new Error(`"${product.title}" has no checkout configured yet.`)
      if (!product.price_cents || product.price_cents <= 0) throw new Error(`"${product.title}" has no price set.`)

      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1)
      if (product.inventory_count != null && product.inventory_count < quantity) {
        throw new Error(`Only ${product.inventory_count} of "${product.title}" left in stock.`)
      }
      if (product.sizes && !item.size) {
        throw new Error(`Select a size for "${product.title}".`)
      }

      if (product.category === 'apparel') hasApparel = true

      lineItems.push({
        price_data: {
          currency: 'usd',
          product: product.stripe_product_id,
          unit_amount: Math.round(product.price_cents),
        },
        quantity,
      })

      orderItems.push({
        id: product.id,
        title: product.title,
        category: product.category || null,
        size: item.size || null,
        quantity,
        unitAmountCents: product.price_cents,
        weightOz: product.weight_oz != null ? product.weight_oz : null,
      })
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // Stripe metadata caps each value at 500 chars — pack each cart line into
    // its own JSON-string key instead of many small keys, so a cart with a
    // reasonable number of items comfortably fits the ~50-key limit.
    const metadata: Record<string, string> = { item_count: String(orderItems.length) }
    orderItems.forEach((oi, i) => { metadata[`item_${i}`] = JSON.stringify(oi) })

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      line_items: lineItems,
      automatic_tax: { enabled: true },
      metadata,
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/`,
    }

    if (hasApparel) {
      if (!rateId || !toAddress) {
        throw new Error('Missing shipping rate or address for an apparel item in your cart.')
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

      metadata.shipping_rate_id = rateId
      metadata.shipping_name = toAddress?.name || ''
      metadata.shipping_street1 = toAddress?.street1 || ''
      metadata.shipping_street2 = toAddress?.street2 || ''
      metadata.shipping_city = toAddress?.city || ''
      metadata.shipping_state = toAddress?.state || ''
      metadata.shipping_zip = toAddress?.zip || ''
      metadata.shipping_country = toAddress?.country || ''
      metadata.shipping_service = shippingLabel

      sessionParams.shipping_options = [{
        shipping_rate_data: {
          type: 'fixed_amount',
          fixed_amount: { amount: shippingAmountCents, currency: 'usd' },
          display_name: shippingLabel,
        },
      }]

      // The address was already collected to price the shipping rate, so
      // it's attached to a Customer for Stripe Tax instead of asking for it
      // again on Stripe's page.
      const customer = await stripe.customers.create({
        name: toAddress?.name || undefined,
        address: {
          line1: toAddress?.street1 || undefined,
          line2: toAddress?.street2 || undefined,
          city: toAddress?.city || undefined,
          state: toAddress?.state || undefined,
          postal_code: toAddress?.zip || undefined,
          country: toAddress?.country || undefined,
        },
      })
      sessionParams.customer = customer.id
    } else {
      // No address collected up front for a digital-only cart — let Stripe's
      // own Checkout page collect billing address, which Stripe Tax needs.
      sessionParams.billing_address_collection = 'required'
    }

    const session = await stripe.checkout.sessions.create(sessionParams)

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
