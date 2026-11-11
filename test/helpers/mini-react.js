'use strict'

// A tiny synchronous React stand-in, just enough to render the Admin
// configurator (public/remoteEntry.js) in tests without installing React:
// createElement, useState, useEffect and useRef, a full re-render on every
// state change, and helpers to find nodes and fire their handlers.

function flatten(list, out = []) {
  for (const c of list) {
    if (Array.isArray(c)) flatten(c, out)
    else if (c !== null && c !== undefined && c !== false && c !== true) out.push(c)
  }
  return out
}

function createMiniReact() {
  const hooks = new Map()
  let current = null
  let rendered = null
  let root = null
  let pending = []
  let scheduled = false

  const React = {
    createElement(type, props, ...children) {
      return { type, key: props && props.key != null ? String(props.key) : null, props: Object.assign({}, props, { children: flatten(children) }) }
    },
    useState(init) {
      const slot = current.slot()
      if (!slot.init) {
        slot.init = true
        slot.value = typeof init === 'function' ? init() : init
      }
      const setter = (v) => {
        slot.value = typeof v === 'function' ? v(slot.value) : v
        schedule()
      }
      return [slot.value, setter]
    },
    useRef(init) {
      const slot = current.slot()
      if (!slot.init) { slot.init = true; slot.value = { current: init } }
      return slot.value
    },
    useEffect(fn, deps) {
      const slot = current.slot()
      const changed = !slot.init || !deps || !slot.deps || deps.some((d, i) => d !== slot.deps[i])
      slot.init = true
      if (changed) { slot.deps = deps; pending.push(fn) }
    }
  }

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const id = path + '<' + (node.type.name || 'anon') + '>'
      if (!hooks.has(id)) hooks.set(id, [])
      const slots = hooks.get(id)
      let i = 0
      const prev = current
      current = { slot: () => (slots[i] = slots[i] || {}, slots[i++]) }
      const out = node.type(node.props)
      current = prev
      return renderNode(out, id)
    }
    return {
      type: node.type,
      props: node.props,
      children: node.props.children.map((c, i) => renderNode(c, path + '/' + (c && c.key != null ? 'k' + c.key : i)))
    }
  }

  function flush() {
    for (let n = 0; n < 50; n++) {
      scheduled = false
      pending = []
      rendered = renderNode(root, '')
      const effects = pending
      pending = []
      effects.forEach((fn) => fn())
      if (!scheduled) return
    }
    throw new Error('mini-react: render loop did not settle')
  }

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => { if (scheduled) flush() })
  }

  return {
    React,
    mount(element) { root = element; flush() },
    rerender(element) { root = element; flush() },
    get tree() { return rendered }
  }
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return
  fn(node)
  node.children.forEach((c) => walk(c, fn))
}

function text(node) {
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  return node.children.map(text).join('')
}

function findAll(tree, pred) {
  const out = []
  walk(tree, (n) => { if (pred(n)) out.push(n) })
  return out
}

function button(tree, label) {
  return findAll(tree, (n) => n.type === 'button' && text(n).trim() === label)[0] || null
}

function inputByLabel(tree, label) {
  const field = findAll(tree, (n) => n.type === 'div' && n.children.some((c) => c && c.type === 'label' && text(c) === label))[0]
  if (!field) return null
  return findAll(field, (n) => n.type === 'input' || n.type === 'select')[0] || null
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

module.exports = { createMiniReact, text, findAll, button, inputByLabel, settle }
