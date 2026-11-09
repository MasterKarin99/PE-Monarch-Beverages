'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { openStore } = require('./store');
const { makeAuth, normalizeEmail } = require('./auth');
const { makeMailer } = require('./mailer');

const env = process.env;
const list = v => String(v || '').split(/[,;\s]+/).filter(Boolean);
const publicUrl = (env.PUBLIC_URL || `http://localhost:${env.PORT || 8080}`).replace(/\/$/, '');
const cfg = {
  port: +env.PORT || 8080,
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  publicUrl,
  secureCookies: publicUrl.startsWith('https://'),
  sessionDays: +env.SESSION_DAYS || 30,
  adminEmails: list(env.ADMIN_EMAILS),
  adminDomains: list(env.ADMIN_DOMAINS),
  smtp: { host: env.SMTP_HOST || '', port: +env.SMTP_PORT || 587, user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || env.SMTP_USER || '' },
};
if (!cfg.adminEmails.length && !cfg.adminDomains.length) console.warn('ATTENTION : ni ADMIN_EMAILS ni ADMIN_DOMAINS ne sont définis : personne n\'aura l\'accès complet.');

const store = openStore(cfg.dataDir);
const auth = makeAuth(cfg, store);
const mailer = makeMailer(cfg.smtp);

const seedFile = env.SEED_FILE || path.join(__dirname, 'seed.json');
if (store.isEmpty() && fs.existsSync(seedFile)) {
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  for (const [p, data] of Object.entries(seed)) store.set(p, data, 'seed');
  console.log(`Données initiales chargées : ${Object.keys(seed).length} documents`);
}

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const validPath = (p, parity) => { const s = String(p || '').split('/'); return s.length <= 16 && s.every(x => SEG.test(x) && x !== '.' && x !== '..') && s.length % 2 === parity; };
const isPortal = p => p.startsWith('portal/');
const visibleTo = (u, doc) => u.isAdmin || (doc && (doc.data.access || []).includes(u.hash));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY === 'false' ? false : 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
  if (cfg.secureCookies) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
// Protection CSRF : toute requête qui modifie quelque chose doit venir de la page (en-tête X-PE)
app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/auth/') && req.headers['x-pe'] !== '1') return res.status(403).json({ error: 'Requête refusée' });
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- Connexion ----------
const loginPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
const page = (title, body) => loginPage.replace('<!--CONTENT-->', `<h1>${esc(title)}</h1>${body}`);
app.get('/login', (req, res) => {
  if (auth.readSession(req)) return res.redirect('/');
  res.type('html').send(page('Connexion', `<p>Saisissez votre adresse email : vous recevrez un lien pour vous connecter, valable 30 minutes.</p>
    <form id="f"><label for="email">Adresse email</label><input id="email" name="email" type="email" required autocomplete="email" autofocus>
    <button type="submit">Recevoir mon lien de connexion</button></form><p id="msg" role="status"></p>
    <script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;
    const r=await fetch('/auth/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('email').value})}).catch(()=>null);
    document.getElementById('msg').textContent=r&&r.ok?"Si cette adresse a accès à la plateforme, un lien de connexion vient de lui être envoyé. Pensez à vérifier les courriers indésirables.":"Une erreur est survenue, réessayez dans un instant.";b.disabled=false;});</script>`));
});
const attempts = new Map();
const limited = key => { const now = Date.now(); const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60000); a.push(now); attempts.set(key, a); return a.length > 5; };
app.post('/auth/request', express.json({ limit: '4kb' }), async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  res.json({ ok: true }); // même réponse dans tous les cas : on ne révèle pas quelles adresses ont accès
  if (!email || limited('ip:' + req.ip) || limited('em:' + email) || !auth.isKnown(email)) return;
  const url = auth.createLoginToken(email, 30 * 60000, 'self');
  if (!mailer.enabled) { console.log(`[lien de connexion] ${email} : ${url}`); return; }
  try {
    await mailer.send({ to: email, subject: 'Votre lien de connexion – Plannings éditoriaux',
      text: `Bonjour,\n\nPour vous connecter à la plateforme des plannings éditoriaux, ouvrez ce lien (valable 30 minutes, utilisable une seule fois) :\n${url}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez cet email.`,
      html: `<p>Bonjour,</p><p>Pour vous connecter à la plateforme des plannings éditoriaux, cliquez sur ce lien (valable 30 minutes, utilisable une seule fois) :</p><p><a href="${esc(url)}">Se connecter</a></p><p>Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>` });
    store.audit(email, 'login-link-sent', null);
  } catch (e) { console.error('Envoi du lien impossible', e.message); }
});
app.get('/auth/verify', (req, res) => {
  const token = String(req.query.token || '');
  if (!auth.peekToken(token)) return res.status(400).type('html').send(page('Lien expiré', `<p>Ce lien de connexion n'est plus valable (déjà utilisé ou expiré).</p><p><a class="btn" href="/login">Recevoir un nouveau lien</a></p>`));
  res.type('html').send(page('Connexion', `<p>Cliquez sur le bouton pour ouvrir la plateforme.</p><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><button type="submit">Se connecter</button></form>`));
});
app.post('/auth/verify', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  const email = auth.consumeToken(String((req.body && req.body.token) || ''));
  if (!email || !auth.isKnown(email)) return res.status(400).type('html').send(page('Lien expiré', `<p>Ce lien de connexion n'est plus valable.</p><p><a class="btn" href="/login">Recevoir un nouveau lien</a></p>`));
  auth.createSession(res, email);
  store.audit(email, 'login', null);
  res.redirect(303, '/');
});
app.get('/auth/logout', (req, res) => { auth.destroySession(req, res); res.redirect('/login'); });

// Fichiers publics (bibliothèques)
app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor'), { maxAge: '7d' }));

// Page principale : connexion obligatoire
app.get(['/', '/index.html'], (req, res) => {
  if (!auth.readSession(req)) return res.redirect('/login');
  res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('/hosted.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, '..', 'public', 'hosted.js')));

// ---------- API (connexion obligatoire) ----------
app.use(['/api', '/_blob'], auth.middleware);

app.get('/api/me', (req, res) => res.json({ email: req.user.email, isAdmin: req.user.isAdmin, smtp: mailer.enabled }));

app.get('/api/db/version', (req, res) => res.json({ version: store.version() }));
app.get('/api/db/list', (req, res) => {
  const c = String(req.query.collection || '');
  if (!validPath(c, 1)) return res.status(400).json({ error: 'Chemin invalide' });
  if (!req.user.isAdmin && c !== 'portal') return res.json({ docs: [] });
  res.json({ docs: store.list(c).filter(d => visibleTo(req.user, d)) });
});
app.get('/api/db/doc', (req, res) => {
  const p = String(req.query.path || '');
  if (!validPath(p, 0)) return res.status(400).json({ error: 'Chemin invalide' });
  if (!req.user.isAdmin && !isPortal(p)) return res.json({ exists: false });
  const d = store.get(p);
  if (!d || !visibleTo(req.user, d)) return res.json({ exists: false });
  res.json(Object.assign({ exists: true }, d));
});
const adminOnly = (req, res, next) => req.user.isAdmin ? next() : res.status(403).json({ error: 'Accès réservé à l\'équipe' });
app.put('/api/db/doc', adminOnly, express.json({ limit: '2mb' }), (req, res) => {
  const p = String(req.query.path || '');
  if (!validPath(p, 0) || !req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Requête invalide' });
  store.set(p, req.body, req.user.email); res.status(204).end();
});
app.patch('/api/db/doc', adminOnly, express.json({ limit: '2mb' }), (req, res) => {
  const p = String(req.query.path || '');
  if (!validPath(p, 0) || !store.get(p)) return res.status(400).json({ error: 'Document introuvable' });
  store.merge(p, req.body || {}, req.user.email); res.status(204).end();
});
app.delete('/api/db/doc', adminOnly, (req, res) => {
  const p = String(req.query.path || '');
  if (!validPath(p, 0)) return res.status(400).json({ error: 'Chemin invalide' });
  store.del(p); res.status(204).end();
});

app.post('/api/assets', adminOnly, express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Fichier vide' });
  res.json(store.putAsset(req.body, String(req.headers['content-type'] || 'application/octet-stream').split(';')[0], req.user.email));
});
app.get('/api/assets', adminOnly, (req, res) => {
  const assets = store.listAssets();
  res.json({ assets, usage: { files: assets.length, bytes: assets.reduce((n, a) => n + a.sizeBytes, 0), maxFiles: 100000, maxBytes: +(env.STORAGE_QUOTA_BYTES || 10 * 1024 ** 3) } });
});
app.delete('/api/assets/:id', adminOnly, (req, res) => res.json({ deleted: store.deleteAsset(req.params.id) }));
app.get('/_blob/:id', (req, res) => {
  const a = store.getAsset(req.params.id);
  if (!a) return res.status(404).end();
  if (!req.user.isAdmin) {
    const ok = store.list('portal').some(d => d.data.assetId === a.id && (d.data.access || []).includes(req.user.hash));
    if (!ok) return res.status(404).end();
    store.audit(req.user.email, 'download', { asset: a.id });
  }
  res.set({ 'Content-Type': a.content_type, 'Cache-Control': 'private, max-age=0' }).sendFile(store.assetPath(a.id));
});

// Liens d'accès générés par l'équipe (à transmettre sans passer par un email automatique)
app.post('/api/access/link', adminOnly, express.json({ limit: '4kb' }), (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'Adresse invalide' });
  if (!auth.isKnown(email)) return res.status(400).json({ error: 'Cette adresse ne figure ni dans l\'équipe ni dans les Contacts' });
  const days = Math.min(30, Math.max(1, +(req.body.days || 7)));
  const url = auth.createLoginToken(email, days * 86400000, req.user.email);
  store.audit(req.user.email, 'access-link', { for: email, days });
  res.json({ url, expiresInDays: days });
});

if (require.main === module) {
  if (process.argv[2] === 'lien') {
    // Outil de secours : node server/index.js lien adresse@exemple.com
    const email = normalizeEmail(process.argv[3]);
    if (!email || !auth.isKnown(email)) { console.error('Adresse inconnue (ni équipe, ni Contacts).'); process.exit(1); }
    console.log(auth.createLoginToken(email, 7 * 86400000, 'cli'));
    process.exit(0);
  }
  app.listen(cfg.port, () => console.log(`Plateforme PE démarrée : ${cfg.publicUrl} (port ${cfg.port}, SMTP ${mailer.enabled ? 'configuré' : 'non configuré'}, données ${cfg.dataDir})`));
}
module.exports = { app, store, cfg };
