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
    // 4. The bouncer rejected the receipt
    console.error(err)
    statusArea.innerHTML = `
      <h2 class="error-text">VERIFICATION FAILED</h2>
      <p>The bouncer rejected this receipt. It may be expired or invalid.</p>
    `
  }
}

secureTheBag()