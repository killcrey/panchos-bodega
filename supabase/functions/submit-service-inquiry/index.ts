import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function notifyAdmin(data: { productTitle: string | null; name: string; email: string; eventDate: string | null; budget: string | null; message: string | null }) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="letter-spacing: 1px;">New Service Inquiry</h2>
      <p><strong>Service:</strong> ${data.productTitle || 'Not specified'}</p>
      <p><strong>From:</strong> ${data.name} &lt;${data.email}&gt;</p>
      ${data.eventDate ? `<p><strong>Date:</strong> ${data.eventDate}</p>` : ''}
      ${data.budget ? `<p><strong>Budget:</strong> ${data.budget}</p>` : ''}
      ${data.message ? `<p><strong>Message:</strong><br>${data.message.replace(/\n/g, '<br>')}</p>` : ''}
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
        to: ['info@theinvisiblepanchos.com'],
        reply_to: data.email,
        subject: `Service inquiry: ${data.productTitle || 'General'}`,
        html
      })
    })
  } catch (err) {
    console.error('Failed to send service inquiry notification:', err)
  }
}

async function sendConfirmation(email: string, name: string, productTitle: string | null) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="letter-spacing: 1px;">Thanks${name ? `, ${name}` : ''}!</h2>
      <p>We got your request${productTitle ? ` for "${productTitle}"` : ''} and will follow up by email soon.</p>
      <p style="margin-top: 2rem; color: #666; font-size: 0.85rem;">— The Invisible Panchos</p>
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
        subject: 'We got your request',
        html
      })
    })
  } catch (err) {
    console.error('Failed to send inquiry confirmation email:', err)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, name, email, eventDate, budget, message } = await req.json()

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error("Please enter your name.")
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Snapshotted so the inquiry stays readable if the listing changes later.
    // A missing/invalid productId just means a general inquiry — not an error.
    let productTitle: string | null = null
    if (productId) {
      const { data: product } = await supabase.from('products').select('title').eq('id', productId).single()
      productTitle = product?.title ?? null
    }

    const { error: insertError } = await supabase.from('service_inquiries').insert({
      product_id: productId || null,
      product_title: productTitle,
      name: name.trim(),
      email,
      event_date: eventDate || null,
      budget: budget || null,
      message: message || null,
    })

    if (insertError) throw insertError

    await notifyAdmin({ productTitle, name: name.trim(), email, eventDate: eventDate || null, budget: budget || null, message: message || null })
    await sendConfirmation(email, name.trim(), productTitle)

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
