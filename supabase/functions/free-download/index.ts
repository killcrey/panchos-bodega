import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function extractStoragePath(url: string, bucket: string): string | null {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(url.slice(idx + marker.length))
}

async function sendDownloadEmail(email: string, title: string, downloadUrl: string) {
  const resendKey = Deno.env.get('RESEND_API_KEY')
  if (!resendKey) return

  const html = `
    <div style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="letter-spacing: 1px;">Thanks for grabbing "${title}"!</h2>
      <p>Here's your download link — it's good for the next 60 minutes:</p>
      <p style="margin: 1.5rem 0;">
        <a href="${downloadUrl}" style="display: inline-block; padding: 0.9rem 1.5rem; background: #000; color: #fff; text-decoration: none; font-weight: bold; text-transform: uppercase; letter-spacing: 1px;">Download Now</a>
      </p>
      <p><strong>Windows / Android:</strong> Right-click (or tap and hold) the button above and choose "Save Link As" / "Download Link."</p>
      <p><strong>Mac (Safari):</strong> Right-click the button and choose "Download Linked File."</p>
      <p><strong>iPhone / iPad (Safari):</strong> Tap and hold the button, then choose "Download Linked File" — it saves to your Files app.</p>
      <p><strong>Multiple files?</strong> This downloads as a single .ZIP file — unzip it to get everything inside.</p>
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
        subject: `Your download: ${title}`,
        html
      })
    })
  } catch (err) {
    // A failed email should never block the buyer from getting their file.
    console.error('Failed to send download email:', err)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { productId, email } = await req.json()

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.")
    }

    if (!productId) {
      throw new Error("Missing product.")
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product, error: productError } = await supabase
      .from('products')
      .select('title, price_cents, audio_preview_url, published')
      .eq('id', productId)
      .single()

    if (productError || !product) {
      throw new Error("Product not found.")
    }

    // Server-side gate: only genuinely free, published products can be
    // fetched through this endpoint — otherwise anyone could grab a paid
    // product for free just by knowing its id.
    if (!product.published) {
      throw new Error("This product is not available.")
    }
    if ((product.price_cents ?? 0) !== 0) {
      throw new Error("This product is not free.")
    }

    const targetFilename = extractStoragePath(product.audio_preview_url, 'audio-vault')
    if (!targetFilename) {
      throw new Error("No digital file attached to this product.")
    }

    await supabase.from('email_captures').insert({ product_id: productId, email })

    const downloadFilename = targetFilename.replace(/^\d+-/, '')

    const { data, error } = await supabase
      .storage
      .from('audio-vault')
      .createSignedUrl(targetFilename, 3600, { download: downloadFilename })

    if (error) throw error

    await sendDownloadEmail(email, product.title || 'your download', data.signedUrl)

    return new Response(
      JSON.stringify({ downloadUrl: data.signedUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
