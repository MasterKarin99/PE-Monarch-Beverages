/* Couche de compatibilité : fournit à la page les mêmes services (base, fichiers,
   identité, téléchargements) que sur claude.ai, mais via le serveur de l'entreprise. */
(function () {
  'use strict';
  window.PE_HOSTED = true;
  window.PE_ACCESS_LINKS = true;
  window.PE_LOGOUT_URL = '/auth/logout';
  async function api(url, opts) {
    const o = Object.assign({ credentials: 'same-origin' }, opts || {});
    o.headers = Object.assign({ 'X-PE': '1' }, o.headers || {});
    const r = await fetch(url, o);
    if (r.status === 401) { location.href = '/login'; throw { code: 'unauthenticated', message: 'Connexion requise' }; }
    if (!r.ok) { let m = ''; try { m = (await r.json()).error; } catch (e) { /* vide */ } throw { code: r.status === 403 ? 'invalid_argument' : 'unavailable', message: m || ('HTTP ' + r.status) }; }
    if (r.status === 204) return null;
    return r.json();
  }
  const meta = { fromCache: false, hasPendingWrites: false };
  const mkDoc = (path, rec) => ({ id: path.split('/').pop(), exists: !!rec, data: () => (rec ? rec.data : undefined), metadata: meta });
  const subs = new Map();
  async function fetchSub(s) {
    if (s.kind === 'doc') {
      const r = await api('/api/db/doc?path=' + encodeURIComponent(s.path));
      const snap = mkDoc(s.path, r.exists ? r : null); s.cbs.forEach(cb => cb(snap));
    } else {
      const r = await api('/api/db/list?collection=' + encodeURIComponent(s.path));
      const docs = r.docs.map(d => mkDoc(d.path, d));
      const snap = { docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] };
      s.cbs.forEach(cb => cb(snap));
    }
  }
  function subscribe(kind, path, next, err) {
    const key = kind + ':' + path; let s = subs.get(key);
    if (!s) { s = { kind, path, cbs: new Set() }; subs.set(key, s); }
    s.cbs.add(next);
    fetchSub(s).catch(e => { if (err) err({ code: e.code || 'unavailable', message: e.message }); });
    return () => s.cbs.delete(next);
  }
  let version = -1;
  async function refreshAll() { for (const s of subs.values()) if (s.cbs.size) await fetchSub(s).catch(() => { }); }
  async function poll() {
    try { const r = await api('/api/db/version'); if (r.version !== version) { const first = version === -1; version = r.version; if (!first) await refreshAll(); } } catch (e) { /* réessai */ }
    setTimeout(poll, document.hidden ? 15000 : 4000);
  }
  async function afterWrite() { try { version = (await api('/api/db/version')).version; } catch (e) { /* ignore */ } await refreshAll(); }
  const enc = encodeURIComponent;
  const rand = () => Math.random().toString(36).slice(2, 12);
  const docRef = path => ({
    id: path.split('/').pop(), path,
    get: async () => { const r = await api('/api/db/doc?path=' + enc(path)); return mkDoc(path, r.exists ? r : null); },
    set: async data => { await api('/api/db/doc?path=' + enc(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); afterWrite(); },
    update: async data => { await api('/api/db/doc?path=' + enc(path), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); afterWrite(); },
    delete: async () => { await api('/api/db/doc?path=' + enc(path), { method: 'DELETE' }); afterWrite(); },
    onSnapshot: (n, e) => subscribe('doc', path, n, e),
    collection: sub => colRef(path + '/' + sub),
  });
  const colRef = path => ({
    path,
    doc: id => docRef(path + '/' + (id || rand())),
    onSnapshot: (n, e) => subscribe('col', path, n, e),
    get: async () => { const r = await api('/api/db/list?collection=' + enc(path)); const docs = r.docs.map(d => mkDoc(d.path, d)); return { docs, size: docs.length, empty: !docs.length, metadata: meta, docChanges: () => [] }; },
    add: async d => { const ref = docRef(path + '/' + rand()); await ref.set(d); return ref; },
  });
  const db = { doc: docRef, collection: colRef };

  let me = null;
  const meP = api('/api/me').then(r => { window.PE_SMTP = !!r.smtp; return (me = r); }).catch(() => (me = { email: '', isAdmin: false, mail: { enabled: false } }));
  const user = {
    canEdit: async () => { await meP; return !!me.isAdmin; },
    can: async () => { await meP; return !!me.isAdmin; },
    isOwner: async () => { await meP; return !!me.isAdmin; },
    id: async () => { await meP; return me.email || null; },
    me: async () => { await meP; return { id: me.email || null, email: me.email || null, name: me.name || '', isOwner: !!me.isAdmin, canEdit: !!me.isAdmin, avatarUrl: '', color: '' }; },
  };
  const assets = {
    upload: async (blob, opts) => {
      const r = await fetch('/api/assets', { method: 'POST', credentials: 'same-origin', headers: { 'X-PE': '1', 'Content-Type': (opts && opts.type) || blob.type || 'application/octet-stream' }, body: blob });
      if (!r.ok) throw { code: r.status === 413 ? 'too_large' : 'upstream_error', message: 'HTTP ' + r.status };
      return r.json();
    },
    list: () => api('/api/assets'),
    delete: id => api('/api/assets/' + enc(id), { method: 'DELETE' }),
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: 'saved' };
    },
  };
  const mail = null;
  const access = {
    link: (email, days) => api('/api/access/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, days: days || 7 }) }),
  };
  window.claude = {
    use: async name => {
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'downloads') return downloads;
      if (name === 'mail') return null; // envoi par brouillons Outlook (.eml)
      if (name === 'access') { await meP; return me.isAdmin ? access : null; }
      if (name === 'assets') { await meP; return me.isAdmin ? assets : null; }
      return null;
    },
  };
})();
