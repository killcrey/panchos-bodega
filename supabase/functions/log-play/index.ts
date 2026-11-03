import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SOURCES = ['site', 'shared', 'vip']
// One listener can't legitimately log the same song twice inside 30 s of
// listening, and nobody racks up this many plays in an hour. Both limits just
// blunt a script hammering this public endpoint; they never affect a real fan.
const SAME_TRACK_GAP_MS = 25_000
const MAX_PLAYS_PER_HOUR = 120

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v : '').slice(0, max)
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status })

// Public on purpose (the player has to be able to call it), so everything is
// validated here: the product must be a real published one, the listener id must
// look like the random id the browser makes, and repeats are rate limited.
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405)

  try {
    const body = await req.json()
    const productSlug = clip(body.productSlug, 120)
    const trackSlug = clip(body.trackSlug, 120)
    const trackName = clip(body.trackName, 160)
    const source = SOURCES.includes(body.source) ? body.source : 'site'
    const listenerId = clip(body.listenerId, 64)

    if (!productSlug || !/^[A-Za-z0-9_-]{8,64}$/.test(listenerId)) return json({ ok: false }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: product } = await supabase
      .from('products')
      .select('title')
      .eq('slug', productSlug)
      .eq('published', true)
      .maybeSingle()
    if (!product) return json({ ok: false }, 404)

    const now = Date.now()
    const { data: recent } = await supabase
      .from('track_plays')
      .select('track_slug, played_at')
      .eq('listener_id', listenerId)
      .gte('played_at', new Date(now - 60 * 60 * 1000).toISOString())
    const rows = recent ?? []
    if (rows.length >= MAX_PLAYS_PER_HOUR) return json({ ok: true, counted: false })
    const tooSoon = rows.some(r => r.track_slug === trackSlug && now - new Date(r.played_at).getTime() < SAME_TRACK_GAP_MS)
    if (tooSoon) return json({ ok: true, counted: false })

    const { error } = await supabase.from('track_plays').insert({
      product_slug: productSlug,
      track_slug: trackSlug,
      track_name: trackName,
      album: product.title ?? '',
      source,
      listener_id: listenerId,
    })
    if (error) throw error
    return json({ ok: true, counted: true })
  } catch (error) {
    console.error('log-play failed:', error)
    return json({ ok: false }, 500)
  }
})
