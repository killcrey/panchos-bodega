import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mirrors purchase-shipping-label's own resubmission — a failed Printful
// order (timeout, validation error, Printful API outage during the
// original webhook delivery) had no way to be retried at all before this;
// the admin could see "Printful Failed" with the real error, but the only
// recovery was re-creating the order by hand directly in Printful's own
// dashboard. See AUDIT.md Pass 3.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Only a logged-in admin may (re)submit a Printful order.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace('Bearer ', '')

    const authClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )
    const { data: { user }, error: authError } = await authClient.auth.getUser(token)
    if (authError || !user) {
      throw new Error('You must be logged in as an admin to retry a Printful order.')
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
      .select('*, order_items(*)')
      .eq('id', orderId)
      .single()

    if (orderError || !order) {
      throw new Error('Order not found.')
    }

    const printfulItems = (order.order_items || [])
      .filter((it: any) => it.printful_sync_variant_id != null)
      .map((it: any) => ({ sync_variant_id: it.printful_sync_variant_id, quantity: it.quantity || 1 }))

    if (printfulItems.length === 0) {
      throw new Error('This order has no Printful items on it.')
    }

    const printfulKey = Deno.env.get('PRINTFUL_API_KEY')
    if (!printfulKey) {
      throw new Error('Printful is not configured yet.')
    }

    const res = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${printfulKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: {
          name: order.shipping_name,
          address1: order.shipping_street1,
          address2: order.shipping_street2 || undefined,
          city: order.shipping_city,
          state_code: order.shipping_state,
          country_code: order.shipping_country,
          zip: order.shipping_zip,
        },
        items: printfulItems,
        // Sent straight to production — this order is already paid for.
        confirm: true,
      })
    })
    const body = await res.json()

    if (!res.ok) {
      const message = body?.result || body?.error?.message || 'Printful order submission failed.'
      await supabase.from('orders').update({ printful_order_status: 'failed', printful_order_error: message }).eq('id', orderId)
      throw new Error(message)
    }

    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({
        printful_order_status: 'submitted',
        printful_order_error: null,
        printful_order_id: body?.result?.id ?? null,
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
