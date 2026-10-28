'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const HELPER = path.join(__dirname, 'smartlife-helper.py')

function pythonBin() {
  const candidates = [
    path.join(__dirname, '..', '.venv', 'bin', 'python'),
    path.join(__dirname, '.venv', 'bin', 'python')
  ]
  return candidates.find((bin) => fs.existsSync(bin)) || 'python3'
}

function runHelper(args, options = {}) {
  const timeoutMs = options.timeoutMs || 25000
  const stdinData = options.stdin || null
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [HELPER, ...args], {
      stdio: [stdinData ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Smart Life helper timed out.'))
    }, timeoutMs)
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(stdout.trim() || '{}'))
      } catch {
        reject(new Error(stderr.trim() || stdout.trim() || 'Smart Life helper failed.'))
      }
    })
    if (stdinData) {
      child.stdin.write(typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData))
      child.stdin.end()
    }
  })
}

function startQr(userCode) {
  if (!userCode || !String(userCode).trim()) {
    return Promise.reject(new Error('Smart Life User Code is required.'))
  }
  return runHelper(['start', String(userCode).trim()])
}

function pollQr(token, userCode) {
  return runHelper(['poll', token, String(userCode).trim()])
}

function listDevices(session) {
  return runHelper(['devices'], { timeoutMs: 45000, stdin: session })
}

module.exports = { startQr, pollQr, listDevices }
