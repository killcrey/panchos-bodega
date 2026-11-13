import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mirrors the extractStoragePath helper already duplicated across
// free-download/secure-download/stripe-webhook.
function extractStoragePath(url: string, bucket: string): string | null {
  if (!url) return null
  const marker = `/storage/v1/object/public/${bucket}/`
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  return decodeURIComponent(url.slice(idx + marker.length))
}

// Deliberately public/ungated — this is what makes "Play Preview" and
// clicking any individual track in an album's tracklist work at all, and
// that has always meant playing the complete track, not a trimmed clip;
// this function changes *how* that file is delivered (a short-lived signed
// link instead of a permanently public URL), not *what's* reachable. The
// actual fix this exists for: audio-vault going private closes the real
// problem, which was every digital file's full-quality download URL
// sitting in cleartext in the public products API response — readable,
// keepable, and requiring no purchase at all, not just streamable.
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      throw new Error('Missing url.')
    }

    const path = extractStoragePath(url, 'audio-vault')
    if (!path) {
      throw new Error('Not a recognized audio-vault URL.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Only sign what is meant to be streamed: a product's preview track(s)
    // (tracklist_snippets / audio_preview_url) or an image. Paid downloads
    // (zips, bundles) are never signed here — secure-download owns those.
    if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(path)) {
      const { data: rows, error: qErr } = await supabase
        .from('products')
        .select('tracklist_snippets, audio_preview_url')
      if (qErr) throw qErr
      const allowed = new Set<string>()
      for (const r of rows ?? []) {
        const urls = [r.audio_preview_url, ...(Array.isArray(r.tracklist_snippets) ? r.tracklist_snippets.map((t: { url?: string }) => t?.url) : [])]
        for (const u of urls) {
          const pth = typeof u === 'string' ? extractStoragePath(u, 'audio-vault') : null
          if (pth) allowed.add(pth)
        }
      }
      if (!allowed.has(path)) throw new Error('Not a preview track.')
    }

    const { data, error } = await supabase
      .storage
      .from('audio-vault')
      .createSignedUrl(path, 60 * 60)

    if (error) throw error

    return new Response(
      JSON.stringify({ url: data.signedUrl }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
