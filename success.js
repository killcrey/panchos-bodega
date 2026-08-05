import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function secureTheBag() {
  const statusArea = document.getElementById('status-area')
  
  // 1. Look at the web address to find the secret Stripe receipt ID
  const urlParams = new URLSearchParams(window.location.search)
  const sessionId = urlParams.get('session_id')

  if (!sessionId) {
    statusArea.innerHTML = `
      <h2 class="error-text">ACCESS DENIED</h2>
      <p>No receipt found. If you just purchased this, please contact support.</p>
    `
    return
  }

  try {
    // 2. Hand the receipt to our digital bouncer in the cloud
    const { data, error } = await supabase.functions.invoke('secure-download', {
      body: { session_id: sessionId }
    })

    if (error) throw error

    // 3. The bouncer approved it. Print the secure download button.
    statusArea.innerHTML = `
      <h2 style="color: #00ffcc;">VERIFIED</h2>
      <p>Your secure link is ready. It will self-destruct in 60 minutes.</p>
      <a href="${data.secureUrl}" class="btn" download>Download Audio Vault</a>
    `
  } catch (err) {
    // 4. Figure out what actually went wrong instead of always blaming the receipt
    console.error(err)
    let message = 'The bouncer rejected this receipt. It may be expired or invalid.'
    try {
      const body = await err.context.json()
      if (body?.error) message = body.error
    } catch (_parseErr) {
      // Keep the generic fallback message above.
    }

    if (message.toLowerCase().includes('no digital file')) {
      statusArea.innerHTML = `
        <h2 style="color: #e8b923;">PAYMENT CONFIRMED</h2>
        <p>Thanks for your purchase! This item doesn't have a digital download attached. Check your email receipt, or contact support if you were expecting a file.</p>
      `
    } else {
      statusArea.innerHTML = `
        <h2 class="error-text">VERIFICATION FAILED</h2>
        <p>${message}</p>
      `
    }
  }
}

secureTheBag()