'use strict';
// Stockage : documents JSON (SQLite) + fichiers sur disque.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

function openStore(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'assets'), { recursive: true });
  const db = new Database(path.join(dataDir, 'pe.db'));
  db.pragma('journal_mode = DELETE'); // compatible avec le stockage partagé /home d'App Service
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path TEXT PRIMARY KEY, collection TEXT NOT NULL, data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS docs_collection ON docs(collection);
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user TEXT, action TEXT NOT NULL, detail TEXT
    );
  `);
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const bump = () => { const v = (+((getMeta.get('version') || {}).value || 0)) + 1; setMeta.run('version', String(v)); return v; };

  const qGet = db.prepare('SELECT * FROM docs WHERE path = ?');
  const qList = db.prepare('SELECT * FROM docs WHERE collection = ? ORDER BY path');
  const qUpsert = db.prepare(`INSERT INTO docs(path, collection, data, version, updated_at, updated_by) VALUES(@path, @collection, @data, 1, @now, @by)
    ON CONFLICT(path) DO UPDATE SET data = excluded.data, version = docs.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`);
  const qDel = db.prepare('DELETE FROM docs WHERE path = ?');
  const qAudit = db.prepare('INSERT INTO audit(at, user, action, detail) VALUES(?, ?, ?, ?)');

  const row = r => r && { path: r.path, data: JSON.parse(r.data), version: r.version, updatedAt: r.updated_at };

  const store = {
    version: () => +((getMeta.get('version') || {}).value || 0),
    get: p => row(qGet.get(p)),
    list: c => qList.all(c).map(row),
    set(p, data, by) {
      const collection = p.split('/').slice(0, -1).join('/');
      qUpsert.run({ path: p, collection, data: JSON.stringify(data), now: new Date().toISOString(), by: by || null });
      bump();
    },
    merge(p, data, by) {
      const cur = store.get(p);
      const deep = (a, b) => { const o = Object.assign({}, a); for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deep(a[k], v) : v; return o; };
      store.set(p, cur ? deep(cur.data, data) : data, by);
    },
    del(p) { const r = qDel.run(p); if (r.changes) bump(); return r.changes > 0; },
    audit(user, action, detail) { qAudit.run(new Date().toISOString(), user || null, action, detail ? JSON.stringify(detail).slice(0, 4000) : null); },

    // Fichiers
    assetPath: id => path.join(dataDir, 'assets', id),
    putAsset(buf, contentType, by) {
      const id = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(store.assetPath(id), buf);
      db.prepare('INSERT INTO assets(id, content_type, size, created_at, created_by) VALUES(?, ?, ?, ?, ?)').run(id, contentType, buf.length, new Date().toISOString(), by || null);
      return { id, url: '/_blob/' + id, sizeBytes: buf.length, contentType };
    },
    getAsset: id => /^[0-9a-f]{32}$/.test(id) ? db.prepare('SELECT * FROM assets WHERE id = ?').get(id) : null,
    deleteAsset(id) {
      const a = store.getAsset(id); if (!a) return false;
      db.prepare('DELETE FROM assets WHERE id = ?').run(id);
      try { fs.unlinkSync(store.assetPath(id)); } catch (e) { /* déjà supprimé */ }
      return true;
    },
    listAssets: () => db.prepare('SELECT id, content_type AS contentType, size AS sizeBytes, created_at AS createdAt FROM assets ORDER BY created_at').all(),
    isEmpty: () => db.prepare('SELECT COUNT(*) AS n FROM docs').get().n === 0,
    raw: db,
    close: () => db.close(),
  };
  return store;
}

module.exports = { openStore };
