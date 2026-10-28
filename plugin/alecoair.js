'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const HELPER = path.join(__dirname, 'alecoair-helper.py')

function pythonBin() {
  const candidates = [
    path.join(__dirname, '..', '.venv', 'bin', 'python'),
    path.join(__dirname, '.venv', 'bin', 'python')
  ]
  return candidates.find((bin) => fs.existsSync(bin)) || 'python3'
}

function login(body) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [HELPER, 'login'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('AlecoAir login timed out.'))
    }, 30000)
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
        reject(new Error(stderr.trim() || stdout.trim() || 'AlecoAir login failed.'))
      }
    })
    child.stdin.write(JSON.stringify(body || {}))
    child.stdin.end()
  })
}

module.exports = { login }
