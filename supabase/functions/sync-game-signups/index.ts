import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Mirrors the same helper in free-download/index.ts — kept duplicated
// rather than shared, matching how this codebase already duplicates small
// per-function constants (e.g. ADDRESS_FROM in get-shipping-rates /
// purchase-shipping-label) instead of a cross-function import.
async function addContactToAudience(email: string) {
  const resendKey = Deno.env.get('RESEND_CONTACTS_API_KEY')
  const audienceId = Deno.env.get('RESEND_AUDIENCE_ID')
  if (!resendKey || !audienceId) return

  const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, unsubscribed: false }),
  })
  if (!res.ok) {
    console.error(`Failed to add ${email} to Resend audience:`, await res.text())
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const gameUrl = Deno.env.get('GAME_SUPABASE_URL')
    const gameServiceKey = Deno.env.get('GAME_SUPABASE_SERVICE_ROLE_KEY')
    if (!gameUrl || !gameServiceKey) {
      throw new Error('GAME_SUPABASE_URL / GAME_SUPABASE_SERVICE_ROLE_KEY not configured yet.')
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { data: state, error: stateError } = await supabase
      .from('game_signup_sync_state')
      .select('last_synced_at')
      .eq('id', true)
      .single()
    if (stateError) throw stateError

    // The Game's project is entirely separate from Bodega's (different
    // Supabase project, no relation) — reached over its own REST API with
    // its own service role key, never through the local `supabase` client
    // above, which only ever talks to Bodega's own database.
    const gameRes = await fetch(
      `${gameUrl}/rest/v1/email_signups?select=email,created_at&created_at=gt.${encodeURIComponent(state.last_synced_at)}&order=created_at.asc&limit=500`,
      { headers: { apikey: gameServiceKey, Authorization: `Bearer ${gameServiceKey}` } }
    )
    if (!gameRes.ok) throw new Error(`Failed to read Game signups: ${await gameRes.text()}`)
    const rows: { email: string; created_at: string }[] = await gameRes.json()

    let synced = 0
    let latest = state.last_synced_at
    for (const row of rows) {
      if (!row.email) continue
      try {
        await addContactToAudience(row.email)
        synced++
      } catch (err) {
        // One bad contact shouldn't stall every signup after it — log and
        // keep going; the watermark still advances past it below so a
        // permanently-failing row (malformed email, etc.) doesn't get
        // retried forever.
        console.error(`Failed to sync ${row.email}:`, err)
      }
      if (row.created_at > latest) latest = row.created_at
    }

    if (latest !== state.last_synced_at) {
      const { error: updateError } = await supabase
        .from('game_signup_sync_state')
        .update({ last_synced_at: latest })
        .eq('id', true)
      if (updateError) throw updateError
    }

    return new Response(
      JSON.stringify({ checked: rows.length, synced, watermark: latest }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
