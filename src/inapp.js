// Instagram / Facebook open links in their own built-in browser, which can
// block file downloads (especially on iPhone) and a few other things. When the
// page is opened inside one, show a one-time notice with how to get out to the
// real browser. iPhones don't allow a page to open Safari by itself, so the
// reliable parts are the written steps and a Copy link button; Android also
// gets a button that tries to open Chrome directly.
const DISMISS_KEY = 'inAppNoticeDismissed'
const UA = () => (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '')

export function isInAppBrowser() {
  return /Instagram|FBAN|FBAV|FB_IAB|FBIOS/i.test(UA())
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true, () => false)
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return Promise.resolve(ok)
  } catch {
    return Promise.resolve(false)
  }
}

function dismissed() {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

const CSS = `
.iab-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: flex-end; justify-content: center; padding: 0.8rem; background: rgba(0,0,0,0.78); font-family: 'Space Mono', ui-monospace, Menlo, Consolas, monospace; }
.iab-box { width: 100%; max-width: 420px; background: #1e1e1e; color: #ededed; border: 1px solid #2a2a2a; padding: 1.2rem 1.1rem 1rem; text-align: center; line-height: 1.5; font-size: 14px; }
.iab-title { margin: 0 0 0.6rem; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; font-weight: 800; text-transform: uppercase; font-size: 1.25rem; line-height: 1.05; }
.iab-text { margin: 0 0 0.7rem; }
.iab-steps { margin: 0 0 1rem; padding: 0.6rem 0.7rem; background: #121212; color: #00ffcc; font-size: 13px; }
.iab-btn { display: block; width: 100%; margin: 0 0 0.5rem; padding: 0.85rem 0.8rem; border: 0; background: #e55b3c; color: #121212; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; font-weight: 800; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; }
.iab-btn.alt { background: none; border: 1px solid #2a2a2a; color: #ededed; }
.iab-skip { background: none; border: 0; color: #8a8a8a; font-family: inherit; font-size: 12px; padding: 0.5rem; cursor: pointer; text-decoration: underline; }
`

export function initInAppBrowserNotice() {
  if (!isInAppBrowser() || dismissed() || document.getElementById('iab-notice')) return
  const android = /Android/i.test(UA())

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  const backdrop = el('div', 'iab-backdrop')
  backdrop.id = 'iab-notice'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', 'Open in your browser')
  const box = el('div', 'iab-box')
  box.append(
    el('h2', 'iab-title', 'Open this in your browser'),
    el('p', 'iab-text', (/Instagram/i.test(UA()) ? 'Instagram' : 'Facebook') + '’s built-in browser can block downloads and some features. It works best in your regular browser.'),
    el('p', 'iab-steps', 'Tap the ••• menu, then choose “Open in browser” (or “Open in ' + (android ? 'Chrome' : 'Safari') + '”).'),
  )

  if (android) {
    const open = el('button', 'iab-btn', 'Open in browser')
    open.type = 'button'
    open.addEventListener('click', () => {
      window.location.href = 'intent://' + location.host + location.pathname + location.search + '#Intent;scheme=https;package=com.android.chrome;end'
    })
    box.append(open)
  }

  const copy = el('button', 'iab-btn' + (android ? ' alt' : ''), 'Copy link')
  copy.type = 'button'
  copy.addEventListener('click', async () => {
    const ok = await copyText(location.href)
    copy.textContent = ok ? 'Link copied — paste it in your browser' : 'Press and hold the address to copy it'
  })
  const skip = el('button', 'iab-skip', 'Keep going here')
  skip.type = 'button'
  skip.addEventListener('click', () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* private mode: it just shows again next visit */ }
    backdrop.remove()
    style.remove()
  })
  box.append(copy, skip)
  backdrop.append(box)
  document.body.appendChild(backdrop)
}
