import Database from 'better-sqlite3'
export { SqliteChangeStore, migrate, type Migration, type SnapshotFile, type StoredChange, type ProjectContext, type ChangeStore, type SnapshotStore } from './store'

export function openDatabase(path: string, nativeBinding?: string): Database.Database {
  const database = new Database(path, nativeBinding ? { nativeBinding } : undefined)
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  return database
}