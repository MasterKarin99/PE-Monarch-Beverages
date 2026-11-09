'use strict';
// Connexion par lien envoyé par email (sans mot de passe).
// - Un lien = un jeton aléatoire à usage unique, stocké uniquement sous forme d'empreinte.
// - Ouvrir le lien affiche un bouton « Se connecter » (les antivirus de messagerie qui
//   ouvrent les liens ne consomment donc pas le jeton).
// - Session : cookie HttpOnly, SameSite=Lax, Secure en HTTPS.
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const SALT = 'pe-portail-v1:';
const hashEmail = email => sha(SALT + String(email || '').trim().toLowerCase());
const normalizeEmail = v => { const s = String(v || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length < 255 ? s : ''; };
const COOKIE = 'pe_session';

function makeAuth(cfg, store) {
  const db = store.raw;
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_tokens (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_by TEXT);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, last_seen INTEGER NOT NULL);
  `);
  const adminEmails = new Set(cfg.adminEmails.map(normalizeEmail).filter(Boolean));
  const adminDomains = cfg.adminDomains.map(d => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const isAdmin = email => adminEmails.has(email) || adminDomains.some(d => email.endsWith('@' + d));
  // Adresses autorisées : l'équipe + toutes les adresses de l'onglet Contacts
  const isKnown = email => isAdmin(email) || store.list('contacts').some(d => [...(d.data.to || []), ...(d.data.cc || [])].some(c => normalizeEmail(c.email) === email));

  function createLoginToken(email, ttlMs, by) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO login_tokens(hash, email, expires, created_by) VALUES(?, ?, ?, ?)').run(sha(token), email, Date.now() + ttlMs, by || null);
    db.prepare('DELETE FROM login_tokens WHERE expires < ?').run(Date.now() - 86400000);
    return `${cfg.publicUrl.replace(/\/$/, '')}/auth/verify?token=${encodeURIComponent(token)}`;
  }
  function consumeToken(token) {
    const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(token || ''));
    if (!row || row.used || row.expires < Date.now()) return null;
    db.prepare('UPDATE login_tokens SET used = 1 WHERE hash = ?').run(row.hash);
    return row.email;
  }
  function peekToken(token) {
    const row = db.prepare('SELECT * FROM login_tokens WHERE hash = ?').get(sha(token || ''));
    return row && !row.used && row.expires >= Date.now() ? row.email : null;
  }
  function createSession(res, email) {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now(), maxAge = cfg.sessionDays * 86400000;
    db.prepare('INSERT INTO sessions(hash, email, created, expires, last_seen) VALUES(?, ?, ?, ?, ?)').run(sha(id), email, now, now + maxAge, now);
    res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: cfg.secureCookies, maxAge, path: '/' });
  }
  function readSession(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE hash = ?').get(sha(id));
    if (!row || row.expires < Date.now()) return null;
    if (Date.now() - row.last_seen > 3600000) db.prepare('UPDATE sessions SET last_seen = ? WHERE hash = ?').run(Date.now(), row.hash);
    return row;
  }
  function destroySession(req, res) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (id) db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(id));
    res.clearCookie(COOKIE, { path: '/' });
  }
  // Les adresses retirées des Contacts perdent l'accès à leur prochaine requête
  function middleware(req, res, next) {
    const s = readSession(req);
    if (!s) return res.status(401).json({ error: 'Connexion requise' });
    const email = s.email;
    if (!isKnown(email)) { destroySession(req, res); return res.status(401).json({ error: 'Accès retiré' }); }
    req.user = { email, isAdmin: isAdmin(email), hash: hashEmail(email) };
    next();
  }
  return { middleware, createLoginToken, consumeToken, peekToken, createSession, readSession, destroySession, isKnown, isAdmin };
}

function parseCookies(h) {
  const out = {};
  String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

module.exports = { makeAuth, normalizeEmail, hashEmail };
