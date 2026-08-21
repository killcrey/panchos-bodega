import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Where every package actually ships from. Shippo needs this as the rate
// origin for every quote.
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

// Admins only enter a package weight per product — every apparel item ships
// in the same box size. Good enough for accurate rates without asking for
// per-product dimensions.
const DEFAULT_PARCEL_DIMENSIONS = {
  length: '10',
  width: '8',
  height: '4',
  distance_unit: 'in',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, toAddress } = await req.json()

    if (!productId) {
      throw new Error('Missing product.')
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

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('title, category, weight_oz, published')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      throw new Error('Product not found.')
    }
    if (!product.published) {
      throw new Error('This product is not available.')
    }
    if (product.category !== 'apparel') {
      throw new Error('This product does not ship — no shipping rates needed.')
    }
    if (!product.weight_oz || product.weight_oz <= 0) {
      throw new Error('This product is missing a package weight. Add one in the admin panel before it can be purchased.')
    }

    const shippoKey = Deno.env.get('SHIPPO_API_KEY')
    if (!shippoKey) {
      throw new Error('Shipping is not configured yet.')
    }

    const shippoRes = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address_from: ADDRESS_FROM,
        address_to: {
          name: toAddress.name,
          street1: toAddress.street1,
          street2: toAddress.street2 || '',
          city: toAddress.city,
          state: toAddress.state,
          zip: toAddress.zip,
          country: toAddress.country,
        },
        parcels: [{
          ...DEFAULT_PARCEL_DIMENSIONS,
          weight: String(product.weight_oz),
          mass_unit: 'oz',
        }],
        async: false,
      }),
    })

    const shipment = await shippoRes.json()

    if (!shippoRes.ok) {
      throw new Error(shipment?.detail || 'Shippo rejected the shipment request.')
    }

    // A bad but well-formed address (e.g. wrong zip for the city) comes back
    // as a shipment with no rates and a validation message instead of an
    // HTTP error.
    const rates = Array.isArray(shipment.rates) ? shipment.rates : []
    if (rates.length === 0) {
      const addressError = shipment?.address_to?.validation_results?.messages?.[0]?.text
      throw new Error(addressError || 'No shipping rates available for that address.')
    }

    const simplifiedRates = rates
      .map((rate: any) => ({
        id: rate.object_id,
        provider: rate.provider,
        service: rate.servicelevel?.name || rate.servicelevel?.token || 'Shipping',
        amount: rate.amount,
        currency: rate.currency,
        estimatedDays: rate.estimated_days ?? null,
      }))
      .sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))
      .slice(0, 6)

    return new Response(
      JSON.stringify({ rates: simplifiedRates }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
