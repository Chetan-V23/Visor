import { expect, it } from 'vitest'
import { openDatabase } from './index'

it('executes real SQLite with the Node binding after the Electron rebuild', () => {
  const database = openDatabase(':memory:')
  try {
    expect(database.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 })
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1)
  } finally { database.close() }
})