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

// Mirrors the same helper in free-download/index.ts and
// sync-game-signups/index.ts — every real purchase (cart order or the older
// static Payment Link) and every tip lands the buyer's email in the same
// shared Resend Audience. RESEND_CONTACTS_API_KEY is a separate, more
// broadly-scoped key from RESEND_API_KEY (confirmed live: the latter is
// send-only and 401s on any Audiences/Contacts call).
// `audienceIdEnvVar` defaults to the shared list every source feeds
// (RESEND_AUDIENCE_ID); the purchase-confirmation call site also passes
// RESEND_BUYERS_AUDIENCE_ID so real buyers land in a second, addressable
// list — Resend's Contacts API has no per-contact tag/property that
// persists (confirmed live: sending `properties` on create/update round-
// trips back as `{}`), so a separate Audience is the only real
// segmentation primitive it has.
async function addContactToAudience(email: string, audienceIdEnvVar: string = 'RESEND_AUDIENCE_ID') {
  const resendKey = Deno.env.get('RESEND_CONTACTS_API_KEY')
  const audienceId = Deno.env.get(audienceIdEnvVar)
  if (!resendKey || !audienceId) return

  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    })
    if (!res.ok) {
      console.error(`Failed to add ${email} to Resend audience (${audienceIdEnvVar}):`, await res.text())
    }
  } catch (err) {
    console.error('Failed to add contact to Resend audience:', err)
  }
}

// Mirrors the same helper in free-download/index.ts. Resend has no managed
// unsubscribe endpoint for transactional /emails sends (only Broadcasts
// honor a contact's `unsubscribed` flag — confirmed against Resend's own
// docs, which say to build and host this yourself), so this signs an
// email with UNSUBSCRIBE_SECRET and points at the `unsubscribe` function,
// which verifies the signature and flips `unsubscribed: true` across every
// Resend Audience at once.
async function buildUnsubscribeUrl(email: string): Promise<string> {
  const secret = Deno.env.get('UNSUBSCRIBE_SECRET') ?? ''
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email.toLowerCase()))
  const token = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
  const base = Deno.env.get('SUPABASE_URL') ?? ''
  return `${base}/functions/v1/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}

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

// Submits the Printful items in an order to Printful's own Orders API so
// they get printed and shipped automatically — no admin action needed,
// unlike the Shippo label above. A failure here never fails the webhook;
// the payment already succeeded, so the order stays recorded with
// printful_order_status 'failed' and the admin can see it needs a manual
// resubmission instead of the order silently never reaching Printful.
async function submitPrintfulOrder(
  supabase: ReturnType<typeof createClient>,
  orderId: string,
  recipient: { name: string; street1: string; street2: string; city: string; state: string; zip: string; country: string },
  items: { sync_variant_id: number; quantity: number }[],
  printfulKey: string | undefined
) {
  if (!printfulKey || items.length === 0) {
    await supabase.from('orders').update({
      printful_order_status: 'failed',
      printful_order_error: !printfulKey ? 'Printful is not configured yet.' : 'No Printful items on this order.'
    }).eq('id', orderId)
    return
  }

  try {
    const res = await fetch('https://api.printful.com/orders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${printfulKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: {
          name: recipient.name,
          address1: recipient.street1,
          address2: recipient.street2 || undefined,
          city: recipient.city,
          state_code: recipient.state,
          country_code: recipient.country,
          zip: recipient.zip,
        },
        items,
        // Sent straight to production — this order is already paid for.
        confirm: true,
      })
    })
    const body = await res.json()

    if (!res.ok) {
      const message = body?.result || body?.error?.message || 'Printful order submission failed.'
      await supabase.from('orders').update({ printful_order_status: 'failed', printful_order_error: message }).eq('id', orderId)
      return
    }

    await supabase.from('orders').update({
      printful_order_status: 'submitted',
      printful_order_error: null,
      printful_order_id: body?.result?.id ?? null,
    }).eq('id', orderId)
  } catch (err) {
    await supabase.from('orders').update({
      printful_order_status: 'failed',
      printful_order_error: err instanceof Error ? err.message : String(err)
    }).eq('id', orderId)
  }
}

// Reads whichever digital files are attached to a Stripe Product's metadata
// (the same file_count/file_N / file scheme create-stripe-link writes) and
// signs a link for each so the confirmation email can hand the buyer their
// download directly. A multi-file product gets one link per track rather
// than an assembled zip — simpler and consistent with a cart that can now
// contain several different products in one email.
async function buildDownloadBlockForProduct(
  supabase: ReturnType<typeof createClient>,
  product: { name?: string; metadata?: Record<string, string> } | null | undefined
): Promise<{ title: string; files: { name: string; url: string }[] } | null> {
  const metadata = product?.metadata || {}
  const filenames: string[] = []
  if (metadata.file_count) {
    const count = parseInt(metadata.file_count, 10)
    for (let i = 0; i < count; i++) {
      if (metadata[`file_${i}`]) filenames.push(metadata[`file_${i}`])
    }
  } else if (metadata.file) {
    filenames.push(metadata.file)
  }

  if (filenames.length === 0) return null

  const files: { name: string; url: string }[] = []
  for (const path of filenames) {
    const downloadFilename = path.replace(/^\d+-/, '')
    // 24 hours — this is an emailed link the buyer may open later, not the
    // immediate post-payment success page (which uses a shorter window).
    const { data, error } = await supabase
      .storage
      .from('audio-vault')
      .createSignedUrl(path, 60 * 60 * 24, { download: downloadFilename })
    if (error || !data) continue
    files.push({ name: downloadFilename, url: data.signedUrl })
  }

  return files.length > 0 ? { title: product?.name || 'Download', files } : null
}

function money(cents: number | null | undefined): string {
  return `$${(((cents ?? 0)) / 100).toFixed(2)}`
}

// Admin-editable note (site_settings) appended near the sign-off of the
// order confirmation and tip thank-you emails — blank/null means no note,
// not an error, so every email works the same whether or not one is set.
function customMessageBlockHTML(message: string | null | undefined): string {
  if (!message) return ''
  return `
    <div style="margin: 1.5rem 0 0 0; padding-top: 1.5rem; border-top: 1px solid #444;">
      <p style="color: #ccc; font-size: 0.85rem; font-style: italic; line-height: 1.6; margin: 0;">${message}</p>
    </div>
  `
}

async function sendOrderConfirmationEmail(
  email: string,
  data: {
    lineRows: { title: string; quantity: number; amount: number }[]
    downloadBlocks: { title: string; files: { name: string; url: string }[] }[]
    subtotalCents: number | null
    taxCents: number | null
    shippingCents: number | null
    totalCents: number | null
    shippingAddress: { name: string; street1: string; street2: string; city: string; state: string; zip: string; country: string } | null
    customMessage?: string | null
  }
) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const unsubscribeUrl = await buildUnsubscribeUrl(email)

  const itemRows = data.lineRows.map(row => `
    <tr>
      <td style="padding: 0.5rem 0; color: #fff; font-size: 0.85rem;">${row.title}${row.quantity > 1 ? ` &times; ${row.quantity}` : ''}</td>
      <td style="padding: 0.5rem 0; color: #ccc; font-size: 0.85rem; text-align: right; white-space: nowrap;">${money(row.amount)}</td>
    </tr>
  `).join('')

  const totalsRows = [
    data.shippingCents != null ? `<tr><td style="padding: 0.2rem 0; color: #999; font-size: 0.8rem;">Shipping</td><td style="padding: 0.2rem 0; color: #999; font-size: 0.8rem; text-align: right;">${money(data.shippingCents)}</td></tr>` : '',
    data.taxCents != null ? `<tr><td style="padding: 0.2rem 0; color: #999; font-size: 0.8rem;">Tax</td><td style="padding: 0.2rem 0; color: #999; font-size: 0.8rem; text-align: right;">${money(data.taxCents)}</td></tr>` : '',
    `<tr><td style="padding: 0.5rem 0 0 0; color: #fff; font-size: 0.95rem; font-weight: bold; border-top: 1px solid #444;">Total</td><td style="padding: 0.5rem 0 0 0; color: #00ffcc; font-size: 0.95rem; font-weight: bold; text-align: right; border-top: 1px solid #444;">${money(data.totalCents)}</td></tr>`,
  ].join('')

  const downloadsHTML = data.downloadBlocks.length > 0 ? `
    <div style="margin: 1.5rem 0; padding-top: 1.5rem; border-top: 1px solid #444;">
      <p style="font-size: 0.75rem; color: #00ffcc; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 0.75rem 0;">Your Downloads</p>
      ${data.downloadBlocks.map(block => `
        <p style="margin: 0 0 0.5rem 0; color: #ccc; font-size: 0.8rem;">${block.title}</p>
        <div style="margin: 0 0 1rem 0;">
          ${block.files.map(f => `<p style="margin: 0.2rem 0;"><a href="${f.url}" style="color: #00ffcc;">${f.name}</a></p>`).join('')}
        </div>
      `).join('')}
      <p style="font-size: 0.7rem; color: #888; margin-top: 0.5rem;">These links are good for 24 hours. Right-click (or tap and hold) a link and choose "Save Link As" / "Download Linked File" to save it.</p>
    </div>
  ` : ''

  const addressHTML = data.shippingAddress ? `
    <div style="margin: 1.5rem 0; padding-top: 1.5rem; border-top: 1px solid #444;">
      <p style="font-size: 0.75rem; color: #00ffcc; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 0.5rem 0;">Shipping To</p>
      <p style="margin: 0; color: #ccc; font-size: 0.8rem; line-height: 1.5;">
        ${data.shippingAddress.name}<br>
        ${data.shippingAddress.street1}${data.shippingAddress.street2 ? ` ${data.shippingAddress.street2}` : ''}<br>
        ${data.shippingAddress.city}, ${data.shippingAddress.state} ${data.shippingAddress.zip}<br>
        ${data.shippingAddress.country}
      </p>
      <p style="font-size: 0.7rem; color: #888; margin-top: 0.5rem;">We'll email tracking once your package ships.</p>
    </div>
  ` : ''

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #111; padding: 2rem; border: 1px solid #333;">
      <h2 style="letter-spacing: 1px; color: #fff; margin: 0 0 0.25rem 0;">Order Confirmed</h2>
      <p style="color: #888; font-size: 0.8rem; margin: 0 0 1.5rem 0;">Thanks for shopping the Bodega.</p>
      <table style="width: 100%; border-collapse: collapse;">
        ${itemRows}
        ${totalsRows}
      </table>
      ${downloadsHTML}
      ${addressHTML}
      ${customMessageBlockHTML(data.customMessage)}
      <p style="margin-top: 2rem; color: #666; font-size: 0.75rem;">— The Invisible Panchos</p>
      <p style="margin-top: 1rem; color: #555; font-size: 0.65rem;"><a href="${unsubscribeUrl}" style="color: #555;">Unsubscribe from our mailing list</a></p>
    </div>
  `

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Panchos Bodega <downloads@theinvisiblepanchos.com>',
        to: [email],
        subject: 'Your Panchos Bodega order confirmation',
        html,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    })
  } catch (err) {
    console.error('Failed to send order confirmation email:', err)
  }
}

async function sendTipThankYouEmail(email: string, amountCents: number, name: string | null, customMessage?: string | null) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const unsubscribeUrl = await buildUnsubscribeUrl(email)

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; background: #111; padding: 2rem; border: 1px solid #333;">
      <h2 style="letter-spacing: 1px; color: #fff; margin: 0 0 0.25rem 0;">Thank You${name ? `, ${name}` : ''}</h2>
      <p style="color: #888; font-size: 0.8rem; margin: 0 0 1.5rem 0;">Your support keeps the Bodega lit.</p>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 0.5rem 0 0 0; color: #fff; font-size: 0.95rem; font-weight: bold; border-top: 1px solid #444;">Your Tip</td>
          <td style="padding: 0.5rem 0 0 0; color: #00ffcc; font-size: 0.95rem; font-weight: bold; text-align: right; border-top: 1px solid #444;">${money(amountCents)}</td>
        </tr>
      </table>
      <p style="margin: 1.5rem 0 0 0; color: #ccc; font-size: 0.8rem; line-height: 1.6;">
        No album to download and nothing shipping out on this one — just us, genuinely grateful.
        Every dollar goes straight back into making the next thing.
      </p>
      ${customMessageBlockHTML(customMessage)}
      <p style="margin-top: 2rem; color: #666; font-size: 0.75rem;">&mdash; The Invisible Panchos</p>
      <p style="margin-top: 1rem; color: #555; font-size: 0.65rem;"><a href="${unsubscribeUrl}" style="color: #555;">Unsubscribe from our mailing list</a></p>
    </div>
  `

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Panchos Bodega <downloads@theinvisiblepanchos.com>',
        to: [email],
        subject: 'Thanks for the tip',
        html,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
      })
    })
  } catch (err) {
    console.error('Failed to send tip thank-you email:', err)
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

  // checkout.session.completed fires the moment the customer finishes the
  // checkout flow, which for a card payment is also the moment it's paid —
  // but for delayed-notification payment methods (some bank debits, buy-
  // now-pay-later), the *session* can complete while payment_status is
  // still 'unpaid', with the actual result arriving later as
  // async_payment_succeeded/async_payment_failed. Fulfilling on
  // "completed" alone, without checking payment_status, would ship/deliver
  // before money has actually arrived if any such method is ever enabled.
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object as Stripe.Checkout.Session

    if (session.payment_status !== 'paid') {
      // Not paid yet — if this ever resolves, Stripe sends
      // async_payment_succeeded (handled above) or async_payment_failed
      // (nothing to do — no order was ever created for this session).
      return new Response(JSON.stringify({ received: true, notYetPaid: true }), { status: 200 })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Fetched once regardless of which branch below actually runs (tip vs.
    // purchase are mutually exclusive per event) — blank/missing is a
    // normal, expected state (no admin-set note), not an error.
    const { data: siteSettings } = await supabase
      .from('site_settings')
      .select('purchase_thank_you_message, tip_thank_you_message')
      .eq('id', true)
      .single()

    // Tips short-circuit everything below: there's no product row behind the
    // ad-hoc Stripe product, nothing to fulfill, ship, or decrement. Handled
    // before the line-item loop specifically so decrement_inventory never
    // runs against a tip's throwaway product id.
    if (session.metadata?.tip === 'true') {
      try {
        const amountCents = session.amount_total ?? 0
        const email = session.customer_details?.email || null
        const tipperName = session.metadata.tip_name || session.customer_details?.name || null

        // stripe_session_id is unique — a resent event just no-ops instead of
        // double-recording the tip or sending a second thank-you.
        const { error: insertError } = await supabase.from('tips').insert({
          stripe_session_id: session.id,
          amount_cents: amountCents,
          email,
          name: tipperName,
          message: session.metadata.tip_message || null,
        })

        if (insertError) {
          if (insertError.code === '23505') {
            return new Response(JSON.stringify({ received: true, duplicate: true }), { status: 200 })
          }
          throw insertError
        }

        if (email) {
          await sendTipThankYouEmail(email, amountCents, tipperName, siteSettings?.tip_thank_you_message)
          await addContactToAudience(email)
          // A tipper is its own segment, distinct from Buyers — someone who
          // gave money with no product, no download, and nothing shipped is
          // a strong fan signal on its own, not a lesser version of a
          // purchase. Deliberately not deduped against Buyers: someone who
          // both tips and buys ends up in both audiences.
          await addContactToAudience(email, 'RESEND_TIPPERS_AUDIENCE_ID')
        }
      } catch (err) {
        console.error('Failed to record tip for session', session.id, err)
      }

      return new Response(JSON.stringify({ received: true }), { status: 200 })
    }

    const lineRows: { title: string; quantity: number; amount: number }[] = []
    const downloadBlocks: { title: string; files: { name: string; url: string }[] }[] = []

    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ['data.price.product']
      })

      for (const item of lineItems.data) {
        // @ts-ignore - expanded product isn't fully typed
        const product = item.price?.product as { id: string; name?: string; metadata?: Record<string, string> } | undefined
        const quantity = item.quantity ?? 1

        if (product?.id) {
          await supabase.rpc('decrement_inventory', {
            p_stripe_product_id: product.id,
            p_quantity: quantity
          })
        }

        lineRows.push({ title: product?.name || 'Item', quantity, amount: item.amount_total ?? 0 })

        const downloadBlock = await buildDownloadBlockForProduct(supabase, product)
        if (downloadBlock) downloadBlocks.push(downloadBlock)
      }
    } catch (err) {
      // Log it, but still ack the event — retrying won't fix a data
      // mismatch, and Stripe will keep resending an unacknowledged event.
      console.error('Failed to process line items for session', session.id, err)
    }

    // Only the cart checkout (create-checkout-session) tags its sessions
    // with item_count — a static Payment Link purchase (music, art, the old
    // manual apparel link) has none, and doesn't get an order/label record.
    let isDuplicateDelivery = false
    if (session.metadata?.item_count) {
      try {
        // Stripe can resend the same event; stripe_session_id is unique, so
        // a duplicate delivery just no-ops instead of double-buying a label
        // or double-recording the order.
        const { data: existingOrder } = await supabase
          .from('orders')
          .select('id')
          .eq('stripe_session_id', session.id)
          .maybeSingle()

        if (existingOrder) {
          isDuplicateDelivery = true
        } else {
          const metadata = session.metadata
          const itemCount = parseInt(metadata.item_count, 10) || 0
          const cartItems = []
          for (let i = 0; i < itemCount; i++) {
            const raw = metadata[`item_${i}`]
            if (raw) cartItems.push(JSON.parse(raw))
          }

          const hasShipping = !!metadata.shipping_street1
          const totalWeightOz = hasShipping
            ? cartItems.reduce((sum: number, it: any) => sum + (it.weightOz || 0) * it.quantity, 0)
            : null

          const { data: order, error: orderError } = await supabase
            .from('orders')
            .insert({
              stripe_session_id: session.id,
              weight_oz: totalWeightOz,
              amount_total_cents: session.amount_total,
              customer_email: session.customer_details?.email || null,
              shipping_name: hasShipping ? metadata.shipping_name || null : null,
              shipping_street1: hasShipping ? metadata.shipping_street1 || null : null,
              shipping_street2: hasShipping ? metadata.shipping_street2 || null : null,
              shipping_city: hasShipping ? metadata.shipping_city || null : null,
              shipping_state: hasShipping ? metadata.shipping_state || null : null,
              shipping_zip: hasShipping ? metadata.shipping_zip || null : null,
              shipping_country: hasShipping ? metadata.shipping_country || null : null,
              shipping_service: hasShipping ? metadata.shipping_service || null : null,
              shipping_rate_id: hasShipping ? metadata.shipping_rate_id || null : null
            })
            .select()
            .single()

          if (orderError) throw orderError

          if (cartItems.length > 0) {
            const { error: itemsError } = await supabase.from('order_items').insert(
              cartItems.map((it: any) => ({
                order_id: order.id,
                product_id: it.id || null,
                product_title: it.title || 'Untitled',
                category: it.category || null,
                size: it.size || null,
                quantity: it.quantity || 1,
                unit_amount_cents: it.unitAmountCents ?? null,
                weight_oz: it.weightOz ?? null,
                printful_sync_variant_id: it.printfulSyncVariantId ?? null
              }))
            )
            if (itemsError) console.error('Failed to insert order items for session', session.id, itemsError)
          }

          // Self-fulfilled (Shippo) and Printful items ship as separate
          // parcels even within the same order, so each gets its own
          // fulfillment call — a self-fulfilled label purchase never blocks
          // on, or is blocked by, Printful order submission.
          const shippingRecipient = {
            name: metadata.shipping_name || '',
            street1: metadata.shipping_street1 || '',
            street2: metadata.shipping_street2 || '',
            city: metadata.shipping_city || '',
            state: metadata.shipping_state || '',
            zip: metadata.shipping_zip || '',
            country: metadata.shipping_country || ''
          }

          if (hasShipping && metadata.shipping_rate_id) {
            await purchaseLabelForOrder(
              supabase,
              order.id,
              metadata.shipping_rate_id,
              Deno.env.get('SHIPPO_API_KEY')
            )
          }

          const printfulItems = cartItems
            .filter((it: any) => it.printfulSyncVariantId != null)
            .map((it: any) => ({ sync_variant_id: it.printfulSyncVariantId, quantity: it.quantity || 1 }))

          if (printfulItems.length > 0) {
            await submitPrintfulOrder(
              supabase,
              order.id,
              shippingRecipient,
              printfulItems,
              Deno.env.get('PRINTFUL_API_KEY')
            )
          }
        }
      } catch (err) {
        console.error('Failed to create order / purchase label for session', session.id, err)
      }
    }

    if (!isDuplicateDelivery && session.customer_details?.email) {
      const metadata = session.metadata || {}
      const hasShipping = !!metadata.shipping_street1
      await addContactToAudience(session.customer_details.email)
      // Real purchase (not a tip) — also lands them in Buyers specifically,
      // so a future campaign can target people who've actually paid, not
      // the whole undifferentiated list.
      await addContactToAudience(session.customer_details.email, 'RESEND_BUYERS_AUDIENCE_ID')
      await sendOrderConfirmationEmail(session.customer_details.email, {
        lineRows,
        downloadBlocks,
        subtotalCents: session.amount_subtotal ?? null,
        taxCents: session.total_details?.amount_tax ?? null,
        shippingCents: session.total_details?.amount_shipping ?? null,
        totalCents: session.amount_total ?? null,
        shippingAddress: hasShipping ? {
          name: metadata.shipping_name || '',
          street1: metadata.shipping_street1 || '',
          street2: metadata.shipping_street2 || '',
          city: metadata.shipping_city || '',
          state: metadata.shipping_state || '',
          zip: metadata.shipping_zip || '',
          country: metadata.shipping_country || ''
        } : null,
        customMessage: siteSettings?.purchase_thank_you_message
      })
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
})
