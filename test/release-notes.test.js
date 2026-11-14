'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const pkg = require('../package.json')

test('release notes for the current version = its CHANGELOG section, App Store safe', () => {
  const v = pkg.version
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, new RegExp(`^## ${v.replace(/\./g, '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm'), 'CHANGELOG has a dated section for the version')
  const extracted = execFileSync('sh', [path.join(root, 'scripts/release-notes.sh'), v], { encoding: 'utf8' })
  const file = fs.readFileSync(path.join(root, 'release-notes', `v${v}.md`), 'utf8')
  assert.equal(file, extracted, `release-notes/v${v}.md matches the CHANGELOG section (regenerate with npm run release-notes)`)
  assert.ok(!/^## /m.test(file), 'no second-level heading: it is the release title')
  const outsideCode = file.replace(/`[^`\n]*`/g, '')
  assert.ok(!/[<>]/.test(outsideCode), 'no raw HTML or angle brackets outside code spans')
})

test('release tooling stays out of the npm package', () => {
  for (const f of pkg.files) assert.ok(!/^(scripts|release-notes|RELEASING\.md)/.test(f), f)
})
