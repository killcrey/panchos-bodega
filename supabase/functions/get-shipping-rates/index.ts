import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Where every self-fulfilled package actually ships from. Shippo needs this
// as the rate origin for every quote. Printful ships from its own
// facilities, so it never needs this address.
const ADDRESS_FROM = {
  name: 'Panchos Bodega',
  street1: '3582 Dory Dr',
  city: 'Bonita',
  state: 'CA',
  zip: '91902',
  country: 'US',
  email: 'info@theinvisiblepanchos.com',
  phone: '619-777-8451',
}

// Admins only enter a package weight per self-fulfilled product — every
// such item ships in the same box size. A cart with several is quoted as
// one combined parcel (summed weight) rather than one rate per item — good
// enough for accurate rates without asking for per-product dimensions or
// multi-box packing logic.
const DEFAULT_PARCEL_DIMENSIONS = {
  length: '10',
  width: '8',
  height: '4',
  distance_unit: 'in',
}

async function fetchShippoRates(toAddress: any, totalWeightOz: number, shippoKey: string) {
  const res = await fetch('https://api.goshippo.com/shipments/', {
    method: 'POST',
    headers: { 'Authorization': `ShippoToken ${shippoKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address_from: ADDRESS_FROM,
      address_to: {
        name: toAddress.name, street1: toAddress.street1, street2: toAddress.street2 || '',
        city: toAddress.city, state: toAddress.state, zip: toAddress.zip, country: toAddress.country,
      },
      parcels: [{ ...DEFAULT_PARCEL_DIMENSIONS, weight: String(totalWeightOz), mass_unit: 'oz' }],
      async: false,
    }),
  })
  const shipment = await res.json()
  if (!res.ok) throw new Error(shipment?.detail || 'Shippo rejected the shipment request.')

  const rates = Array.isArray(shipment.rates) ? shipment.rates : []
  if (rates.length === 0) {
    const addressError = shipment?.address_to?.validation_results?.messages?.[0]?.text
    throw new Error(addressError || 'No shipping rates available for that address.')
  }

  return rates
    .map((rate: any) => ({
      id: rate.object_id,
      provider: rate.provider,
      service: rate.servicelevel?.name || rate.servicelevel?.token || 'Shipping',
      amount: parseFloat(rate.amount),
      estimatedDays: rate.estimated_days ?? null,
    }))
    .sort((a: any, b: any) => a.amount - b.amount)
    .slice(0, 6)
}

async function fetchPrintfulRates(toAddress: any, printfulItems: { variant_id: number; quantity: number }[], printfulKey: string) {
  const res = await fetch('https://api.printful.com/shipping/rates', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${printfulKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: {
        address1: toAddress.street1, address2: toAddress.street2 || '', city: toAddress.city,
        state_code: toAddress.state, country_code: toAddress.country, zip: toAddress.zip,
      },
      items: printfulItems,
    }),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body?.result || body?.error?.message || 'Printful rejected the shipping rate request.')

  const rates = Array.isArray(body.result) ? body.result : []
  if (rates.length === 0) throw new Error('No shipping rates available for that address.')

  return rates.map((rate: any) => ({
    id: rate.id,
    provider: '',
    service: (rate.name || rate.id || 'Shipping').replace(/\s*\(Estimated delivery:.*\)\s*/i, '').trim(),
    amount: parseFloat(rate.rate),
    estimatedDays: rate.maxDeliveryDays ?? rate.minDeliveryDays ?? null,
  })).sort((a: any, b: any) => a.amount - b.amount)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { items, toAddress } = await req.json()

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Missing cart items.')
    }

    const required = ['name', 'street1', 'city', 'state', 'zip', 'country']
    for (const field of required) {
      if (!toAddress || !toAddress[field] || !String(toAddress[field]).trim()) {
        throw new Error(`Missing shipping address field: ${field}`)
      }
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const productIds = [...new Set(items.map((i: any) => i.productId))]
    const { data: products, error: productsError } = await supabase
      .from('products')
      .select('id, title, weight_oz, printful_variant_map, published')
      .in('id', productIds)

    if (productsError) throw productsError
    const productsById = new Map((products || []).map(p => [p.id, p]))

    // Two fulfillment paths can be mixed in one cart: self-fulfilled physical
    // items (weight_oz set, quoted via Shippo from our own address) and
    // Printful items (printful_variant_map set, quoted via Printful from
    // whichever of their facilities has the item). They can never ship in
    // the same box — they're combined into one quoted total below, not one
    // shipment.
    let totalWeightOz = 0
    const printfulLineItems: { variant_id: number; quantity: number }[] = []

    for (const item of items) {
      const product = productsById.get(item.productId)
      if (!product) throw new Error('One of the items in your cart no longer exists.')
      if (!product.published) throw new Error(`"${product.title}" is not available.`)

      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1)

      if (product.printful_variant_map) {
        const key = item.size || 'default'
        const variant = product.printful_variant_map[key]
        if (!variant?.variantId) {
          throw new Error(`"${product.title}" has no Printful variant configured for ${key === 'default' ? 'it' : `size ${key}`}.`)
        }
        // Printful's shipping-rate API wants the catalog variant id, not the
        // sync variant id — confirmed against the live API.
        printfulLineItems.push({ variant_id: variant.variantId, quantity })
      } else if (product.weight_oz && product.weight_oz > 0) {
        totalWeightOz += product.weight_oz * quantity
      } else {
        throw new Error(`"${product.title}" does not ship — remove it from the shipping quote.`)
      }
    }

    const shippoKey = Deno.env.get('SHIPPO_API_KEY')
    const printfulKey = Deno.env.get('PRINTFUL_API_KEY')

    const [shippoRates, printfulRates] = await Promise.all([
      totalWeightOz > 0
        ? (shippoKey ? fetchShippoRates(toAddress, totalWeightOz, shippoKey) : Promise.reject(new Error('Shipping is not configured yet.')))
        : Promise.resolve(null),
      printfulLineItems.length > 0
        ? (printfulKey ? fetchPrintfulRates(toAddress, printfulLineItems, printfulKey) : Promise.reject(new Error('Printful is not configured yet.')))
        : Promise.resolve(null),
    ])

    let combinedRates: any[]
    if (shippoRates && printfulRates) {
      // Mixed cart — two separate parcels, one quoted total. Pair each
      // Shippo service level with Printful's cheapest rate (Printful
      // typically offers far fewer options than Shippo), summing price and
      // taking the longer of the two delivery estimates since the order
      // isn't complete until both packages arrive.
      const cheapestPrintful = printfulRates[0]
      combinedRates = shippoRates.map((sr: any) => ({
        id: `${sr.id}::${cheapestPrintful.id}`,
        provider: sr.provider,
        service: sr.service,
        amount: (sr.amount + cheapestPrintful.amount).toFixed(2),
        currency: 'USD',
        estimatedDays: Math.max(sr.estimatedDays || 0, cheapestPrintful.estimatedDays || 0) || null,
      }))
    } else if (shippoRates) {
      combinedRates = shippoRates.map((r: any) => ({ ...r, id: r.id, amount: r.amount.toFixed(2), currency: 'USD' }))
    } else {
      combinedRates = printfulRates.map((r: any) => ({ ...r, id: `printful::${r.id}`, amount: r.amount.toFixed(2), currency: 'USD' }))
    }

    return new Response(
      JSON.stringify({ rates: combinedRates, totalWeightOz }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
