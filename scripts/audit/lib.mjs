// Shared helpers for the live-site audit (see audit.mjs).
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function loadEnv() {
  const env = { ...process.env }
  const p = path.join(ROOT, '.env')
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/)
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return env
}

export const results = []
export function record(area, name, status, detail = '') {
  results.push({ area, name, status, detail })
  const icon = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', SKIP: 'SKIP' }[status]
  console.log(`  [${icon}] ${name}${detail ? ' — ' + detail : ''}`)
}
export const pass = (a, n, d) => record(a, n, 'PASS', d)
export const fail = (a, n, d) => record(a, n, 'FAIL', d)
export const warn = (a, n, d) => record(a, n, 'WARN', d)
export const skip = (a, n, d) => record(a, n, 'SKIP', d)
export function check(area, name, ok, detail = '', failStatus = 'FAIL') {
  record(area, name, ok ? 'PASS' : failStatus, detail)
  return ok
}
export function section(title) {
  console.log(`\n== ${title}`)
}

export async function timed(fn, ms = 30000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try { return await fn(ctl.signal) } finally { clearTimeout(t) }
}

export async function http(url, opts = {}) {
  try {
    return await timed(signal => fetch(url, { redirect: 'manual', ...opts, signal }), opts.timeout || 30000)
  } catch (err) {
    return { ok: false, status: 0, error: String(err), headers: new Headers(), text: async () => '', json: async () => null }
  }
}

export function summarize() {
  const c = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 }
  for (const r of results) c[r.status]++
  console.log('\n================ AUDIT SUMMARY ================')
  console.log(`PASS ${c.PASS}   FAIL ${c.FAIL}   WARN ${c.WARN}   SKIP ${c.SKIP}`)
  const bad = results.filter(r => r.status === 'FAIL')
  if (bad.length) {
    console.log('\nFAILURES:')
    for (const r of bad) console.log(`  - [${r.area}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  }
  const warns = results.filter(r => r.status === 'WARN')
  if (warns.length) {
    console.log('\nWARNINGS:')
    for (const r of warns) console.log(`  - [${r.area}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`)
  }
  return c
}
