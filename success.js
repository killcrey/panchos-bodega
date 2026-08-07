const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Calls a download-delivering Edge Function directly (bypassing
// supabase.functions.invoke, which assumes a JSON response) so a multi-track
// album's zip — assembled server-side and streamed back as raw bytes — can
// be received as a Blob instead. Single-file products still get back plain
// JSON with a direct signed URL, unchanged.
async function invokeDownloadFunction(functionName, body) {
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseAnonKey,
      'Authorization': `Bearer ${supabaseAnonKey}`
    },
    body: JSON.stringify(body)
  })

  const contentType = response.headers.get('content-type') || ''

  if (!response.ok) {
    let message = 'The bouncer rejected this receipt. It may be expired or invalid.'
    try {
      const errBody = await response.json()
      if (errBody && errBody.error) message = errBody.error
    } catch (_parseErr) {
      // Keep the generic fallback message above.
    }
    throw new Error(message)
  }

  if (contentType.includes('application/json')) {
    const data = await response.json()
    return { kind: 'link', url: data.downloadUrl || data.secureUrl }
  }

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  return { kind: 'blob', url: URL.createObjectURL(blob), filename: match ? match[1] : 'download.zip' }
}

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
    const result = await invokeDownloadFunction('secure-download', { session_id: sessionId })

    // 3. The bouncer approved it. Print the secure download button.
    statusArea.innerHTML = `
      <h2 style="color: #00ffcc;">VERIFIED</h2>
      <p>${result.kind === 'link' ? 'Your secure link is ready. It will self-destruct in 60 minutes.' : 'Your download is ready.'}</p>
      <a href="${result.url}" class="btn" download${result.kind === 'blob' ? `="${result.filename}"` : ''}>Right-Click &amp; Download</a>
      <div class="download-instructions">
        <p><strong>Windows / Android:</strong> Right-click (or tap and hold) the button above and choose "Save Link As" / "Download Link" to save the file.</p>
        <p><strong>Mac (Safari):</strong> Right-click the button and choose "Download Linked File."</p>
        <p><strong>iPhone / iPad (Safari):</strong> Tap and hold the button, then choose "Download Linked File" — it saves to your Files app. If it opens a preview instead, use the Share icon and choose "Save to Files."</p>
        <p><strong>Buying an album or bundle?</strong> Multi-track purchases download as a single .ZIP file. Unzip it after downloading to get the individual tracks.</p>
      </div>
    `
  } catch (err) {
    // 4. Figure out what actually went wrong instead of always blaming the receipt
    console.error(err)
    const message = err.message || 'The bouncer rejected this receipt. It may be expired or invalid.'

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