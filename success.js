const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

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
    const response = await fetch(`${supabaseUrl}/functions/v1/secure-download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseAnonKey,
        'Authorization': `Bearer ${supabaseAnonKey}`
      },
      body: JSON.stringify({ session_id: sessionId })
    })

    const result = await response.json()
    if (!response.ok) {
      throw new Error(result?.error || 'The bouncer rejected this receipt. It may be expired or invalid.')
    }

    // Payment is verified — the cart that led here is spent.
    localStorage.removeItem('bodegaCart')

    // 3. The bouncer approved it. Print a download block per product in the order.
    const downloadsHTML = result.downloads.map(block => `
      <p style="font-size: 0.8rem; color: #ccc; margin: 1rem 0 0.5rem 0; text-align: left;">${block.title}</p>
      ${block.files.map(f => `<a href="${f.url}" class="btn" style="margin-bottom: 0.5rem;" download="${f.name}">Download ${f.name}</a>`).join('')}
    `).join('')

    statusArea.innerHTML = `
      <h2 style="color: #00ffcc;">VERIFIED</h2>
      <p>Your order is confirmed — a receipt with these links has also been emailed to you. Links below are good for the next 60 minutes.</p>
      ${downloadsHTML}
      ${result.skippedCount > 0 ? `<p style="font-size: 0.75rem; color: #888; margin-top: 1rem;">${result.skippedCount} item${result.skippedCount === 1 ? '' : 's'} in this order ${result.skippedCount === 1 ? "doesn't" : "don't"} have a digital file — check your email receipt for details.</p>` : ''}
      <div class="download-instructions">
        <p><strong>Windows / Android:</strong> Right-click (or tap and hold) a button above and choose "Save Link As" / "Download Link" to save the file.</p>
        <p><strong>Mac (Safari):</strong> Right-click a button and choose "Download Linked File."</p>
        <p><strong>iPhone / iPad (Safari):</strong> Tap and hold a button, then choose "Download Linked File" — it saves to your Files app. If it opens a preview instead, use the Share icon and choose "Save to Files."</p>
      </div>
    `
  } catch (err) {
    // 4. Figure out what actually went wrong instead of always blaming the receipt
    console.error(err)
    const message = err.message || 'The bouncer rejected this receipt. It may be expired or invalid.'

    if (message.toLowerCase().includes('no digital file')) {
      // This error only fires after payment_status === 'paid' was confirmed
      // server-side, so the purchase went through — the cart that led here is spent.
      localStorage.removeItem('bodegaCart')
      statusArea.innerHTML = `
        <h2 style="color: #e8b923;">PAYMENT CONFIRMED</h2>
        <p>Thanks for your purchase! A receipt has been emailed to you. This order doesn't have a digital download attached — apparel ships separately, and we'll follow up with tracking once it's on its way.</p>
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
