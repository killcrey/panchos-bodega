// Phase 2: drives the real site in Microsoft Edge (already installed on
// Windows — no browser download) through playwright-core. Never completes a
// payment: every purchase flow stops once it lands on Stripe's hosted page.
import { chromium } from 'playwright-core'
import { check, pass, fail, warn, skip, section } from './lib.mjs'

const STRIPE_HOST = /checkout\.stripe\.com/

export async function runBrowserAudit({ site, env, ctx }) {
  const products = ctx.products || []
  if (!products.length) { skip('browser', 'browser audit', 'no product list from API phase'); return }
  const isService = ctx.isService, isPhysical = ctx.isPhysical, isFree = ctx.isFree, mode = ctx.mode
  const inStock = p => !(p.inventory_count != null && p.inventory_count <= 0) && !p.coming_soon

  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true })
  } catch (err) {
    fail('browser', 'launch Edge', String(err).split('\n')[0])
    return
  }

  async function newPage(viewport, mobile = false) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' : undefined })
    const page = await context.newPage()
    page.issues = { console: [], page: [], http: [], requests: [], imgBytes: 0 }
    page.on('console', m => { if (m.type() === 'error') page.issues.console.push(m.text().slice(0, 200)) })
    page.on('pageerror', e => page.issues.page.push(String(e).slice(0, 200)))
    page.on('response', async r => {
      const u = r.url()
      const s = r.status()
      if (s >= 400 && /theinvisiblepanchos|supabase\.co|stripe\.com|googleapis/.test(u) && !/favicon|stripe\.com\/.*(telemetry|r\.stripe|m\.stripe)/.test(u)) page.issues.http.push(`${s} ${u.slice(0, 140)}`)
      if (/\/rest\/v1\/products/.test(u)) page.issues.requests.push(u)
      if (/bodega-images/.test(u) && s === 200) { const l = +r.headers()['content-length'] || 0; page.issues.imgBytes += l }
    })
    return page
  }
  const enter = async page => {
    const btn = page.locator('#enter-btn')
    if (await btn.isVisible().catch(() => false)) await btn.click()
  }
  const open = async (page, url) => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(1500); await enter(page); await page.waitForTimeout(800) }
  const guard = async (area, name, fn) => {
    try { await fn() } catch (err) { fail(area, name, String(err).split('\n')[0].slice(0, 220)) }
  }
  const noOverflow = async page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)

  // ------------------------------------------------------------ storefront
  section('Browser — storefront (desktop)')
  const page = await newPage({ width: 1280, height: 900 })
  await guard('browser', 'homepage loads', async () => {
    await open(page, site + '/')
    check('browser', 'homepage: Enter gate dismisses and the store shows', await page.locator('#store-grid, #landing-view').first().isVisible())
    check('browser', 'homepage: no horizontal overflow', await noOverflow(page))
    const sel = page.issues.requests.filter(u => /published=eq\.true/.test(u))
    check('security', 'storefront product query does not request every column (select=*) or stripe_url', sel.length > 0 && sel.every(u => !/select=(\*|%2A)(&|$)/.test(u) && !/stripe_url|stripe_product_id/.test(u)), sel[0] ? sel[0].slice(0, 140) : 'no products request seen')
    const mb = page.issues.imgBytes / 1048576
    check('perf', 'first landing view image weight', mb < 4, `${mb.toFixed(1)} MB of bodega-images fetched on first load`, 'WARN')
  })
  await guard('browser', 'look book strip', async () => {
    if (!ctx.lookbookCount) { skip('lookbook', 'scrolling strip on the Featured page', 'no look book photos uploaded yet'); return }
    await page.locator('.filter-btn[data-filter="home"]').first().click()
    await page.waitForTimeout(2500)
    const strip = page.locator('.landing-detail-photos-track')
    if (!(await strip.count())) { fail('lookbook', 'scrolling strip appears under the Featured description', `${ctx.lookbookCount} photos exist but no strip rendered (is any product Featured?)`); return }
    const t1 = await strip.evaluate(el => getComputedStyle(el).transform)
    await page.waitForTimeout(1500)
    const t2 = await strip.evaluate(el => getComputedStyle(el).transform)
    const loaded = await page.evaluate(() => [...document.querySelectorAll('.landing-detail-photos-track img')].filter(i => i.complete && i.naturalWidth > 0).length)
    check('lookbook', 'scrolling strip appears under the Featured description, loads, and scrolls', loaded > 0 && t1 !== t2, `${loaded} images loaded, moving=${t1 !== t2}`)
  })
  await guard('browser', 'category filters', async () => {
    const filters = await page.locator('.filter-btn[data-filter]').evaluateAll(els => els.filter(e => e.getBoundingClientRect().width > 0).map(e => e.getAttribute('data-filter')))
    for (const f of filters) {
      if (f === 'home') continue
      await page.locator(`.filter-btn[data-filter="${f}"]`).first().click()
      await page.waitForTimeout(500)
      const n = await page.locator('.product-card:visible').count()
      const expected = f === 'all' ? products.length : null
      if (f === 'all') check('browser', `filter "${f}" shows every published product`, n === expected, `${n} of ${expected} cards`)
      else check('browser', `filter "${f}" renders without an empty/blank page`, n > 0, `${n} cards`, 'WARN')
    }
    await page.locator('.filter-btn[data-filter="all"]').first().click()
    await page.waitForTimeout(600)
    const broken = await page.evaluate(() => [...document.querySelectorAll('.product-card img')].filter(i => i.complete && i.naturalWidth === 0).length)
    const imgs = await page.locator('.product-card img').count()
    check('browser', 'grid: card images render (none broken)', broken === 0, `${broken} broken of ${imgs}`)
  })
  await guard('browser', 'console errors', async () => {
    check('browser', 'homepage/grid: no console or page errors', page.issues.console.length === 0 && page.issues.page.length === 0, [...page.issues.console, ...page.issues.page].slice(0, 3).join(' | '))
    check('browser', 'homepage/grid: no failed network requests', page.issues.http.length === 0, page.issues.http.slice(0, 4).join(' | '))
  })

  // ----------------------------------------------------------- each product
  section('Browser — every product page')
  for (const p of products.filter(x => x.slug)) {
    await guard('product', p.slug, async () => {
      const pg = await newPage({ width: 1280, height: 900 })
      await open(pg, `${site}/products/${p.slug}/`)
      const visible = await pg.locator('#product-view').isVisible()
      const title = (await pg.locator('#product-view h3').first().textContent().catch(() => '')) || ''
      const imgOk = await pg.evaluate(() => { const i = document.querySelector('#product-view .gallery-current-img'); return !i || (i.complete && i.naturalWidth > 0) })
      const btn = pg.locator('#product-view .buy-btn, #product-view .service-message-btn').first()
      const btnText = ((await btn.textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim()
      const expectDisabled = !inStock(p) || (!isService(p) && ['apparel', 'printful', 'printful-apparel', 'printful-picks'].includes(p.category) && !isPhysical(p))
      const disabled = await btn.isDisabled().catch(() => false)
      check('product', `${p.slug}: page renders with correct title, photo, and a buy control`, visible && title.trim().toLowerCase() === p.title.trim().toLowerCase() && imgOk && btnText.length > 0, `visible=${visible} title="${title.trim().slice(0, 40)}" img=${imgOk} button="${btnText}"`)
      check('product', `${p.slug}: buy button enabled only when it can actually be bought`, disabled === expectDisabled, `button "${btnText}" disabled=${disabled}, expected disabled=${expectDisabled}`)
      check('product', `${p.slug}: no console errors / failed requests`, pg.issues.console.length === 0 && pg.issues.page.length === 0 && pg.issues.http.length === 0, [...pg.issues.console, ...pg.issues.page, ...pg.issues.http].slice(0, 3).join(' | '))
      check('product', `${p.slug}: no horizontal overflow`, await noOverflow(pg))
      await pg.reload({ waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(1500); await enter(pg); await pg.waitForTimeout(600)
      check('product', `${p.slug}: survives a refresh`, await pg.locator('#product-view').isVisible())
      await pg.context().close()
    })
  }

  // --------------------------------------------------------------- shipping
  async function physicalFlow(label, viewport, mobile, prod) {
    await guard('checkout', `${label}: physical checkout`, async () => {
      const pg = await newPage(viewport, mobile)
      await open(pg, `${site}/products/${prod.slug}/`)
      const sel = pg.locator('#product-view .card-size-select')
      if (await sel.count()) { const opts = await sel.locator('option:not([disabled])').evaluateAll(o => o.map(x => x.value)); await sel.selectOption(opts[0]) }
      await pg.locator('#product-view .buy-btn').click()
      await pg.waitForTimeout(600)
      await pg.locator('#cart-btn').click()
      check('checkout', `${label}: item reaches the cart`, await pg.locator('#cart-items-list .cart-item-row').count() >= 1)
      await pg.locator('#cart-checkout-btn').click()
      await pg.waitForSelector('#shipping-checkout-modal', { state: 'visible', timeout: 10000 })
      // THE bug from 2026-10-06: the Address Element's iframe stayed 2px tall.
      let h = 0
      for (let i = 0; i < 20 && h < 100; i++) {
        await pg.waitForTimeout(500)
        h = await pg.evaluate(() => { const f = document.querySelector('#address-element iframe[src*="elements-inner-address"]'); return f ? f.getBoundingClientRect().height : 0 })
      }
      if (!check('checkout', `${label}: shipping Address Element actually renders (not a blank box)`, h > 100, `iframe height ${Math.round(h)}px`)) {
        await pg.context().close(); return
      }
      const frame = pg.frameLocator('#address-element iframe[src*="elements-inner-address"]')
      await frame.locator('input[name="name"]').fill(ctx.testAddress.name)
      await frame.locator('input[name="addressLine1"]').pressSequentially(ctx.testAddress.street1, { delay: 60 })
      await pg.waitForTimeout(2500)
      const sug = await pg.evaluate(() => [...document.querySelectorAll('iframe')].some(f => /autocomplete-suggestions/.test(f.src) && f.getBoundingClientRect().height > 20))
      check('maps', `${label}: address autocomplete suggestions appear as you type`, sug, 'Google Maps key / Places API wiring', 'WARN')
      await frame.locator('input[name="addressLine1"]').press('Escape').catch(() => {})
      await frame.locator('input[name="locality"]').fill(ctx.testAddress.city)
      await frame.locator('select[name="administrativeArea"]').selectOption(ctx.testAddress.state).catch(async () => { await frame.locator('input[name="administrativeArea"]').fill(ctx.testAddress.state) })
      await frame.locator('input[name="postalCode"]').fill(ctx.testAddress.zip)
      await pg.locator('#shipping-get-rates-btn').click()
      await pg.waitForSelector('#shipping-rates-view', { state: 'visible', timeout: 45000 })
      const rates = await pg.locator('#shipping-rates-list input[type=radio]').count()
      check('checkout', `${label}: live shipping rates are listed after entering an address`, rates > 0, `${rates} rates`)
      await pg.locator('#shipping-continue-btn').click()
      await pg.waitForURL(STRIPE_HOST, { timeout: 45000 })
      await pg.waitForTimeout(3000)
      const body = (await pg.locator('body').innerText()).replace(/\s+/g, ' ')
      const total = parseFloat((body.match(/\$\s?([0-9]+\.[0-9]{2})/) || [])[1])
      check('checkout', `${label}: lands on Stripe checkout with a shipping line and a total above the item price`, STRIPE_HOST.test(pg.url()) && (mobile || /shipping/i.test(body)) && total > prod.price_cents / 100, body.slice(0, 120))
      const sid = pg.url().match(/(cs_live_[A-Za-z0-9]+)/)?.[1]
      if (sid) ctx.sessions.push(sid)
      await pg.context().close()
    })
  }
  section('Browser — physical-item checkout (the address form)')
  const printful = products.find(p => isPhysical(p) && inStock(p) && p.printful_variant_map && Object.keys(p.printful_variant_map).length && mode(p) === 'standard' && p.price_cents > 0)
  const selfShip = products.find(p => isPhysical(p) && inStock(p) && !(p.printful_variant_map && Object.keys(p.printful_variant_map).length) && mode(p) === 'standard' && p.price_cents > 0 && p.sizes)
  if (selfShip) await physicalFlow(`self-ship ${selfShip.slug} (desktop)`, { width: 1280, height: 900 }, false, selfShip)
  if (printful) await physicalFlow(`Printful ${printful.slug} (desktop)`, { width: 1280, height: 900 }, false, printful)
  if (selfShip) await physicalFlow(`self-ship ${selfShip.slug} (phone)`, { width: 390, height: 844 }, true, selfShip)

  // ---------------------------------------------------------- other flows
  section('Browser — pay-what-you-want, free, services, tips')
  const offer = products.find(p => mode(p) === 'offer_based' && inStock(p))
  if (offer) await guard('checkout', 'pay-what-you-want checkout', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await open(pg, `${site}/products/${offer.slug}/`)
    await pg.locator('#product-view .buy-btn').click()
    await pg.waitForSelector('#offer-modal', { state: 'visible', timeout: 8000 })
    await pg.locator('#offer-amount').fill(String(Math.max((offer.offer_min_cents || 100) / 100, 1)))
    await pg.locator('#offer-submit-btn').click()
    await pg.waitForTimeout(800)
    await pg.locator('#cart-btn').click()
    check('checkout', `${offer.slug}: offer lands in the cart`, await pg.locator('#cart-items-list .cart-item-row').count() >= 1)
    const physical = isPhysical(offer)
    await pg.locator('#cart-checkout-btn').click()
    if (physical) { skip('checkout', `${offer.slug}: continue`, 'physical offer item — covered by shipping flow') } else {
      await pg.waitForURL(STRIPE_HOST, { timeout: 45000 })
      check('checkout', `${offer.slug}: digital checkout reaches Stripe`, true, pg.url().slice(0, 60))
      const sid = pg.url().match(/(cs_live_[A-Za-z0-9]+)/)?.[1]; if (sid) ctx.sessions.push(sid)
    }
    await pg.context().close()
  })
  const free = products.find(p => isFree(p) && !isService(p))
  if (free) await guard('browser', 'free download modal', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await open(pg, `${site}/products/${free.slug}/`)
    await pg.locator('#product-view .buy-btn').click()
    await pg.waitForSelector('#free-download-modal', { state: 'visible', timeout: 8000 })
    check('browser', `${free.slug}: free-download email modal opens`, await pg.locator('#free-download-email').isVisible())
    await pg.context().close()
  })
  const svc = products.find(p => isService(p) && inStock(p))
  if (svc) await guard('browser', 'service modals', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await open(pg, `${site}/products/${svc.slug}/`)
    await pg.locator('#product-view .service-message-btn').click()
    await pg.waitForSelector('#service-inquiry-modal', { state: 'visible', timeout: 8000 })
    check('browser', `${svc.slug}: Request A Quote modal opens with a phone field`, await pg.locator('#service-inquiry-phone').isVisible())
    await pg.locator('#service-inquiry-cancel-btn').click()
    await pg.locator('#product-view .service-payment-btn').click()
    await pg.waitForSelector('#reserve-modal', { state: 'visible', timeout: 8000 })
    check('browser', `${svc.slug}: Payment modal opens`, await pg.locator('#reserve-amount').isVisible())
    await pg.locator('#reserve-amount').fill('50')
    await pg.locator('#reserve-confirm-btn').click()
    await pg.waitForURL(STRIPE_HOST, { timeout: 45000 })
    check('checkout', `${svc.slug}: service Payment reaches Stripe`, true)
    const sid = pg.url().match(/(cs_live_[A-Za-z0-9]+)/)?.[1]; if (sid) ctx.sessions.push(sid)
    await pg.context().close()
  })
  await guard('checkout', 'tip jar', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await open(pg, site + '/')
    await pg.locator('#tip-open-btn').click()
    await pg.waitForSelector('#tip-modal', { state: 'visible', timeout: 8000 })
    await pg.locator('#tip-amount').fill('5')
    await pg.locator('#tip-submit-btn').click()
    await pg.waitForURL(STRIPE_HOST, { timeout: 45000 })
    check('checkout', 'tip: reaches Stripe checkout', true)
    const sid = pg.url().match(/(cs_live_[A-Za-z0-9]+)/)?.[1]; if (sid) ctx.sessions.push(sid)
    await pg.context().close()
  })

  // -------------------------------------------------------------- other pages
  section('Browser — admin gate, success page, phone layout')
  await guard('security', 'admin page', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await pg.goto(site + '/?mode=admin', { waitUntil: 'domcontentloaded' })
    await pg.waitForTimeout(2500)
    check('security', 'admin URL shows only the login form to a logged-out visitor', await pg.locator('#login-view').isVisible() && !(await pg.locator('#dashboard-view').isVisible()))
    check('browser', 'admin login page: no console errors', pg.issues.console.length === 0 && pg.issues.page.length === 0, pg.issues.console.slice(0, 2).join(' | '))
    await pg.context().close()
  })
  await guard('browser', 'success page', async () => {
    const pg = await newPage({ width: 1280, height: 900 })
    await pg.goto(site + '/success.html?session_id=cs_live_audit_bogus', { waitUntil: 'domcontentloaded' })
    await pg.waitForTimeout(4000)
    const text = (await pg.locator('body').innerText()).trim()
    check('browser', 'success page handles a bad session without hanging on a blank/loading screen', text.length > 20 && !/^loading\.*$/i.test(text), text.replace(/\s+/g, ' ').slice(0, 100))
    check('browser', 'success page: no uncaught exceptions', pg.issues.page.length === 0, pg.issues.page.join(' | '))
    await pg.context().close()
  })
  await guard('browser', 'phone layout', async () => {
    const pg = await newPage({ width: 390, height: 844 }, true)
    await open(pg, site + '/')
    check('browser', 'phone: homepage has no horizontal overflow', await noOverflow(pg))
    await pg.locator('#mobile-nav-toggle').click()
    await pg.waitForTimeout(400)
    await pg.locator('.filter-btn[data-filter="all"]').first().click()
    await pg.waitForTimeout(800)
    check('browser', 'phone: grid renders cards', await pg.locator('.product-card:visible').count() > 0)
    check('browser', 'phone: no console errors', pg.issues.console.length === 0 && pg.issues.page.length === 0, pg.issues.console.slice(0, 2).join(' | '))
    await pg.context().close()
  })

  await browser.close()
}
void pass; void warn
