'use strict'

/**
 * Data-driven model profiles. The Tuya LAN transport is generic; a profile
 * only says which datapoint (DP) carries which role and how values are coded.
 *
 * Only `traditio` is verified on a live unit (D13 Traditio, Tuya LAN 3.5).
 * The other families come from community maps in make-all/tuya-local and are
 * marked unverified. Unknown products get the read-only `generic` profile:
 * they are never given the D13 map silently.
 */

/** Roles a profile (or a user override) can map to a DP id. */
const ROLES = [
  'power',
  'targetHumidity',
  'mode',
  'humidity',
  'temperature',
  'fan',
  'childLock',
  'timer',
  'timerLeft',
  'fault',
  'sleep',
  'insideDry'
]

const PROFILES = {
  traditio: {
    id: 'traditio',
    name: 'AlecoAir Traditio (D13 / D25)',
    verified: true,
    note: 'D13 Traditio verified on a live unit (Tuya LAN 3.5). D25 Traditio shares this map per tuya-local but has not been tested here.',
    sources: [
      'Live D13 Traditio LAN dump (this project)',
      'make-all/tuya-local greenmigo_alpha_q25_pro_wifi.yaml (legacy AlecoAir_D25_Traditio)'
    ],
    productIds: ['b9oyi2yofflroq1g'],
    models: {
      D13: {
        name: 'D13 Traditio',
        capacityLitersPerDay: 13,
        ratedWatts: 170,
        maxWatts: 195,
        idleWatts: 18,
        sleepWatts: 145,
        defrostWatts: 28,
        tankFullWatts: 2,
        tankLiters: 2.3
      },
      D25: {
        name: 'D25 Traditio',
        capacityLitersPerDay: 25
      }
    },
    dps: {
      power: 1,
      targetHumidity: 2,
      fan: 4,
      mode: 5,
      humidity: 6,
      childLock: 16,
      timer: 17,
      fault: 19
    },
    modes: [
      { value: 'auto', raw: 'Manual', label: 'Auto / hygrostat' },
      { value: 'sleep', raw: 'SLeeping', aliases: ['Sleeping'], label: 'Sleep' }
    ],
    continuous: { via: 'target', target: 25, label: 'Continuous (CO)' },
    humidity: { min: 30, max: 80, step: 5 },
    timer: { format: 'suffix-h', max: 24 },
    fan: { low: 'low', high: 'high' },
    fault: { tankFull: 4, defrost: 8 },
    fingerprint: { dps: [1, 2, 5, 6, 19], mode: /^(manual|auto|laundrydrying|sleeping|purifying)$/i }
  },

  'shinco-home': {
    id: 'shinco-home',
    name: 'AlecoAir Home (D12 / D16 Home, Shinco family)',
    verified: false,
    note: 'Community map, not tested by this project. Tank and defrost bits are the opposite of Traditio.',
    sources: ['make-all/tuya-local shinco_30d_dehumidifier.yaml (legacy alecoair_d12_home_dehumidifier)'],
    productIds: ['hp1sjssyokokbrsg'],
    models: {},
    dps: {
      power: 1,
      mode: 2,
      humidity: 3,
      targetHumidity: 4,
      fan: 6,
      childLock: 7,
      fault: 11,
      timer: 12,
      timerLeft: 13,
      insideDry: 101
    },
    modes: [
      { value: 'auto', raw: '0', label: 'Auto' }
    ],
    continuous: { via: 'mode', raw: '1', label: 'Continuous / laundry' },
    humidity: { min: 30, max: 80, step: 5 },
    timer: { format: 'number', max: 24 },
    fan: { low: '1', high: '0' },
    fault: { tankFull: 8, defrost: 4 },
    fingerprint: { dps: [1, 2, 3, 4, 11] }
  },

  'd12-eco': {
    id: 'd12-eco',
    name: 'AlecoAir D12 ECO 2.0',
    verified: false,
    note: 'Community map, not tested by this project. No timer DP.',
    sources: ['make-all/tuya-local alecoair_d12_dehumidifier.yaml'],
    productIds: ['gcthce4ejb8nzgow'],
    models: {},
    dps: {
      power: 1,
      targetHumidity: 2,
      fan: 4,
      mode: 5,
      humidity: 6,
      temperature: 7,
      sleep: 14,
      childLock: 16,
      fault: 19
    },
    modes: [
      { value: 'auto', raw: 'Rain_Day', label: 'Normal' },
      { value: 'eco', raw: 'Sunny_Day', label: 'Eco' }
    ],
    continuous: { via: 'mode', raw: 'Continuous', label: 'Continuous' },
    humidity: { min: 30, max: 80, step: 5 },
    timer: null,
    fan: { low: 'low', high: 'high' },
    fault: { tankFull: 1 },
    fingerprint: { dps: [1, 2, 5, 6, 19], mode: /^(continuous|sunny_day|rain_day)$/i }
  },

  'd16-purify': {
    id: 'd16-purify',
    name: 'AlecoAir D16 Purify (D14 Purify)',
    verified: false,
    note: 'Community map, not tested by this project.',
    sources: ['make-all/tuya-local alecoair_d16_dehumidifier.yaml (legacy alecoair_d14_dehumidifier)'],
    productIds: ['pzq25786mlkxmtbb'],
    models: {},
    dps: {
      power: 1,
      targetHumidity: 2,
      mode: 4,
      fan: 5,
      childLock: 14,
      humidity: 16,
      timer: 17,
      fault: 19
    },
    modes: [
      { value: 'auto', raw: 'manual', label: 'Normal' },
      { value: 'laundry', raw: 'laundry', label: 'Laundry' },
      { value: 'purify', raw: 'purify', label: 'Purify' },
      { value: 'sleep', raw: 'sleep', label: 'Sleep' }
    ],
    continuous: null,
    humidity: { min: 25, max: 80, step: 5 },
    timer: { format: 'suffix-h', max: 24 },
    fan: { low: 'low', high: 'high' },
    fault: { tankFull: 1 },
    fingerprint: { dps: [1, 2, 4, 16, 19], mode: /^(manual|laundry|purify|sleep)$/i }
  },

  generic: {
    id: 'generic',
    name: 'Generic Tuya dehumidifier (read-only until mapped)',
    verified: false,
    note: 'No DP map. Nothing is written to the device unless you map roles in the DP inspector.',
    sources: [],
    productIds: [],
    models: {},
    dps: {},
    modes: [],
    continuous: null,
    humidity: { min: 30, max: 80, step: 5 },
    timer: { format: 'suffix-h', max: 24 },
    fan: { low: 'low', high: 'high' },
    fault: {},
    fingerprint: null
  }
}

function getProfile(id) {
  return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : null
}

function profileForProductId(productId) {
  if (!productId) return null
  return Object.values(PROFILES).find((p) => p.productIds.includes(String(productId))) || null
}

/**
 * Pick the profile for a configured device.
 * - an explicit profile id always wins;
 * - `auto` matches the AlecoAir productId;
 * - otherwise the device runs on the read-only generic profile. A DP
 *   fingerprint is only ever offered as a suggestion (see suggestProfile).
 */
function resolveProfile(device = {}) {
  const requested = device.profile || 'auto'
  if (requested !== 'auto') {
    const explicit = getProfile(requested)
    if (explicit) return { profile: explicit, source: 'manual', requested }
    return { profile: PROFILES.generic, source: 'unknown-profile', requested }
  }
  const byProduct = profileForProductId(device.productId)
  if (byProduct) return { profile: byProduct, source: 'productId', requested }
  return { profile: PROFILES.generic, source: 'fallback', requested }
}

/** Suggest a profile from the DPs a device reported. Never applied automatically. */
function suggestProfile(dps = {}) {
  const ids = new Set(Object.keys(dps || {}).map(String))
  const hits = []
  for (const profile of Object.values(PROFILES)) {
    const fp = profile.fingerprint
    if (!fp) continue
    if (!fp.dps.every((id) => ids.has(String(id)))) continue
    if (fp.mode) {
      const raw = dps[String(profile.dps.mode)]
      if (raw === undefined || !fp.mode.test(String(raw))) continue
    }
    hits.push(profile.id)
  }
  return hits.length === 1 ? hits[0] : (hits.length ? hits : null)
}

function modelInfo(profile, model) {
  if (!profile || !model) return null
  return (profile.models && profile.models[model]) || null
}

function listProfiles() {
  return Object.values(PROFILES).map((p) => ({
    id: p.id,
    name: p.name,
    verified: p.verified,
    note: p.note,
    sources: p.sources,
    productIds: p.productIds,
    models: Object.entries(p.models || {}).map(([id, m]) => ({ id, name: m.name })),
    dps: { ...p.dps },
    modes: p.modes.map((m) => ({ value: m.value, label: m.label, raw: m.raw })),
    continuous: p.continuous ? { ...p.continuous } : null,
    humidity: { ...p.humidity }
  }))
}

module.exports = {
  ROLES,
  PROFILES,
  getProfile,
  profileForProductId,
  resolveProfile,
  suggestProfile,
  modelInfo,
  listProfiles
}
