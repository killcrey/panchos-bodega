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
      .select('id, title, price_cents, category, stripe_product_id, published, inventory_count, weight_oz, sizes, printful_variant_map')
      .in('id', productIds)

    if (productsError) throw productsError
    const productsById = new Map((products || []).map(p => [p.id, p]))

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // California (and most states) don't tax digital goods delivered purely
    // electronically, only tangible property — but Stripe Tax treats every
    // product as general tangible goods (txcd_99999999) unless it's told
    // otherwise. A product ships (and stays taxed as tangible goods) if it
    // has a package weight set; otherwise it's a pure digital download and
    // gets tagged with the closest matching digital-goods tax code so Stripe
    // Tax stops charging sales tax on it. Verified against the live Stripe
    // Tax Codes API.
    const DIGITAL_TAX_CODE_BY_CATEGORY: Record<string, string> = {
      music: 'txcd_10401100', // Digital Audio Works — downloaded, permanent rights
      art: 'txcd_10505001',   // Digital Finished Artwork — downloaded, permanent rights
    }
    const DEFAULT_DIGITAL_TAX_CODE = 'txcd_10503000' // Digital other news/documents — downloaded, permanent rights

// Oversized apparel (2XL and up) costs more to print/stock — flat surcharge
// added to price_cents. Mirrors src/cart.js's isUpchargeSize; never trusts
// whatever price the client sent for the item.
const SIZE_UPCHARGE_CENTS = 400
const UPCHARGE_SIZES = new Set([
  '2XL', 'XXL',
  '3XL', 'XXXL',
  '4XL', 'XXXXL',
  '5XL', 'XXXXXL',
])
function isUpchargeSize(size: string | null | undefined): boolean {
  return !!size && UPCHARGE_SIZES.has(size.trim().toUpperCase())
}

    // Re-validate every line against the database instead of trusting
    // whatever price/availability the client sent back — the client only
    // ever picks a product id, size, and quantity.
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
    const orderItems: Array<{
      id: string; title: string; category: string | null; size: string | null
      quantity: number; unitAmountCents: number; weightOz: number | null
      printfulSyncVariantId: number | null
    }> = []
    // Transient — only needed to re-quote Printful's shipping rate below,
    // never persisted (order_items stores the sync variant id instead, the
    // one that actually matters after checkout).
    const printfulShippingItems: { variant_id: number; quantity: number }[] = []
    let needsShipping = false

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

      // Two shipping paths: self-fulfilled (weight_oz set, shipped by us via
      // Shippo) or Printful (printful_variant_map set, printed and shipped
      // by Printful). Neither depends on category — apparel, art, music, and
      // pancho picks can each be physical or digital per individual item.
      let printfulSyncVariantId: number | null = null
      if (product.printful_variant_map) {
        const key = item.size || 'default'
        const variant = product.printful_variant_map[key]
        if (!variant?.variantId || !variant?.syncVariantId) {
          throw new Error(`"${product.title}" has no Printful variant configured for ${key === 'default' ? 'it' : `size ${key}`}.`)
        }
        printfulSyncVariantId = variant.syncVariantId
        printfulShippingItems.push({ variant_id: variant.variantId, quantity })
        needsShipping = true
      } else if (product.weight_oz != null && product.weight_oz > 0) {
        needsShipping = true
      } else {
        try {
          const taxCode = DIGITAL_TAX_CODE_BY_CATEGORY[product.category] || DEFAULT_DIGITAL_TAX_CODE
          await stripe.products.update(product.stripe_product_id, { tax_code: taxCode })
        } catch (err) {
          // Never block a sale over a tax classification hiccup — worst
          // case this item is taxed as general tangible goods this once.
          console.error(`Failed to set digital tax code for ${product.stripe_product_id}:`, err)
        }
      }

      const unitAmountCents = product.price_cents + (isUpchargeSize(item.size) ? SIZE_UPCHARGE_CENTS : 0)

      lineItems.push({
        price_data: {
          currency: 'usd',
          product: product.stripe_product_id,
          unit_amount: Math.round(unitAmountCents),
        },
        quantity,
      })

      orderItems.push({
        id: product.id,
        title: product.title,
        category: product.category || null,
        size: item.size || null,
        quantity,
        unitAmountCents,
        weightOz: product.weight_oz != null ? product.weight_oz : null,
        printfulSyncVariantId,
      })
    }

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

    if (needsShipping) {
      if (!rateId || !toAddress) {
        throw new Error('Missing shipping rate or address for a physical item in your cart.')
      }

      // rateId encodes up to two components joined by "::" — a Shippo rate
      // object id (re-fetchable) and/or a Printful rate id like "STANDARD"
      // (not independently re-fetchable, so it's re-validated by re-quoting
      // Printful below instead). Format comes from get-shipping-rates:
      // plain id = Shippo only, "printful::X" = Printful only, "X::Y" = both.
      let shippoRateId: string | null = null
      let printfulRateId: string | null = null
      if (rateId.startsWith('printful::')) {
        printfulRateId = rateId.slice('printful::'.length)
      } else if (rateId.includes('::')) {
        const parts = rateId.split('::')
        shippoRateId = parts[0]
        printfulRateId = parts[1]
      } else {
        shippoRateId = rateId
      }

      let shippingAmountCents = 0
      const labelParts: string[] = []

      if (shippoRateId) {
        const shippoKey = Deno.env.get('SHIPPO_API_KEY')
        if (!shippoKey) throw new Error('Shipping is not configured yet.')

        // Re-fetch the rate server-side instead of trusting whatever amount
        // the client sends back — the client only ever picks a rate ID.
        const rateRes = await fetch(`https://api.goshippo.com/rates/${shippoRateId}`, {
          headers: { 'Authorization': `ShippoToken ${shippoKey}` },
        })
        const rate = await rateRes.json()
        if (!rateRes.ok || !rate?.amount) {
          throw new Error('That shipping option is no longer available. Please pick a rate again.')
        }
        shippingAmountCents += Math.round(parseFloat(rate.amount) * 100)
        labelParts.push(`${rate.provider} ${rate.servicelevel?.name || 'Shipping'}`.trim())
        metadata.shipping_rate_id = shippoRateId
      }

      if (printfulRateId) {
        const printfulKey = Deno.env.get('PRINTFUL_API_KEY')
        if (!printfulKey) throw new Error('Printful is not configured yet.')

        // Printful has no "fetch rate by id" endpoint — re-quote with the
        // actual cart's Printful items (by catalog variant id — confirmed
        // that's what this endpoint requires, not the sync variant id) and
        // match by id, instead of trusting the client-sent amount.
        const pfRateRes = await fetch('https://api.printful.com/shipping/rates', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${printfulKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recipient: {
              address1: toAddress?.street1, address2: toAddress?.street2 || '', city: toAddress?.city,
              state_code: toAddress?.state, country_code: toAddress?.country, zip: toAddress?.zip,
            },
            items: printfulShippingItems,
          }),
        })
        const pfBody = await pfRateRes.json()
        const pfRates = Array.isArray(pfBody?.result) ? pfBody.result : []
        const matchedRate = pfRates.find((r: any) => r.id === printfulRateId)
        if (!pfRateRes.ok || !matchedRate) {
          throw new Error('That shipping option is no longer available. Please pick a rate again.')
        }
        shippingAmountCents += Math.round(parseFloat(matchedRate.rate) * 100)
        labelParts.push('Standard Shipping')
        metadata.printful_shipping_rate_id = printfulRateId
      }

      const shippingLabel = labelParts.join(' + ')

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
