#!/usr/bin/env node
'use strict'

let finished = false
const source = process.argv[3] ?? 'copilot'
function finish() {
  if (finished) return
  finished = true
  process.exitCode = 0
  process.stdin.pause()
  if (source !== 'claude-code') process.stdout.write('{}\n')
}

process.on('uncaughtException', finish)
process.on('unhandledRejection', finish)
const deadline = setTimeout(() => { finish(); process.exit(0) }, 4500)

try {
  const { forwardStdin } = require('../dist/forward.js')
  Promise.resolve(forwardStdin(process.argv[2], source)).catch(() => {}).finally(() => {
    clearTimeout(deadline)
    finish()
  })
} catch {
  clearTimeout(deadline)
  finish()
}
