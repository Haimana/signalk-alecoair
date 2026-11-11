/*
 * AlecoAir setup panel for Signal K Admin → Server → Plugin Config.
 *
 * Build-free Module Federation container: a classic script that registers
 * `window.signalk_alecoair = { init, get }`, which the Admin UI loads for
 * packages with the `signalk-plugin-configurator` keyword (signalk-server
 * 2.x, React 19 host). React comes from the host (`window.__SK_REACT__`, or
 * the share scope passed to init), so nothing is bundled and there is no
 * build step.
 *
 * The panel receives { configuration, save } from Admin. save(config) stores
 * the plugin options and restarts the plugin.
 */
(function () {
  'use strict'

  var CONTAINER = 'signalk_alecoair'
  var API = '/plugins/signalk-alecoair'
  var hostReact = null

  function getReact() {
    return window.__SK_REACT__ || hostReact
  }

  function slugKey(value, fallback) {
    var s = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
    return s || fallback || 'device'
  }

  function camelKey(value) {
    return String(value || '').split(/[^a-zA-Z0-9]+/).filter(Boolean).map(function (p, i) {
      return i === 0 ? p.toLowerCase() : p[0].toUpperCase() + p.slice(1).toLowerCase()
    }).join('')
  }

  var DEFAULT_PREFIX = 'environment.inside.dehumidifier'
  var AUTO_PREFIX_RE = /^environment\.inside\.dehumidifier\.[a-z0-9][a-z0-9_]{0,31}$/
  var AUTO_ELECTRICAL_RE = /^electrical\.loads\.dehumidifier[A-Za-z0-9]*\.power$/

  function defaultPrefix(key) {
    return DEFAULT_PREFIX + '.' + key
  }

  function defaultElectrical(key) {
    return 'electrical.loads.' + camelKey('dehumidifier ' + key) + '.power'
  }

  function syncPathsToKey(paths, key, prevKey) {
    var next = Object.assign({}, paths || {})
    var prefix = String(next.prefix || '').replace(/\.+$/, '')
    if (!prefix || AUTO_PREFIX_RE.test(prefix) || (prevKey && prefix === DEFAULT_PREFIX + '.' + prevKey)) {
      next.prefix = defaultPrefix(key)
    } else if (prevKey && prefix !== prevKey && prefix.slice(-(prevKey.length + 1)) === '.' + prevKey) {
      next.prefix = prefix.slice(0, prefix.length - prevKey.length) + key
    } else if (prefix) {
      next.prefix = prefix
    }
    var elec = next.electrical ? String(next.electrical) : ''
    if (elec && (AUTO_ELECTRICAL_RE.test(elec) || (prevKey && elec === defaultElectrical(prevKey)))) {
      next.electrical = defaultElectrical(key)
    }
    return next
  }

  function uniqueKey(base, devices) {
    var used = {}
    devices.forEach(function (d) { used[d.key] = true })
    if (!used[base]) return base
    for (var i = 2; i < 100; i++) if (!used[base + '_' + i]) return base + '_' + i
    return base + '_' + Date.now()
  }

  function clone(v) { return JSON.parse(JSON.stringify(v == null ? null : v)) }

  function normalizeDraft(cfg) {
    var c = clone(cfg) || {}
    c.configVersion = 2
    c.account = c.account || { region: 'eu' }
    c.discovery = c.discovery || { subnets: [] }
    c.devices = Array.isArray(c.devices) ? c.devices : []
    c.devices.forEach(function (d) {
      d.paths = d.paths || {}
      d.dpOverrides = d.dpOverrides || {}
    })
    return c
  }

  function newDevice(cloud, devices, ip) {
    var key = uniqueKey(slugKey(cloud.name || cloud.id), devices)
    return {
      key: key,
      enabled: true,
      name: cloud.name || key,
      tuyaId: cloud.id,
      productId: cloud.productId || '',
      ip: ip || '',
      protocol: 'auto',
      profile: 'auto',
      model: '',
      pollSeconds: 8,
      simulate: false,
      dpOverrides: {},
      paths: {
        prefix: defaultPrefix(key),
        electrical: defaultElectrical(key),
        publishCabinHumidity: false,
        cabinHumidity: 'environment.inside.relativeHumidity'
      }
    }
  }

  function api(path, method, body) {
    return fetch(API + path, {
      method: method || 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        var data
        try { data = text ? JSON.parse(text) : {} } catch (e) { data = { error: text.replace(/<[^>]+>/g, ' ').trim() } }
        if (!res.ok) {
          var msg = data.error || ('HTTP ' + res.status)
          if (res.status === 401 || res.status === 403) msg = 'Signal K refused the request (' + res.status + '). Setup needs an admin login.'
          if (res.status === 404 && /Cannot (GET|POST)/.test(msg)) msg = 'The plugin is not running. Enable it and save once, then reload.'
          throw new Error(msg)
        }
        return data
      })
    })
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    try { return new Date(ms).toLocaleString() } catch (e) { return String(ms) }
  }

  /*
   * Layout. Admin shows this panel in a narrow column next to the plugin
   * list, but Bootstrap col-md-* breakpoints follow the window width, so
   * fields were squeezed to a few characters (protocol "3.", model "D").
   * Use a grid that sizes from the panel's own width instead: as many
   * >= 8.5rem columns as fit, with wide fields spanning the whole row.
   */
  var CSS = [
    '.aa-c{container-type:inline-size}',
    '.aa-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));column-gap:.75rem;align-items:start}',
    '.aa-grid>*{min-width:0}',
    '.aa-grid .aa-full,.aa-grid .aa-span2{grid-column:1/-1}',
    '@container (min-width:40rem){.aa-grid .aa-span2{grid-column:span 2}}',
    '.aa-grid .aa-actions{align-self:end}',
    '.alecoair-config .aa-id{overflow-wrap:anywhere}'
  ].join('')

  function ensureStyle() {
    if (typeof document === 'undefined' || document.getElementById('alecoair-config-css')) return
    var el = document.createElement('style')
    el.id = 'alecoair-config-css'
    el.textContent = CSS
    document.head.appendChild(el)
  }

  function makePanel(React) {
    ensureStyle()
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    function Field(props) {
      return h('div', { className: 'mb-2 ' + (props.className || '') },
        h('label', { className: 'form-label small mb-1' }, props.label),
        props.children,
        props.help ? h('div', { className: 'form-text' }, props.help) : null)
    }

    function TextInput(props) {
      return h('input', {
        className: 'form-control form-control-sm',
        type: props.type || 'text',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder,
        readOnly: props.readOnly,
        autoComplete: props.autoComplete,
        onChange: function (e) { props.onChange && props.onChange(e.target.value) }
      })
    }

    function Select(props) {
      return h('select', {
        className: 'form-select form-select-sm',
        value: props.value == null ? '' : props.value,
        onChange: function (e) { props.onChange(e.target.value) }
      }, props.options.map(function (o) {
        return h('option', { key: o.value, value: o.value }, o.label)
      }))
    }

    function Check(props) {
      return h('div', { className: 'form-check mb-2 ' + (props.className || '') },
        h('input', {
          className: 'form-check-input', type: 'checkbox', id: props.id, checked: Boolean(props.checked),
          onChange: function (e) { props.onChange(e.target.checked) }
        }),
        h('label', { className: 'form-check-label small', htmlFor: props.id }, props.label))
    }

    function Section(props) {
      return h('div', { className: 'card mb-3' },
        h('div', { className: 'card-header d-flex justify-content-between align-items-center' },
          h('strong', null, props.title), props.actions || null),
        h('div', { className: 'card-body aa-c' }, props.children))
    }

    function Inspector(props) {
      var device = props.device
      var status = props.status
      var dataState = useState(null)
      var data = dataState[0]
      var setData = dataState[1]
      var errState = useState('')
      var changes = useRef({})
      var prev = useRef({})

      useEffect(function () {
        var stop = false
        function tick() {
          api('/setup/devices/' + encodeURIComponent(device.key) + '/dps').then(function (d) {
            if (stop) return
            var raw = d.rawDps || {}
            Object.keys(raw).forEach(function (id) {
              if (prev.current[id] !== undefined && JSON.stringify(prev.current[id]) !== JSON.stringify(raw[id])) changes.current[id] = Date.now()
            })
            prev.current = raw
            setData(d)
            errState[1]('')
          }).catch(function (e) { if (!stop) errState[1](e.message) })
        }
        tick()
        var t = setInterval(tick, 2000)
        return function () { stop = true; clearInterval(t) }
      }, [device.key])

      var roles = status.roles || []
      var profile = (status.profiles || []).find(function (p) { return p.id === ((data && data.profile) || '') }) || { dps: {} }
      var effective = (data && data.map) || {}
      var dpToRole = {}
      Object.keys(effective).forEach(function (role) { dpToRole[effective[role]] = role })
      var ids = Object.keys((data && data.rawDps) || {})
      Object.values(effective).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id) })
      ids.sort(function (a, b) { return Number(a) - Number(b) })

      function assign(dp, role) {
        var overrides = Object.assign({}, device.dpOverrides || {})
        var current = dpToRole[dp]
        if (current) overrides[current] = null
        if (role) overrides[role] = Number(dp)
        Object.keys(overrides).forEach(function (r) {
          var def = profile.dps[r]
          if (overrides[r] === (def == null ? null : Number(def))) delete overrides[r]
        })
        props.onChange(overrides)
      }

      return h('div', { className: 'border rounded p-2 mt-2 bg-light-subtle' },
        h('div', { className: 'small mb-2' },
          'Live datapoints from the unit. Change a setting on the unit itself and watch which DP lights up, then map it to a role. ',
          'Unsaved overrides apply after Save. The plugin never writes a DP the unit has not reported.'),
        errState[0] ? h('div', { className: 'alert alert-warning py-1 small' }, errState[0]) : null,
        data && data.suggestion ? h('div', { className: 'small mb-2' }, 'Fingerprint suggests: ', h('b', null, String(data.suggestion))) : null,
        h('table', { className: 'table table-sm small mb-1' },
          h('thead', null, h('tr', null, h('th', null, 'DP'), h('th', null, 'Value'), h('th', null, 'Reported'), h('th', null, 'Role'))),
          h('tbody', null, ids.map(function (id) {
            var recent = changes.current[id] && Date.now() - changes.current[id] < 6000
            var reported = data && data.reportedDps && data.reportedDps.indexOf(id) >= 0
            return h('tr', { key: id, className: recent ? 'table-warning' : '' },
              h('td', null, id),
              h('td', null, h('code', null, data && data.rawDps && data.rawDps[id] !== undefined ? JSON.stringify(data.rawDps[id]) : '—')),
              h('td', null, reported ? 'yes' : 'no'),
              h('td', null, h(Select, {
                value: dpToRole[id] || '',
                options: [{ value: '', label: '—' }].concat(roles.map(function (r) { return { value: r, label: r } })),
                onChange: function (v) { assign(id, v) }
              })))
          }))),
        h('div', { className: 'small text-muted' },
          'Overrides in this configuration: ', h('code', null, JSON.stringify(device.dpOverrides || {})), ' ',
          h('button', { type: 'button', className: 'btn btn-link btn-sm p-0', onClick: function () { props.onChange({}) } }, 'reset to profile')))
    }

    function DeviceCard(props) {
      var d = props.device
      var st = props.runtime || {}
      var status = props.status
      var inspectState = useState(false)
      var reportErr = useState('')
      var profiles = status.profiles || []
      var profileId = d.profile === 'auto' ? (st.profile && st.profile.id) : d.profile
      var prof = profiles.find(function (p) { return p.id === profileId }) || null
      var discovered = ((status.discovery && status.discovery.devices) || []).find(function (x) { return (x.id && x.id === d.tuyaId) || (x.configuredKey && x.configuredKey === d.key) })
      var state = st.state || {}

      function set(field, value) {
        var next = Object.assign({}, d)
        next[field] = value
        if (field === 'key' && value && value !== d.key) {
          next.paths = syncPathsToKey(d.paths, value, d.key)
        }
        props.onChange(next)
      }
      function setPath(field, value) { set('paths', Object.assign({}, d.paths, (function () { var o = {}; o[field] = value; return o })())) }

      var statusLine = !st.running
        ? (st.problems && st.problems.length ? 'Not started: ' + st.problems.join(', ') : (d.enabled ? 'Not running yet (save to start)' : 'Disabled'))
        : (state.connected ? 'Connected' + (state.adopted && state.adopted.protocol ? ' · Tuya ' + state.adopted.protocol : '') + (state.adopted && state.adopted.ip ? ' · ' + state.adopted.ip : '') : 'Disconnected' + (state.lastError ? ': ' + state.lastError : ''))

      return h('div', { className: 'border rounded p-3 mb-3 aa-c' },
        h('div', { className: 'd-flex justify-content-between align-items-start mb-2' },
          h('div', null,
            h('strong', null, d.name || d.key), ' ', h('code', { className: 'small' }, d.key),
            h('div', { className: 'small ' + (state.connected ? 'text-success' : 'text-danger') }, statusLine),
            st.running && st.profile ? h('div', { className: 'small text-muted' },
              'Profile in use: ', h('b', null, st.profile.id), ' (', st.profile.source, ')',
              prof && !prof.verified ? ' · unverified community map' : '') : null,
            st.running && st.profile && st.profile.id === 'generic' ? h('div', { className: 'small text-warning' },
              'No profile matched this product, so the unit is read-only. Pick a profile below or map DPs in the inspector.') : null,
            st.suggestion && typeof st.suggestion === 'string' && d.profile !== st.suggestion ? h('div', { className: 'small' },
              'Reported DPs look like ', h('b', null, st.suggestion), '. ',
              h('button', { type: 'button', className: 'btn btn-link btn-sm p-0', onClick: function () { set('profile', st.suggestion) } }, 'Use it')) : null,
            !st.hasLocalKey && !d.simulate ? h('div', { className: 'small text-danger' }, 'No local key stored for this device. Sign in to AlecoAir above.') : null),
          h('div', { className: 'btn-group btn-group-sm' },
            h('button', { type: 'button', className: 'btn btn-outline-secondary', onClick: function () { inspectState[1](!inspectState[0]) }, disabled: !st.running }, inspectState[0] ? 'Close inspector' : 'DP inspector'),
            h('button', {
              type: 'button',
              className: 'btn btn-outline-secondary',
              disabled: !st.running,
              title: 'Opens a pre-filled GitHub issue in your browser. Review it, then submit from your own account. Keys, device ids, IPs and Signal K paths are left out.',
              onClick: function () {
                reportErr[1]('')
                api('/setup/devices/' + encodeURIComponent(d.key) + '/report').then(function (r) {
                  if (r && r.url) window.open(r.url, '_blank', 'noopener,noreferrer')
                  else reportErr[1]('The report URL could not be built.')
                }).catch(function (e) { reportErr[1](e.message) })
              }
            }, 'Report to GitHub'),
            h('button', { type: 'button', className: 'btn btn-outline-danger', onClick: props.onRemove }, 'Remove'))),
        reportErr[0] ? h('div', { className: 'alert alert-warning py-1 small' }, reportErr[0]) : null,
        h('div', { className: 'aa-grid' },
          h(Field, { label: 'Name' }, h(TextInput, { value: d.name, onChange: function (v) { set('name', v) } })),
          h(Field, { label: 'Key (paths and API)', help: 'a-z, 0-9, _; the Signal K path follows this key unless you set a custom prefix' }, h(TextInput, { value: d.key, onChange: function (v) { set('key', slugKey(v, '')) } })),
          h(Field, { label: 'Tuya device id', className: 'aa-full' }, h(TextInput, { value: d.tuyaId, readOnly: true })),
          h(Field, {
            label: 'LAN IP',
            help: discovered && discovered.ip !== d.ip ? h('span', null, 'Found on LAN at ' + discovered.ip + ' ', h('button', { type: 'button', className: 'btn btn-link btn-sm p-0', onClick: function () { set('ip', discovered.ip) } }, 'use')) : 'Empty = find it on the LAN at start. A fixed IP here always wins.'
          }, h(TextInput, { value: d.ip, placeholder: 'auto', onChange: function (v) { set('ip', v.trim()) } })),
          h(Field, { label: 'Tuya protocol' }, h(Select, {
            value: d.protocol || 'auto', onChange: function (v) { set('protocol', v) },
            options: (status.protocols || ['auto', '3.3', '3.4', '3.5']).map(function (p) { return { value: p, label: p } })
          })),
          h(Field, { label: 'Model profile', className: 'aa-span2' }, h(Select, {
            value: d.profile || 'auto', onChange: function (v) { var n = Object.assign({}, d, { profile: v, model: '' }); props.onChange(n) },
            options: [{ value: 'auto', label: 'Auto (by AlecoAir product id)' }].concat(profiles.map(function (p) {
              return { value: p.id, label: p.name + (p.verified ? ' ✓' : p.id === 'generic' ? '' : ' (unverified)') }
            }))
          })),
          h(Field, { label: 'Model (power estimate)' }, h(Select, {
            value: d.model || '', onChange: function (v) { set('model', v) },
            options: [{ value: '', label: '—' }].concat(((prof && prof.models) || []).map(function (m) { return { value: m.id, label: m.name } }))
          })),
          h(Field, { label: 'Product id', className: 'aa-span2' }, h(TextInput, { value: d.productId, onChange: function (v) { set('productId', v.trim()) } })),
          h(Field, { label: 'Poll interval (s)' }, h(TextInput, { type: 'number', value: d.pollSeconds, onChange: function (v) { set('pollSeconds', Number(v) || 8) } })),
          h('div', { className: 'aa-span2 pt-1 mb-2' },
            h(Check, { id: 'en-' + d.key, label: 'Enabled', checked: d.enabled !== false, onChange: function (v) { set('enabled', v) }, className: 'form-check-inline' }),
            h(Check, { id: 'sim-' + d.key, label: 'Simulator (no hardware)', checked: d.simulate, onChange: function (v) { set('simulate', v) }, className: 'form-check-inline' }))),
        h('div', { className: 'aa-grid' },
          h(Field, { label: 'Signal K path prefix', className: 'aa-span2' }, h(TextInput, { value: d.paths.prefix, onChange: function (v) { setPath('prefix', v.trim()) } })),
          h(Field, { label: 'Estimated power path (empty = off)', className: 'aa-span2' }, h(TextInput, { value: d.paths.electrical, onChange: function (v) { setPath('electrical', v.trim()) } })),
          h('div', { className: 'aa-span2 pt-1' }, h(Check, { id: 'cab-' + d.key, label: 'Also publish the unit\u2019s humidity as cabin humidity', checked: d.paths.publishCabinHumidity, onChange: function (v) { setPath('publishCabinHumidity', v) } })),
          h(Field, { label: 'Cabin humidity path', className: 'aa-span2' }, h(TextInput, { value: d.paths.cabinHumidity, onChange: function (v) { setPath('cabinHumidity', v.trim()) } }))),
        inspectState[0] && st.running ? h(Inspector, { device: d, status: status, onChange: function (o) { set('dpOverrides', o) } }) : null)
    }

    return function AlecoAirConfigPanel(props) {
      var draftState = useState(function () { return normalizeDraft(props.configuration) })
      var draft = draftState[0]
      var setDraftRaw = draftState[1]
      var dirtyState = useState(false)
      var statusState = useState(null)
      var status = statusState[0]
      var msgState = useState(null)
      var busyState = useState('')
      var loginState = useState({ account: '', password: '', region: (draft.account && draft.account.region) || 'eu', countryCode: '40' })
      var login = loginState[0]

      function setDraft(next) { setDraftRaw(next); dirtyState[1](true) }
      function note(kind, text) { msgState[1](text ? { kind: kind, text: text } : null) }

      var prefilled = useRef(false)

      function refresh() {
        return api('/setup/status').then(function (s) {
          statusState[1](s)
          // Show which account is linked. Only the email/phone is kept; the password never is.
          var user = s && s.account && s.account.linked && s.account.user
          if (user && !prefilled.current) {
            prefilled.current = true
            loginState[1](function (l) { return l.account ? l : Object.assign({}, l, { account: user }) })
          }
        }).catch(function (e) { note('warning', e.message) })
      }

      useEffect(function () {
        refresh()
        var t = setInterval(refresh, 5000)
        return function () { clearInterval(t) }
      }, [])

      useEffect(function () {
        if (!dirtyState[0]) setDraftRaw(normalizeDraft(props.configuration))
      }, [props.configuration])

      function doLogin(e) {
        if (e) e.preventDefault()
        busyState[1]('login')
        note(null)
        api('/setup/login', 'POST', login).then(function (s) {
          statusState[1](s)
          loginState[1](Object.assign({}, login, { password: '' }))
          note('success', 'Signed in. ' + ((s.account && s.account.devices) || []).length + ' device(s) on this account. Click Add for each dehumidifier, optionally Scan LAN, then Save.')
          if (draft.account.region !== login.region) setDraft(Object.assign({}, draft, { account: { region: login.region } }))
        }).catch(function (err) { note('danger', err.message) }).then(function () { busyState[1]('') })
      }

      function doUnlink() {
        busyState[1]('unlink')
        api('/setup/unlink', 'POST', {}).then(function (s) { statusState[1](s); note('info', 'Account forgotten. Keys of configured devices are kept.') })
          .catch(function (err) { note('danger', err.message) }).then(function () { busyState[1]('') })
      }

      function doScan() {
        busyState[1]('scan')
        api('/setup/discover', 'POST', {}).then(function () { return refresh() })
          .catch(function (err) { note('danger', err.message) }).then(function () { busyState[1]('') })
      }

      function addCloud(cloud) {
        var found = ((status && status.discovery && status.discovery.devices) || []).find(function (x) { return x.id === cloud.id })
        var d = newDevice(cloud, draft.devices, (found && found.ip) || cloud.ip || '')
        setDraft(Object.assign({}, draft, { devices: draft.devices.concat([d]) }))
      }

      function addSimulator() {
        var key = uniqueKey('sim', draft.devices)
        var d = newDevice({ id: '', name: 'Simulator' }, draft.devices, '')
        d.key = key
        d.simulate = true
        d.profile = 'traditio'
        d.model = 'D13'
        d.paths.prefix = defaultPrefix(key)
        d.paths.electrical = ''
        setDraft(Object.assign({}, draft, { devices: draft.devices.concat([d]) }))
      }

      function updateDevice(i, d) {
        var list = draft.devices.slice()
        list[i] = d
        setDraft(Object.assign({}, draft, { devices: list }))
      }

      function removeDevice(i) {
        var list = draft.devices.slice()
        list.splice(i, 1)
        setDraft(Object.assign({}, draft, { devices: list }))
      }

      function validate() {
        var keys = {}
        var prefixes = {}
        for (var i = 0; i < draft.devices.length; i++) {
          var d = draft.devices[i]
          if (!/^[a-z0-9][a-z0-9_]{0,31}$/.test(d.key || '')) return 'Device key "' + d.key + '" is not valid.'
          if (keys[d.key]) return 'Device key "' + d.key + '" is used twice.'
          if (prefixes[d.paths.prefix]) return 'Path prefix ' + d.paths.prefix + ' is used twice.'
          keys[d.key] = true
          prefixes[d.paths.prefix] = true
        }
        return null
      }

      function doSave() {
        var problem = validate()
        if (problem) return note('danger', problem)
        props.save(clone(draft))
        dirtyState[1](false)
        note('success', 'Saved. The plugin restarts with the new configuration.')
        setTimeout(refresh, 2500)
      }

      if (!status) {
        return h('div', null, msgState[0] ? h('div', { className: 'alert alert-' + msgState[0].kind }, msgState[0].text) : 'Loading AlecoAir setup…')
      }

      var account = status.account || {}
      var cloud = account.devices || []
      var runtimeByKey = {}
      ;(status.devices || []).forEach(function (d) { runtimeByKey[d.key] = d })
      var configuredIds = {}
      draft.devices.forEach(function (d) { if (d.tuyaId) configuredIds[d.tuyaId] = d.key })
      var disc = status.discovery || {}
      // Login first. Until the account is linked (signed in now or earlier), or
      // the draft already holds a real (non-simulator) unit whose key is on the
      // server, show only the sign-in form. The account device table, LAN scan
      // and device list come after: a scan only finds IPs, while control needs
      // each unit's local key, which only the account sign-in provides.
      var hasRealDevice = draft.devices.some(function (d) { return !d.simulate })
      var setupOpen = Boolean(account.linked) || hasRealDevice
      var showSave = setupOpen || dirtyState[0] || draft.devices.length > 0

      return h('div', { className: 'alecoair-config', 'data-aa-stage': setupOpen ? 'setup' : 'login' },
        h('p', { className: 'small text-muted' },
          'All AlecoAir setup happens here. The WebApp at ', h('a', { href: status.webappPath, target: '_blank', rel: 'noopener' }, status.webappPath),
          ' only operates the units.'),
        status.migration ? h('div', { className: 'alert alert-info small py-2' },
          'Migrated from ', h('code', null, status.migration.from), ' on ', fmtTime(status.migration.at), '. ',
          'The old files were left untouched as a backup.') : null,
        msgState[0] ? h('div', { className: 'alert alert-' + msgState[0].kind + ' py-2' }, msgState[0].text) : null,

        h(Section, {
          title: 'AlecoAir account',
          actions: account.linked ? h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', disabled: busyState[0] === 'unlink', onClick: doUnlink }, 'Forget account') : null
        },
        h('p', { className: 'small' }, account.linked
          ? 'Signed in via ' + (account.source || 'AlecoAir') + ' (region ' + (account.region || '—') + ', ' + fmtTime(account.linkedAt) + '). Sign in again to refresh local keys after re-pairing a unit.'
          : 'Sign in with the email or phone and password of the AlecoAir app where the units already appear. This is needed once, to fetch each unit\u2019s local key: a LAN scan can find a unit\u2019s IP, but without that key it cannot read or control the unit. The password is not stored; only the local keys are kept on this server, and control then stays on the LAN.'),
        account.linked ? h('p', { className: 'small text-muted' },
          account.user
            ? h('span', null, 'Linked account: ', h('b', null, account.user), '. ')
            : 'The linked account\u2019s email or phone was not recorded (that sign-in happened before this version kept it), so the field below is empty. ',
          'The password is never stored, so its field is always empty; type it only to sign in again.') : null,
        h('form', { className: 'aa-grid', onSubmit: doLogin },
          h(Field, { label: 'Email or phone', className: 'aa-span2' }, h(TextInput, { value: login.account, autoComplete: 'username', onChange: function (v) { loginState[1](Object.assign({}, login, { account: v })) } })),
          h(Field, { label: 'Password', className: 'aa-span2' }, h(TextInput, { type: 'password', value: login.password, autoComplete: 'current-password', placeholder: account.linked ? 'not stored; needed only to sign in again' : '', onChange: function (v) { loginState[1](Object.assign({}, login, { password: v })) } })),
          h(Field, { label: 'Region' }, h(Select, { value: login.region, onChange: function (v) { loginState[1](Object.assign({}, login, { region: v })) }, options: ['eu', 'us', 'cn', 'in'].map(function (r) { return { value: r, label: r } }) })),
          h(Field, { label: 'Country code (phone)' }, h(TextInput, { value: login.countryCode, onChange: function (v) { loginState[1](Object.assign({}, login, { countryCode: v })) } })),
          h('div', { className: 'aa-actions mb-2' },
            h('button', { type: 'submit', className: 'btn btn-sm btn-primary w-100', disabled: busyState[0] === 'login' || !login.account || !login.password }, busyState[0] === 'login' ? 'Signing in…' : 'Sign in'))),
        setupOpen && cloud.length ? h('div', { className: 'table-responsive mt-2' }, h('table', { className: 'table table-sm small mb-0' },
          h('thead', null, h('tr', null, h('th', null, 'Device'), h('th', null, 'Product'), h('th', null, 'Profile'), h('th', null, 'Key'), h('th', null, ''))),
          h('tbody', null, cloud.map(function (c) {
            var key = configuredIds[c.id]
            return h('tr', { key: c.id },
              h('td', null, c.name, c.dehumidifier ? '' : h('span', { className: 'text-muted' }, ' (not a dehumidifier?)'), h('div', { className: 'text-muted aa-id' }, c.id)),
              h('td', null, c.productName || '—', h('div', { className: 'text-muted aa-id' }, c.productId || '')),
              h('td', null, c.profileByProductId
                ? c.profileByProductId
                : c.configuredProfile
                  ? h('span', null, c.configuredProfile, h('div', { className: 'text-muted' }, 'set on the device'))
                  : h('span', { className: 'text-muted' }, 'none (read-only until mapped)')),
              h('td', null, c.hasKey ? 'stored' : h('span', { className: 'text-danger' }, 'missing')),
              h('td', { className: 'text-end' }, key
                ? h('span', { className: 'text-success' }, 'added as ', h('code', null, key))
                : h('button', { type: 'button', className: 'btn btn-sm btn-outline-primary', disabled: !c.hasKey, onClick: function () { addCloud(c) } }, 'Add')))
          })))) : null),

        setupOpen ? h(Section, {
          title: 'LAN discovery',
          actions: h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', disabled: busyState[0] === 'scan' || disc.scanning, onClick: doScan }, busyState[0] === 'scan' || disc.scanning ? 'Scanning…' : 'Scan LAN')
        },
        h('p', { className: 'small mb-2' }, 'Optional: finds the units\u2019 LAN IPs. Adding from the account does not need a scan, and a scan alone cannot control a unit. One shared scan (Tuya UDP 6666/6667 plus a TCP 6668 sweep) serves every device without a fixed IP. Last scan: ' + fmtTime(disc.lastScanAt) + (disc.lastError ? ' · ' + disc.lastError : '')),
        h(Field, { label: 'Extra subnets to sweep (comma separated, e.g. 172.22.22.0/24; empty = local /24s)', className: 'col-12' },
          h(TextInput, {
            value: (draft.discovery.subnets || []).join(', '),
            onChange: function (v) { setDraft(Object.assign({}, draft, { discovery: { subnets: v.split(',').map(function (s) { return s.trim() }).filter(Boolean) } })) }
          })),
        (disc.devices || []).length ? h('div', { className: 'table-responsive' }, h('table', { className: 'table table-sm small mb-0' },
          h('thead', null, h('tr', null, h('th', null, 'IP'), h('th', null, 'Tuya id'), h('th', null, 'Protocol'), h('th', null, 'Seen via'), h('th', null, 'Configured'))),
          h('tbody', null, disc.devices.map(function (x) {
            var key = x.configuredKey || (x.id && configuredIds[x.id]) || null
            var fromConfig = h('div', { className: 'text-muted', title: 'Not announced by the unit; taken from the configured device' }, 'from config')
            return h('tr', { key: x.ip + x.id },
              h('td', null, x.ip),
              h('td', null, x.id ? h('span', { className: 'aa-id' }, x.id) : (x.knownId ? h('span', null, h('span', { className: 'aa-id' }, x.knownId), fromConfig) : '—')),
              h('td', null, x.id && x.version ? x.version : (x.knownVersion ? h('span', null, x.knownVersion, fromConfig) : '—')),
              h('td', null, x.id ? (x.tcp ? 'UDP + TCP' : 'UDP') : 'TCP 6668 only'),
              h('td', null, key ? h('span', null, h('code', null, key), x.matchedBy === 'ip' ? h('div', { className: 'text-muted' }, 'matched by IP') : null) : '—'))
          })))) : null) : null,

        h(Section, {
          title: 'Dehumidifiers',
          actions: h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', onClick: addSimulator }, 'Add simulator')
        },
        draft.devices.length === 0 ? h('p', { className: 'small mb-0' }, setupOpen
          ? 'No device yet. Click Add in the account table above.'
          : 'No device yet. Sign in above to list and add your dehumidifiers, or add a simulator to try the plugin without hardware.') : null,
        draft.devices.map(function (d, i) {
          return h(DeviceCard, {
            key: i + ':' + (d.tuyaId || d.key),
            device: d,
            runtime: runtimeByKey[d.key],
            status: status,
            onChange: function (n) { updateDevice(i, n) },
            onRemove: function () { removeDevice(i) }
          })
        })),

        showSave ? h('div', { className: 'd-flex gap-2 align-items-center mb-3' },
          h('button', { type: 'button', className: 'btn btn-primary', disabled: !dirtyState[0], onClick: doSave }, 'Save configuration'),
          dirtyState[0] ? h('span', { className: 'small text-warning' }, 'Unsaved changes. Saving restarts the plugin.') : h('span', { className: 'small text-muted' }, 'Saved.')) : null,

        setupOpen ? h('details', { className: 'small' },
          h('summary', null, 'Diagnostics'),
          h('div', { className: 'mt-2' },
            h('div', null, 'Plugin id: ', h('code', null, status.pluginId)),
            h('div', null, 'Secrets store: ', h('code', null, status.storeFile)),
            h('pre', { className: 'mt-2', style: { maxHeight: '320px', overflow: 'auto' } }, JSON.stringify({ devices: status.devices, discovery: status.discovery }, null, 2)))) : null)
    }
  }

  var panel = null

  window[CONTAINER] = {
    init: function (shareScope) {
      try {
        var versions = shareScope && shareScope.react ? Object.keys(shareScope.react) : []
        if (!window.__SK_REACT__ && versions.length) {
          return Promise.resolve(shareScope.react[versions[0]].get()).then(function (factory) { hostReact = factory() })
        }
      } catch (e) { /* fall back to window.__SK_REACT__ */ }
      return undefined
    },
    get: function (module) {
      if (module !== './PluginConfigurationPanel') {
        return Promise.reject(new Error('signalk-alecoair exposes only ./PluginConfigurationPanel'))
      }
      return Promise.resolve(function () {
        var React = getReact()
        if (!React) throw new Error('Signal K Admin did not provide React')
        if (!panel) panel = makePanel(React)
        return { default: panel, __esModule: true }
      })
    }
  }
})()
