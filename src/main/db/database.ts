import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { MIGRATIONS, type Migration } from './migrations'

export type Db = DatabaseSync

export function openDatabase(file: string, migrations: Migration[] = MIGRATIONS): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db, migrations)
  return db
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

export function migrate(db: Db, migrations: Migration[] = MIGRATIONS): number[] {
  const applied: number[] = []
  const current = schemaVersion(db)
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString())
      db.exec(`PRAGMA user_version = ${Number(m.version)}`)
      db.exec('COMMIT')
      applied.push(m.version)
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`)
    }
  }
  return applied
}
