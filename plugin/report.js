'use strict'

/**
 * Build a sanitized GitHub issue for a device report. The user reviews and
 * submits it from their own account. Local keys, Tuya device ids, account
 * details, tokens, LAN IPs and Signal K path prefixes never go in.
 */

const ISSUE_REPO = 'Haimana/signalk-alecoair'
const ISSUE_BASE = 'https://github.com/' + ISSUE_REPO + '/issues/new'

function redactText(value) {
  return String(value == null ? '' : value)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[redacted-ip]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
}

function sanitizeDpValue(value) {
  if (value === null || value === undefined) return value
  if (typeof value === 'boolean' || typeof value === 'number') return value
  const s = redactText(value)
  if (s.length > 64) return '[omitted]'
  return s
}

function roleByDp(map) {
  const out = {}
  if (!map || typeof map !== 'object') return out
  for (const [role, id] of Object.entries(map)) {
    if (id === null || id === undefined || id === '') continue
    out[String(id)] = role
  }
  return out
}

function formatDpCell(value) {
  if (value === undefined) return '-'
  return '`' + JSON.stringify(sanitizeDpValue(value)) + '`'
}

function profileLabel(profile, source) {
  if (!profile) return 'none (device not running yet)'
  const id = profile.id || profile
  const bits = [id]
  if (source) {
    bits.push(source === 'productId' ? 'auto, by product id' : source === 'fallback' ? 'fallback' : source)
  }
  if (profile.verified) bits.push('verified')
  else if (id === 'generic') bits.push('read-only until mapped')
  else bits.push('unverified')
  return bits.join(' - ')
}

function issueTitle({ productId, profile }) {
  const id = profile && profile.id
  if (id && id !== 'generic') return 'Device report: ' + (profile.name || id) + ' (' + id + ')'
  if (productId) return 'Device report: unknown AlecoAir (product id ' + productId + ')'
  return 'Device report: unknown AlecoAir unit'
}

function issueLabels({ profile }) {
  const labels = ['device-report']
  const id = profile && profile.id
  if (!id || id === 'generic') labels.push('unknown-model')
  else if (!profile.verified) labels.push('unverified-profile')
  return labels
}

function buildDeviceReport(input) {
  input = input || {}
  const cfg = input.device || {}
  const profile = input.profile || null
  const source = input.source || null
  const suggestion = input.suggestion
  const rawDps = (input.rawDps && typeof input.rawDps === 'object') ? input.rawDps : {}
  const reportedDps = Array.isArray(input.reportedDps) ? input.reportedDps.map(String) : Object.keys(rawDps)
  const map = input.map || (profile && profile.dps) || {}
  const roles = roleByDp(map)
  const protocol = input.protocol || null
  const connected = input.connected
  const pluginVersion = input.pluginVersion || 'unknown'
  const signalkVersion = input.signalkVersion || 'unknown'
  const nodeVersion = input.nodeVersion || process.version
  const productId = cfg.productId ? String(cfg.productId).trim() : ''
  const model = cfg.model ? String(cfg.model) : ''
  const simulate = cfg.simulate === true
  const lastError = input.lastError ? redactText(input.lastError) : ''

  const dpIds = [...new Set([...reportedDps, ...Object.keys(rawDps), ...Object.keys(roles)])]
    .filter((id) => /^\d+$/.test(id))
    .sort((a, b) => Number(a) - Number(b))

  const rows = dpIds.length
    ? dpIds.map((id) => {
      const role = roles[id] || '(unmapped)'
      const reported = reportedDps.includes(id) || Object.prototype.hasOwnProperty.call(rawDps, id) ? 'yes' : 'no'
      return '| ' + id + ' | ' + formatDpCell(rawDps[id]) + ' | ' + reported + ' | ' + role + ' |'
    }).join('\n')
    : '| - | no live datapoints yet | - | - |'

  const suggestionLine = Array.isArray(suggestion) ? suggestion.join(', ') : (suggestion || 'none')

  const transport = protocol
    ? 'Tuya LAN protocol ' + protocol
    : (connected === false ? 'not connected yet' : 'unknown (not yet learned)')

  const body = [
    '<!-- Review this report before submitting. Add what works and what does not. Do not paste local keys, device ids, account details, IPs or Signal K paths. -->',
    '',
    '### Plugin',
    '- signalk-alecoair ' + pluginVersion,
    '- Signal K ' + signalkVersion + ', Node.js ' + nodeVersion,
    '- Transport: ' + transport,
    simulate ? '- Simulator: yes (no hardware)' : null,
    '',
    '### Unit',
    '- Tuya product id: ' + (productId || 'unknown'),
    '- Profile in use: ' + profileLabel(profile, source),
    '- Fingerprint suggestion: ' + suggestionLine,
    '- Model (power estimate): ' + (model || 'not set'),
    lastError ? '- Last error (addresses removed): ' + lastError : null,
    '',
    '### What works',
    '<!-- Write what you tried in the official AlecoAir app and in the WebApp. -->',
    '',
    '### What does not',
    '<!-- Describe anything that is missing or wrong. -->',
    '',
    '### Live datapoints',
    '(values as reported on the LAN; no keys, device ids or addresses)',
    '',
    '| DP | Live value | Reported | Profile role |',
    '|----|------------|----------|--------------|',
    rows,
    '',
    '### Commands tried from the plugin',
    '<!-- Optional: commands you sent and what happened. -->',
    '',
    '### Notes from the user',
    '<!-- Anything else that might help, for example how the official app labels a mode. -->',
    ''
  ].filter((line) => line !== null).join('\n')

  const title = issueTitle({ productId, profile })
  const labels = issueLabels({ profile })
  const url = ISSUE_BASE + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body) + '&labels=' + encodeURIComponent(labels.join(','))

  return { title, body, labels, url, repo: ISSUE_REPO }
}

function assertSanitized(report, forbidden) {
  forbidden = forbidden || []
  const blob = report.title + '\n' + report.body + '\n' + report.url
  for (const item of forbidden) {
    if (item && blob.includes(String(item))) {
      throw new Error('device report would have leaked a secret')
    }
  }
  return report
}

module.exports = {
  ISSUE_REPO,
  ISSUE_BASE,
  buildDeviceReport,
  assertSanitized,
  redactText,
  sanitizeDpValue
}

