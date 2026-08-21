import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno"

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2022-11-15',
  httpClient: Stripe.createFetchHttpClient(),
})

// Deno doesn't have Node's synchronous crypto APIs, so signature
// verification has to go through Stripe's async + Web Crypto path.
const cryptoProvider = Stripe.createSubtleCryptoProvider()

// Buys the actual shipping label from Shippo using the exact rate the buyer
// already paid for, and writes the result onto the order row. A failure here
// never fails the webhook — the payment already succeeded, so the order
// stays recorded with label_status 'failed' and the admin can retry it from
// the panel instead of the order silently vanishing.
async function purchaseLabelForOrder(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  rateId: string | null,
  shippoKey: string | undefined
) {
  if (!shippoKey || !rateId) {
    await supabase.from('orders').update({
      label_status: 'failed',
      label_error: !shippoKey ? 'Shipping is not configured yet.' : 'No shipping rate on this order.'
    }).eq('id', orderId)
    return
  }

  try {
    const res = await fetch('https://api.goshippo.com/transactions/', {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${shippoKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ rate: rateId, label_file_type: 'PDF', async: false })
    })
    const txn = await res.json()

    if (!res.ok || txn.status !== 'SUCCESS') {
      const message = Array.isArray(txn?.messages)
        ? txn.messages.map((m: { text: string }) => m.text).join('; ')
        : (txn?.status || 'Label purchase failed.')
      await supabase.from('orders').update({ label_status: 'failed', label_error: message }).eq('id', orderId)
      return
    }

    await supabase.from('orders').update({
      label_status: 'purchased',
      label_error: null,
      label_url: txn.label_url,
      tracking_number: txn.tracking_number,
      tracking_url: txn.tracking_url_provider || null
    }).eq('id', orderId)
  } catch (err) {
    await supabase.from('orders').update({
      label_status: 'failed',
      label_error: err instanceof Error ? err.message : String(err)
    }).eq('id', orderId)
  }
}

serve(async (req) => {
  const signature = req.headers.get('Stripe-Signature')
  const body = await req.text()

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature as string,
      Deno.env.get('STRIPE_WEBHOOK_SECRET') as string,
      undefined,
      cryptoProvider
    )
  } catch (err) {
    // Not a genuine, correctly-signed event from Stripe — reject it.
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product']
      })

      for (const item of lineItems.data) {
        // @ts-ignore - expanded product isn't fully typed
        const stripeProductId = item.price?.product?.id
        const quantity = item.quantity ?? 1
        if (stripeProductId) {
          await supabase.rpc('decrement_inventory', {
            p_stripe_product_id: stripeProductId,
            p_quantity: quantity
          })
        }
      }
    } catch (err) {
      // Log it, but still ack the event — retrying won't fix a data
      // mismatch, and Stripe will keep resending an unacknowledged event.
      console.error('Failed to decrement inventory for session', session.id, err)
    }

    // Only the live Shippo apparel checkout (create-checkout-session) tags
    // its sessions with a shipping address — static Payment Link purchases
    // (music, art, the old manual apparel link) have none, and don't need an
    // order/label record.
    if (session.metadata?.shipping_street1) {
      try {
        // Stripe can resend the same event; stripe_session_id is unique, so
        // a duplicate delivery just no-ops instead of double-buying a label.
        const { data: existingOrder } = await supabase
          .from('orders')
          .select('id')
          .eq('stripe_session_id', session.id)
          .maybeSingle()

        if (!existingOrder) {
          const metadata = session.metadata
          const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert({
              stripe_session_id: session.id,
              product_id: metadata.product_id || null,
              product_title: metadata.product_title || 'Untitled',
              size: metadata.size || null,
              weight_oz: metadata.weight_oz ? parseFloat(metadata.weight_oz) : null,
              amount_total_cents: session.amount_total,
              customer_email: session.customer_details?.email || null,
              shipping_name: metadata.shipping_name || null,
              shipping_street1: metadata.shipping_street1 || null,
              shipping_street2: metadata.shipping_street2 || null,
              shipping_city: metadata.shipping_city || null,
              shipping_state: metadata.shipping_state || null,
              shipping_zip: metadata.shipping_zip || null,
              shipping_country: metadata.shipping_country || null,
              shipping_service: metadata.shipping_service || null,
              shipping_rate_id: metadata.shipping_rate_id || null
            })
            .select()
            .single()

          if (orderError) throw orderError

          await purchaseLabelForOrder(
            supabase,
            order.id,
            metadata.shipping_rate_id || null,
            Deno.env.get('SHIPPO_API_KEY')
          )
        }
      } catch (err) {
        console.error('Failed to create order / purchase label for session', session.id, err)
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
})
