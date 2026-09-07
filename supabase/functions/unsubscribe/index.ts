import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// Resend has no managed unsubscribe endpoint or built-in suppression for
// transactional /emails sends (only Broadcasts read the `unsubscribed` flag)
// — confirmed against their own docs, which say to build and host this
// yourself. This is that endpoint. It's the single unsubscribe target for
// every audience-adding email (order confirmation, tip thank-you, download
// emails): one link, one token, unsubscribes the email from all three real
// Audiences at once, since none of them are meant to double as a "still
// wanted here" signal once someone's asked out.
const AUDIENCE_ENV_VARS = ['RESEND_AUDIENCE_ID', 'RESEND_BUYERS_AUDIENCE_ID', 'RESEND_TIPPERS_AUDIENCE_ID']

async function hmac(email: string): Promise<string> {
  const secret = Deno.env.get('UNSUBSCRIBE_SECRET') ?? ''
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(email.toLowerCase()))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function verifyToken(email: string, token: string): Promise<boolean> {
  if (!email || !token) return false
  const expected = await hmac(email)
  return expected === token
}

async function unsubscribeFromAllAudiences(email: string) {
  const resendKey = Deno.env.get('RESEND_CONTACTS_API_KEY')
  if (!resendKey) return

  await Promise.allSettled(AUDIENCE_ENV_VARS.map(async (envVar) => {
    const audienceId = Deno.env.get(envVar)
    if (!audienceId) return
    // A 404 here just means this email was never in this particular
    // audience — expected and fine, not every contact is in all three.
    await fetch(`https://api.resend.com/audiences/${audienceId}/contacts/${encodeURIComponent(email)}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ unsubscribed: true }),
    })
  }))
}

function page(title: string, message: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font-family:Helvetica,Arial,sans-serif;background:#111;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:2rem;box-sizing:border-box}
.box{max-width:420px}
h1{letter-spacing:1px;font-size:1.3rem;margin:0 0 0.75rem 0}
p{color:#ccc;line-height:1.6;font-size:0.9rem}
</style>
</head><body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html' }, status: 200 }
  )
}

serve(async (req) => {
  const url = new URL(req.url)
  const email = url.searchParams.get('email') || ''
  const token = url.searchParams.get('token') || ''

  const valid = await verifyToken(email, token)

  if (!valid) {
    // RFC 8058 one-click clients POST here and never render a body.
    if (req.method === 'POST') {
      return new Response(null, { status: 400 })
    }
    return page(
      "Link expired or invalid",
      "This unsubscribe link isn't valid. If you'd like to stop receiving emails from us, just reply to any email and let us know."
    )
  }

  await unsubscribeFromAllAudiences(email)

  if (req.method === 'POST') {
    return new Response(null, { status: 200 })
  }

  return page(
    "You're unsubscribed",
    `${email} won't be included in any future email from The Invisible Panchos. Note this only covers our mailing list — a receipt or download link for something you've already bought or claimed isn't affected.`
  )
})
