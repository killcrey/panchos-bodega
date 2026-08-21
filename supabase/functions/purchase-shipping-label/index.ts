import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Where every package actually ships from — matches get-shipping-rates.
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
    // Only a logged-in admin may (re)purchase a label.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace('Bearer ', '')

    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )
    const { data: { user }, error: authError } = await authClient.auth.getUser(token)
    if (authError || !user) {
      throw new Error('You must be logged in as an admin to purchase a label.')
    }

    const { orderId } = await req.json()
    if (!orderId) {
      throw new Error('Missing order.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single()

    if (orderError || !order) {
      throw new Error('Order not found.')
    }

    const shippoKey = Deno.env.get('SHIPPO_API_KEY')
    if (!shippoKey) {
      throw new Error('Shipping is not configured yet.')
    }

    // The original rate the buyer paid for may have expired since checkout —
    // always get a fresh quote for a clean retry rather than risk a stale ID.
    if (!order.weight_oz) {
      throw new Error('This order has no package weight on file — cannot re-quote a rate.')
    }

    const shipmentRes = await fetch('https://api.goshippo.com/shipments/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address_from: ADDRESS_FROM,
        address_to: {
          name: order.shipping_name,
          street1: order.shipping_street1,
          street2: order.shipping_street2 || '',
          city: order.shipping_city,
          state: order.shipping_state,
          zip: order.shipping_zip,
          country: order.shipping_country,
        },
        parcels: [{
          ...DEFAULT_PARCEL_DIMENSIONS,
          weight: String(order.weight_oz),
          mass_unit: 'oz',
        }],
        async: false,
      }),
    })
    const shipment = await shipmentRes.json()
    if (!shipmentRes.ok) {
      throw new Error(shipment?.detail || 'Shippo rejected the shipment request.')
    }

    const rates = Array.isArray(shipment.rates) ? shipment.rates : []
    if (rates.length === 0) {
      throw new Error('No shipping rates available for this address anymore.')
    }

    // Prefer a rate matching the service the buyer originally paid for, so
    // the cost stays consistent with what they saw at checkout; otherwise
    // fall back to the cheapest available.
    const matching = rates.find((r: any) =>
      order.shipping_service && `${r.provider} ${r.servicelevel?.name || ''}`.trim() === order.shipping_service
    )
    const sorted = [...rates].sort((a: any, b: any) => parseFloat(a.amount) - parseFloat(b.amount))
    const chosenRate = matching || sorted[0]

    const txnRes = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ rate: chosenRate.object_id, label_file_type: 'PDF', async: false }),
    })
    const txn = await txnRes.json()

    if (!txnRes.ok || txn.status !== 'SUCCESS') {
      const message = Array.isArray(txn?.messages)
        ? txn.messages.map((m: { text: string }) => m.text).join('; ')
        : (txn?.status || 'Label purchase failed.')
      await supabase.from('orders').update({ label_status: 'failed', label_error: message }).eq('id', orderId)
      throw new Error(message)
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({
        label_status: 'purchased',
        label_error: null,
        label_url: txn.label_url,
        tracking_number: txn.tracking_number,
        tracking_url: txn.tracking_url_provider || null,
        shipping_rate_id: chosenRate.object_id
      })
      .eq('id', orderId)
      .select()
      .single()

    if (updateError) throw updateError

    return new Response(
      JSON.stringify({ order: updated }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
