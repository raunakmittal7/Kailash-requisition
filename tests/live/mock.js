// Tiny stand-in for Supabase (auth + PostgREST subset + storage) on a local Postgres, for testing only.
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url'), jwt = require('jsonwebtoken'), { Pool } = require('pg');
const ROOT = process.argv[2], PORT = +process.argv[3] || 8787, SECRET = 'test-secret';
const pool = new Pool({ host: '/var/tmp/kgpg', port: 5433, user: 'postgres', database: process.argv[4] || 'kg' });
const types = require('pg').types; types.setTypeParser(1082, v => v); types.setTypeParser(1700, v => parseFloat(v)); types.setTypeParser(20, v => parseInt(v));
const files = {};
async function argTypes(fn) {
  const r = await pool.query(`select p.proargnames n, array(select format_type(t,null) from unnest(p.proargtypes) t) t from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and proname=$1`, [fn]);
  return r.rows[0];
}
async function asUser(sub, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (sub) { await c.query('set local role authenticated'); await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub, role: 'authenticated' })]); }
    else await c.query('set local role anon');
    const r = await fn(c); await c.query('commit'); return r;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
function send(res, code, obj, h = {}) { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...h }); res.end(obj === undefined ? '' : JSON.stringify(obj)); }
function body(req) { return new Promise(r => { const b = []; req.on('data', d => b.push(d)); req.on('end', () => r(Buffer.concat(b))); }); }
function tok(u) {
  const t = jwt.sign({ sub: u.id, role: 'authenticated', email: u.email, aud: 'authenticated' }, SECRET, { expiresIn: 3600 });
  return { access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r.' + u.id, user: { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
}
const ident = s => '"' + s.replace(/"/g, '""') + '"';
global.LOG = [];
http.createServer(async (req, res) => {
  const u = url.parse(req.url, true), p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, undefined, { 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
  let sub = null; const a = req.headers.authorization || '';
  try { if (a.startsWith('Bearer ')) sub = jwt.verify(a.slice(7), SECRET).sub; } catch (e) {}
  try {
    if (p === '/auth/v1/token') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      if (u.query.grant_type === 'password') {
        const r = await pool.query("select id,email from auth.users where email=$1 and encrypted_password=extensions.crypt($2,encrypted_password)", [b.email, b.password]);
        if (!r.rows[0]) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(res, 200, tok(r.rows[0]));
      }
      if (u.query.grant_type === 'refresh_token') { const r = await pool.query('select id,email from auth.users where id=$1', [(b.refresh_token || '').slice(2)]); return send(res, 200, tok(r.rows[0])); }
    }
    if (p === '/auth/v1/user') {
      if (!sub) return send(res, 401, { message: 'no' });
      if (req.method === 'PUT') { const b = JSON.parse((await body(req)).toString()); if (b.password) await pool.query("update auth.users set encrypted_password=extensions.crypt($2,extensions.gen_salt('bf')) where id=$1", [sub, b.password]); }
      const r = await pool.query('select id,email from auth.users where id=$1', [sub]); return send(res, 200, tok(r.rows[0]).user);
    }
    if (p === '/auth/v1/logout') return send(res, 204);
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice(13), b = JSON.parse((await body(req)).toString() || '{}'); const at = await argTypes(fn);
      const names = at.n || [], vals = [], parts = [];
      names.forEach((n, i) => { if (!(n in b)) return; const t = at.t[i]; let v = b[n]; if (t === 'jsonb' || t === 'json') v = JSON.stringify(v); vals.push(v); parts.push(`${ident(n)} => $${vals.length}::${t}`); });
      const r = await asUser(sub, c => c.query(`select to_jsonb(${ident(fn)}(${parts.join(',')})) as v`, vals));
      LOG.push(['rpc', fn]); return send(res, 200, r.rows[0].v);
    }
    if (p.startsWith('/rest/v1/')) {
      const t = p.slice(9);
      if (req.method === 'GET') {
        const sel = u.query.select || '*'; const cols = sel === '*' ? '*' : sel.split(',').map(ident).join(',');
        let q = `select ${cols} from ${ident(t)}`;
        if (u.query.order) { const [c, d] = u.query.order.split('.'); q += ` order by ${ident(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }
        if (u.query.limit) q += ` limit ${+u.query.limit}`; if (u.query.offset) q += ` offset ${+u.query.offset}`;
        const r = await asUser(sub, c => c.query(q)); return send(res, 200, r.rows);
      }
      if (req.method === 'POST') {
        let rows = JSON.parse((await body(req)).toString()); if (!Array.isArray(rows)) rows = [rows];
        const cols = [...new Set(rows.flatMap(Object.keys))];
        let q = `insert into ${ident(t)} (${cols.map(ident).join(',')}) select ${cols.map(ident).join(',')} from jsonb_populate_recordset(null::${ident(t)}, $1)`;
        const want = (req.headers.prefer || '').includes('return=representation');
        if (want) { const s = u.query.select || '*'; q += ` returning ${s === '*' ? '*' : s.split(',').map(ident).join(',')}`; }
        const r = await asUser(sub, c => c.query(q, [JSON.stringify(rows)]));
        LOG.push(['insert', t, rows.length]); return want ? send(res, 201, r.rows) : send(res, 201);
      }
    }
    if (p.startsWith('/storage/v1/object/sign/')) { const b = JSON.parse((await body(req)).toString()); return send(res, 200, b.paths.map(x => ({ path: x, signedURL: '/storage/v1/object/files/' + x, error: null }))); }
    if (p.startsWith('/storage/v1/object/files/')) {
      const k = p.slice(26);
      if (req.method === 'POST' || req.method === 'PUT') { files[k] = await body(req); return send(res, 200, { Key: 'files/' + k }); }
      if (files[k]) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(files[k]); }
      return send(res, 404, {});
    }
    if (p === '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(`window.KG_CONFIG={url:'http://localhost:${PORT}',key:'sb_publishable_test',loginDomain:'@phone.kailasha.local'}`); }
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) return send(res, 404, {});
    const ext = path.extname(f);
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json' }[ext] || 'text/plain' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error('ERR', req.method, p, e.message); send(res, 400, { code: e.code, message: e.message, details: e.detail || null, hint: null }); }
}).listen(PORT, () => console.log('mock on', PORT));
