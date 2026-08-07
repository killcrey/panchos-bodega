import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1'
import Stripe from 'https://esm.sh/stripe@11.1.0?target=deno'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SITE_URL = 'https://bodega.theinvisiblepanchos.com'

// Every country Stripe supports for shipping_address_collection. Used when
// international shipping is enabled so buyers anywhere can enter an address.
const ALL_SHIPPING_COUNTRIES = [
  'AC', 'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO',
  'CR', 'CV', 'CW', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE', 'EG', 'EH', 'ER',
  'ES', 'ET', 'FI', 'FJ', 'FK', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL',
  'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HN', 'HR', 'HT', 'HU', 'ID',
  'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IS', 'IT', 'JE', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI',
  'KM', 'KN', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV',
  'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MK', 'ML', 'MM', 'MN', 'MO', 'MQ', 'MR', 'MS', 'MT',
  'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NC', 'NE', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU',
  'NZ', 'OM', 'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PY', 'QA',
  'RE', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL',
  'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SZ', 'TA', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ',
  'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA',
  'VC', 'VE', 'VG', 'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW', 'ZZ'
]

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Only a logged-in admin may generate a checkout link, not just anyone
    //    holding the public anon key.
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace('Bearer ', '')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      throw new Error('You must be logged in as an admin to generate a checkout link.')
    }

    // 2. Read the product details supplied by the admin form. `filePaths` are the
    //    object's key(s) in the audio-vault bucket (not the full public URL) — when
    //    present, the buyer gets a real download after checkout. A multi-track
    //    album is several individual track keys (never bundled into one big zip
    //    at upload time, so each stays well under Storage's per-file size cap);
    //    the zip a buyer actually receives is assembled on demand at download
    //    time by secure-download, from these same individual files. `category`,
    //    `sizes`, and the two shipping cost fields drive apparel-specific
    //    checkout behavior (shipping rates + a size picker) further down.
    const { title, priceCents, filePaths, category, sizes, domesticShippingCents, internationalShippingCents } = await req.json()
    if (!title || !priceCents || priceCents <= 0) {
      throw new Error('A product title and a positive price are required.')
    }

    const hasFiles = Array.isArray(filePaths) && filePaths.length > 0
    // Stripe metadata values are capped at 500 chars each, which a long file
    // path list could exceed — so each file gets its own numbered key instead
    // of packing them into one JSON string.
    const fileMetadata: Record<string, string> = {}
    if (hasFiles) {
      fileMetadata.file_count = String(filePaths.length)
      filePaths.forEach((path: string, i: number) => { fileMetadata[`file_${i}`] = path })
    }

    const isApparel = category === 'apparel'
    const sizeOptions = isApparel && typeof sizes === 'string'
      ? sizes.split(',').map((s: string) => s.trim()).filter(Boolean)
      : []
    const hasDomesticShipping = isApparel && typeof domesticShippingCents === 'number' && domesticShippingCents >= 0
    const hasInternationalShipping = isApparel && typeof internationalShippingCents === 'number' && internationalShippingCents >= 0

    // 3. Create the Stripe Product, Price, and a reusable Payment Link
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2022-11-15',
      httpClient: Stripe.createFetchHttpClient(),
    })

    const product = await stripe.products.create({
      name: title,
      ...(hasFiles ? { metadata: fileMetadata } : {})
    })

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(priceCents),
      currency: 'usd',
    })

    // Payment Links only accept a shipping_rate ID (not inline rate data like
    // Checkout Sessions do), so create each rate the admin priced in first.
    const shippingOptions: { shipping_rate: string }[] = []
    let allowedCountries = ['US']

    if (hasDomesticShipping) {
      const domesticRate = await stripe.shippingRates.create({
        display_name: 'Domestic Shipping (US)',
        type: 'fixed_amount',
        fixed_amount: { amount: Math.round(domesticShippingCents), currency: 'usd' }
      })
      shippingOptions.push({ shipping_rate: domesticRate.id })
    }

    if (hasInternationalShipping) {
      const internationalRate = await stripe.shippingRates.create({
        display_name: 'International Shipping',
        type: 'fixed_amount',
        fixed_amount: { amount: Math.round(internationalShippingCents), currency: 'usd' }
      })
      shippingOptions.push({ shipping_rate: internationalRate.id })
      allowedCountries = ALL_SHIPPING_COUNTRIES
    }

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      // Only digital products need to land on the download page after checkout.
      ...(hasFiles ? {
        after_completion: {
          type: 'redirect',
          redirect: { url: `${SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}` }
        }
      } : {}),
      // Apparel is physical: collect a shipping address (worldwide if
      // international shipping is priced, US-only otherwise), and if the
      // admin priced shipping, let the buyer pick the matching option.
      ...(isApparel ? { shipping_address_collection: { allowed_countries: allowedCountries } } : {}),
      ...(shippingOptions.length > 0 ? { shipping_options: shippingOptions } : {}),
      ...(sizeOptions.length > 0 ? {
        custom_fields: [{
          key: 'size',
          label: { type: 'custom', custom: 'Size' },
          type: 'dropdown',
          dropdown: {
            options: sizeOptions.map((size: string, i: number) => ({
              label: size.slice(0, 100),
              value: `size${i}${size.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 100)
            }))
          }
        }]
      } : {})
    })

    return new Response(
      JSON.stringify({ url: paymentLink.url, productId: product.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
