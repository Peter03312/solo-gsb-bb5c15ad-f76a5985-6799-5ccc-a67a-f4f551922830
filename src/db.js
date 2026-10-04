'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'observatory.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,            -- 'ok' | 'rejected'
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
`);

const insertStmt = db.prepare(
  'INSERT INTO runs (created_at, status, request_json, result_json) VALUES (?, ?, ?, ?)'
);
const listStmt = db.prepare('SELECT id, created_at, status, request_json FROM runs ORDER BY id DESC LIMIT ?');
const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');

function insertRun(request, status, result) {
  const info = insertStmt.run(
    new Date().toISOString(),
    status,
    JSON.stringify(request ?? null),
    JSON.stringify(result ?? null)
  );
  return Number(info.lastInsertRowid);
}

function listRuns(limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  return listStmt.all(safeLimit).map((r) => {
    let summary = {};
    try {
      const req = JSON.parse(r.request_json);
      summary = {
        windowStart: req.windowStart,
        windowEnd: req.windowEnd,
        targetCount: Array.isArray(req.targets) ? req.targets.length : 0,
      };
    } catch (_) {
      /* 忽略摘要解析失败 */
    }
    return { id: r.id, createdAt: r.created_at, status: r.status, ...summary };
  });
}

function getRun(id) {
  const r = getStmt.get(id);
  if (!r) return null;
  return {
    id: r.id,
    createdAt: r.created_at,
    status: r.status,
    request: JSON.parse(r.request_json),
    result: JSON.parse(r.result_json),
  };
}

module.exports = { insertRun, listRuns, getRun, DB_PATH };
