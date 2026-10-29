import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent } from '../../../shared/types.ts';

/** A single room needs durable transactions, not a separate coordination service. */
export class StageStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS stage_schema (version INTEGER NOT NULL);
      INSERT INTO stage_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM stage_schema);
      CREATE TABLE IF NOT EXISTS stage_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stage_audit (
        id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stage_audit_timestamp ON stage_audit(timestamp);
    `);
    const version = this.db.prepare('SELECT version FROM stage_schema').get() as { version: number };
    if (version.version !== 1) throw new Error('Unsupported stage database schema version.');
  }

  read<T>(): T | null {
    const row = this.db.prepare('SELECT value FROM stage_state WHERE id = 1').get() as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }

  save(value: unknown, audit: AuditEvent[] = [], olderThan?: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO stage_state(id, value) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value));
      const insert = this.db.prepare('INSERT INTO stage_audit(id, timestamp, event) VALUES(?, ?, ?)');
      for (const event of audit) insert.run(event.id, event.timestamp, JSON.stringify(event));
      if (olderThan) this.db.prepare('DELETE FROM stage_audit WHERE timestamp < ?').run(olderThan);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit(limit = 200): AuditEvent[] {
    const rows = this.db.prepare('SELECT event FROM stage_audit ORDER BY timestamp DESC, rowid DESC LIMIT ?').all(limit) as Array<{ event: string }>;
    return rows.map(row => JSON.parse(row.event) as AuditEvent);
  }

  checkpoint(): void { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  close(): void { this.db.close(); }
}
