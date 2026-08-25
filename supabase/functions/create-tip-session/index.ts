import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import Stripe from "https://esm.sh/stripe@11.1.0?target=deno"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SITE_URL = 'https://bodega.theinvisiblepanchos.com'

// A tip is the one amount on this site the customer chooses, so unlike a
// product price (always re-read from the DB) it can't be validated against
// anything. Hard bounds are the whole defense: they keep a tampered request
// from creating a $0.01 or $50,000 charge in our Stripe account.
const MIN_TIP_CENTS = 100      // $1
const MAX_TIP_CENTS = 50000    // $500
const MAX_MESSAGE_LENGTH = 280

// Tips aren't a sale of goods — no tangible property and nothing delivered —
// so Stripe Tax must not treat this like merchandise and add sales tax to a
// gratuity. Stripe's general non-taxable code.
const NONTAXABLE_TAX_CODE = 'txcd_00000000'

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { amountCents, name, message } = await req.json()

    const amount = Math.round(Number(amountCents))
    if (!Number.isFinite(amount)) {
      throw new Error('Enter a tip amount.')
    }
    if (amount < MIN_TIP_CENTS) {
      throw new Error(`The smallest tip is $${(MIN_TIP_CENTS / 100).toFixed(2)}.`)
    }
    if (amount > MAX_TIP_CENTS) {
      throw new Error(`The largest tip is $${(MAX_TIP_CENTS / 100).toFixed(0)}. Get at us directly for anything bigger.`)
    }

    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // Metadata values are capped at 500 chars by Stripe, and this text is
    // shown back to us in the admin panel — trim it at the door.
    const tipperName = typeof name === 'string' ? name.trim().slice(0, 100) : ''
    const tipMessage = typeof message === 'string' ? message.trim().slice(0, MAX_MESSAGE_LENGTH) : ''

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: 'Tip for The Invisible Panchos',
            description: 'Thanks for supporting independent music.',
            tax_code: NONTAXABLE_TAX_CODE,
          },
        },
        quantity: 1,
      }],
      // Deliberately off: see NONTAXABLE_TAX_CODE above.
      automatic_tax: { enabled: false },
      // `tip` is what the webhook branches on to skip every fulfillment
      // step (inventory, downloads, shipping labels, Printful).
      metadata: {
        tip: 'true',
        tip_name: tipperName,
        tip_message: tipMessage,
      },
      success_url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&tip=1`,
      cancel_url: `${SITE_URL}/`,
    })

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
