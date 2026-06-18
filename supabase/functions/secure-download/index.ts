import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'
import Stripe from 'https://esm.sh/stripe@11.1.0?target=deno'

// These headers allow your website to talk to the cloud without getting blocked
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle the preliminary security check from the browser
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Unpack the request from your success.js file
    const { sessionId } = await req.json()

    if (!sessionId) {
      throw new Error('No session ID provided')
    }

    // 2. Initialize Stripe to check the receipt
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // 3. Check the receipt AND ask Stripe for the specific product data
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price.product']
    })

    // 4. Verify the receipt is actually paid
    if (session.payment_status !== 'paid') {
      throw new Error('Payment not completed')
    }

    // 5. Read the secret 'file' tag you put in the Stripe Product Metadata
    // @ts-ignore - bypassing strict type checking for the expanded product
    const product = session.line_items.data[0].price.product
    const targetFilename = product.metadata?.file

    // 6. Safety Check: If there is no file tagged in Stripe, reject it
    if (!targetFilename) {
      throw new Error('No digital file attached to this product in Stripe Metadata.')
    }

    // 7. Initialize the Vault (Supabase)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 8. Have the Bouncer fetch the EXACT file from your audio-vault
    const { data, error } = await supabase
      .storage
      .from('audio-vault')
      .createSignedUrl(targetFilename, 3600) // Link expires in 1 hour

    if (error) {
      throw error
    }

    // 9. Hand the secure download link back to the fan's browser
    return new Response(
      JSON.stringify({ downloadUrl: data.signedUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    // If anything fails (bad ID, missing file, etc.), kick them out
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})