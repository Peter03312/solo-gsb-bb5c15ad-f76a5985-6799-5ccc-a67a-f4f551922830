// SQLite 持久化：保存每次排程请求与结果。
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

let db;

export function initDb(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      latitude      REAL NOT NULL,
      longitude     REAL NOT NULL,
      start_utc     TEXT NOT NULL,
      end_utc       TEXT NOT NULL,
      slew_min      INTEGER NOT NULL,
      request_json  TEXT NOT NULL,
      result_json   TEXT NOT NULL
    );
  `);
  return db;
}

const insertStmt = () =>
  db.prepare(`
    INSERT INTO schedules
      (latitude, longitude, start_utc, end_utc, slew_min, request_json, result_json)
    VALUES (@latitude, @longitude, @start_utc, @end_utc, @slew_min, @request_json, @result_json)
  `);

export function saveSchedule(input, result) {
  const info = insertStmt().run({
    latitude: input.latitude,
    longitude: input.longitude,
    start_utc: input.startUtc,
    end_utc: input.endUtc,
    slew_min: input.slewMin,
    request_json: JSON.stringify(input),
    result_json: JSON.stringify(result),
  });
  return info.lastInsertRowid;
}

export function getSchedule(id) {
  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    result: JSON.parse(row.result_json),
  };
}

export function recentSchedules(limit = 20) {
  return db
    .prepare('SELECT id, created_at, start_utc, end_utc FROM schedules ORDER BY id DESC LIMIT ?')
    .all(limit);
}
