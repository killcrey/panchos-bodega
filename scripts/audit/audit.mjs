// Live-site audit for Panchos Bodega.
//   node scripts/audit/audit.mjs [--site=https://bodega.theinvisiblepanchos.com] [--skip-browser] [--skip-api]
// Phase 1 (api.mjs): plain-HTTP checks incl. real (unpaid) Stripe sessions for every product.
// Phase 2 (browser.mjs): drives the real site in Edge via playwright-core. Never pays.
// Unpaid Stripe session ids are written to scripts/audit/.sessions.json so they can be expired.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadEnv, summarize } from './lib.mjs'
import { runApiAudit } from './api.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]))
const site = (args.site || 'https://bodega.theinvisiblepanchos.com').replace(/\/$/, '')
const env = loadEnv()
const ctx = {}
const here = path.dirname(fileURLToPath(import.meta.url))

console.log(`Auditing ${site} at ${new Date().toISOString()}`)
if (!args['skip-api']) await runApiAudit({ site, env, ctx })
if (!args['skip-browser']) {
  const { runBrowserAudit } = await import('./browser.mjs')
  await runBrowserAudit({ site, env, ctx })
}
const sessFile = path.join(here, '.sessions.json')
const prior = existsSync(sessFile) ? JSON.parse(readFileSync(sessFile, 'utf8')) : []
writeFileSync(sessFile, JSON.stringify([...new Set([...prior, ...(ctx.sessions || []).filter(Boolean)])], null, 1))
const c = summarize()
process.exit(c.FAIL ? 1 : 0)
