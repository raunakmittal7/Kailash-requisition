/* Kailasha Requisitions: live data layer.
 *
 * The screens (index.html) work on one in-memory object, S, exactly like the beta.
 * This file fills S from the Supabase database and, after every change, works out
 * what changed and saves only that. The database's own security rules decide what
 * each person may see and change; anything refused is undone on screen.
 */
(function () {
  'use strict';
  const CFG = window.KG_CONFIG || {};
  const DOMAIN = CFG.loginDomain || '@phone.kailasha.local';
  const TRIO = ['ajay', 'ravi', 'raunak'];
  const configured = CFG.url && CFG.key && !/PASTE/.test(CFG.key);
  const sb = configured ? supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true } }) : null;
  window.SB = sb;

  /* ---------- small helpers ---------- */
  const IST = 5.5 * 36e5;
  const ts = v => (v ? Date.parse(v) : 0);
  const dateIST = ms => new Date(ms + IST).toISOString().slice(0, 10);
  const endOfDayIST = d => Date.parse(d + 'T23:59:00+05:30');
  const clone = x => JSON.parse(JSON.stringify(x));
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  function omit(o, keys) { const r = {}; for (const k of Object.keys(o || {})) if (!keys.includes(k) && o[k] !== undefined && typeof o[k] !== 'function') r[k] = o[k]; return r; }
  const GSTIN = /^[0-9A-Z]{15}$/;
  const nn = v => (v === '' || v === undefined ? null : v);

  let meId = null;           // my auth uuid
  let myDbRole = null;       // store, pm, ajay, ravi, raunak, admin
  let keyOf = {}, idOf = {}; // trio people use their role as id on screen ('ajay', 'ravi', 'raunak')
  const key = uuid => (uuid ? keyOf[uuid] || uuid : '');
  const uuidOf = k => (k ? idOf[k] || k : null);
  let last = null;           // what the server has, as far as this screen knows: {table: Map(key -> row)}
  let pendAct = [], pendOut = [];
  let busy = false, again = false, tmr = null, offlineTry = null, waiters = [];
  const photoUrl = {};       // storage path -> signed URL

  const Live = window.Live = {
    get role() { return myDbRole; },
    get uuid() { return meId; },
    isBoss: () => ['raunak', 'admin'].includes(myDbRole),
    isBuyer: () => ['pm', 'raunak', 'admin'].includes(myDbRole),
    uuidOf, key
  };

  /* ---------- status in the header ---------- */
  let status = '';
  function setStatus(s) { status = s; const e = document.getElementById('syncst'); if (e) { e.textContent = s; e.className = 'small ' + (/Not saved|Offline/.test(s) ? 'syncbad' : 'muted'); } }
  Live.status = () => status;

  /* ---------- friendly error text ---------- */
  function errText(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || '');
    if (/Failed to fetch|NetworkError|network|Load failed/i.test(m)) return 'No connection to the server. Check the internet.';
    if (/row-level security|permission denied|42501/i.test(m) || e?.code === '42501') return 'You are not allowed to do this.';
    if (/duplicate key/i.test(m)) return 'Someone else just saved the same thing. The screen has been refreshed.';
    if (/violates check constraint/i.test(m)) return 'Some details are not in the right format.';
    if (/JWT|token/i.test(m)) return 'Your login has expired. Please log in again.';
    return m.replace(/^.*?ERROR:\s*/, '').slice(0, 220) || 'Something went wrong.';
  }
  Live.errText = errText;
  const isNetErr = e => /Failed to fetch|NetworkError|Load failed|network/i.test((e && e.message) || '');

  /* ---------- reading everything this person may see ---------- */
  async function fetchAll(table, order, opts = {}) {
    const out = [], step = 1000;
    for (let from = 0; ; from += step) {
      let q = sb.from(table).select(opts.select || '*').order(order, { ascending: !opts.desc }).range(from, from + step - 1);
      const { data, error } = await q;
      if (error) { if (opts.optional) return []; throw error; }
      out.push(...data);
      if (data.length < step || (opts.max && out.length >= opts.max)) break;
    }
    return out;
  }

  async function loadAll() {
    // On the first load after login the role is not known yet: ask for it first,
    // so that a storekeeper gets the storekeeper tables (e.g. store_po_lines) straight away.
    if (!myDbRole) {
      const { data, error } = await sb.rpc('my_role');
      if (error) throw Object.assign(error, { table: 'my_role' });
      myDbRole = data || null;
    }
    const office = !['store'].includes(myDbRole);
    const T = {};
    const jobs = {
      me: () => fetchAll('people', 'id'),
      dir: () => fetchAll('people_directory', 'id'),
      sites: () => fetchAll('sites', 'code'),
      companies: () => fetchAll('companies', 'id'),
      site_companies: () => fetchAll('site_companies', 'company'),
      categories: () => fetchAll('categories', 'id'),
      units: () => fetchAll('units', 'id'),
      areas: () => fetchAll('areas', 'id'),
      items: () => fetchAll('items', 'id'),
      settings: () => fetchAll('app_settings', 'key'),
      requisitions: () => fetchAll('requisitions', 'created_at'),
      req_lines: () => fetchAll('req_lines', 'id'),
      purchase_orders: () => fetchAll('purchase_orders', 'created_at'),
      receipts: () => fetchAll('receipts', 'at'),
      stock_items: () => fetchAll('stock_items', 'created_at'),
      stock_moves: () => fetchAll('stock_moves', 'at'),
      qty_requests: () => fetchAll('qty_requests', 'created_at'),
      activity: () => fetchAll('activity', 'id', { desc: true, max: 3000 })
    };
    if (office) Object.assign(jobs, {
      vendors: () => fetchAll('vendors', 'name'),
      vendor_aliases: () => fetchAll('vendor_aliases', 'vendor'),
      rate_lists: () => fetchAll('rate_lists', 'id'),
      contract_map: () => fetchAll('contract_map', 'list'),
      quotes: () => fetchAll('quotes', 'created_at'),
      quote_lines: () => fetchAll('quote_lines', 'quote'),
      awards: () => fetchAll('awards', 'req'),
      po_lines: () => fetchAll('po_lines', 'id'),
      delegations: () => fetchAll('delegations', 'starts'),
      outbox: () => fetchAll('outbox', 'id', { desc: true, max: 500 })
    });
    else jobs.store_po_lines = () => fetchAll('store_po_lines', 'po_line');
    await Promise.all(Object.entries(jobs).map(async ([k, f]) => { try { T[k] = await f(); } catch (e) { e.table = k; throw e; } }));
    return T;
  }

  /* ---------- database rows -> S ---------- */
  function fromRows(T) {
    keyOf = {}; idOf = {};
    const full = Object.fromEntries((T.me || []).map(p => [p.id, p]));
    const users = (T.dir || []).map(p => {
      const trio = TRIO.includes(p.role);
      const id = trio ? p.role : p.id;
      if (trio) { keyOf[p.id] = p.role; idOf[p.role] = p.id; }
      return { id, uuid: p.id, name: p.name, mobile: full[p.id]?.mobile || '', role: trio || p.role === 'admin' ? 'trio' : p.role, dbRole: p.role, site: p.site || undefined, active: p.active };
    });
    const set = Object.fromEntries((T.settings || []).map(r => [r.key, r.value]));
    const cos = (T.companies || []).map(c => ({ id: c.id, name: c.name, gstin: c.gstin || '', address: c.address || '', sites: (T.site_companies || []).filter(x => x.company === c.id).map(x => x.site) }));
    const S2 = {
      v: 4, me: key(meId), lang: localLang(), counters: {}, users, _cos: cos,
      sites: (T.sites || []).map(s => ({ code: s.code, name: s.name, type: s.kind, address: s.delivery_address || '', companies: [] })),
      cats: { re: [], mfg: [] }, units: [], unitsPending: [], areas: {}, items: [],
      areaCounts: set.areaCounts || {}, areaDismissed: set.areaDismissed || [], terms: set.terms || [], catHistory: set.catHistory || {},
      vendors: [], aliases: {}, rateLists: [], contractMap: {}, deleg: {}, _delegIds: {},
      reqs: [], pos: [], qty: [], stock: [], moves: [], audit: [], outbox: [], tally: [], companyInfo: {}
    };
    rebuildCompanies(S2);
    (T.categories || []).forEach(c => { if (S2.cats[c.kind] && !S2.cats[c.kind].includes(c.name)) S2.cats[c.kind].push(c.name); });
    (T.units || []).forEach(u => (u.permanent ? S2.units : S2.unitsPending).push(u.name));
    S2.sites.forEach(s => S2.areas[s.code] = []);
    (T.areas || []).filter(a => a.approved).forEach(a => (S2.areas[a.site] = S2.areas[a.site] || []).push(a.name));
    S2.items = (T.items || []).map(i => ({ ...i.extra, id: i.id, name: i.name, unit: i.unit || '', subUnit: i.sub_unit || '', brand: i.brand || '', type: i.kind, cat: i.extra?.cat || '', orig: i.extra?.orig || '' }));

    // vendors (the storekeeper only sees the names on their own POs)
    if (T.vendors) S2.vendors = T.vendors.map(v => ({ contact: '', city: '', cats: '', ...v.extra, id: v.id, name: v.name, phone: v.mobile || '', email: v.email || '', gstin: v.gstin || v.extra?.gstin || '' }));
    else { const seen = {}; (T.store_po_lines || []).forEach(l => { if (!seen[l.vendor]) { seen[l.vendor] = 1; S2.vendors.push({ id: l.vendor, name: l.vendor_name, phone: '', gstin: '', cats: '', city: '', contact: '' }); } }); }
    (T.vendor_aliases || []).forEach(a => { (S2.aliases[a.vendor] = S2.aliases[a.vendor] || {})[a.vendor_text] = a.item_name || ''; });
    S2.rateLists = (T.rate_lists || []).map(l => ({ title: '', rows: [], uploaded: 0, ...l.extra, id: l.id, brand: l.brand, vendorId: l.vendor || '', type: l.kind || 're', gst: l.gst_pct ?? 18, defDisc: l.default_disc || '0', disc: Array.isArray(l.group_disc) ? l.group_disc : [], validTill: l.valid_till || '' }));
    (T.contract_map || []).forEach(m => { S2.contractMap[m.list + '|' + m.item_key] = { row: m.extra?.row ?? 0, factor: m.extra?.factor || 1, sure: !!m.sure }; });
    const today = dateIST(Date.now());
    (T.delegations || []).filter(d => d.active && d.ends >= today && TRIO.includes(d.from_role)).forEach(d => { S2.deleg[d.from_role] = { to: key(d.to_person), until: endOfDayIST(d.ends) }; S2._delegIds[d.from_role] = d.id; });

    // requisitions and their items, quotes and vendor choices
    const linesBy = {};
    (T.req_lines || []).forEach(l => (linesBy[l.req] = linesBy[l.req] || []).push(l));
    const reqById = {};
    (T.requisitions || []).forEach(r => {
      const x = r.extra || {};
      const items = (linesBy[r.id] || []).sort((a, b) => (a.extra?.idx ?? 0) - (b.extra?.idx ?? 0)).map(l => {
        const e = omit(l.extra || {}, ['idx']);
        return { orig: '', subUnit: '', cat: '', brand: '', spec: '', specOrig: '', areaType: '', areaName: '', areaDesc: '', ...e, id: l.id, name: l.name, orig: l.name_hindi || '', qty: +l.qty, unit: l.unit, subUnit: l.sub_unit || '', brand: l.brand || '', spec: l.specs || '', photoPath: l.photo_path || '', photo: l.photo_path ? photoUrl[l.photo_path] || '' : '' };
      });
      const o = { remarks: [], reminded: {}, removed: [], company: '', ...x, id: r.id, no: r.number, site: r.site, createdBy: key(r.raised_by), createdAt: ts(r.created_at), deadline: x.deadline || endOfDayIST(r.deadline || dateIST(ts(r.created_at))), stage: r.stage, stageSince: x.stageSince || ts(r.created_at), returnTo: r.return_to || null, pmDecides: !!r.pm_decides, smallOrder: !!r.small_order, items, quotes: {}, award: {} };
      reqById[r.id] = o; S2.reqs.push(o);
    });
    const qlBy = {};
    (T.quote_lines || []).forEach(l => (qlBy[l.quote] = qlBy[l.quote] || []).push(l));
    (T.quotes || []).forEach(q => {
      const r = reqById[q.req]; if (!r) return;
      const x = q.extra || {}, cat = x.cat || '';
      const rates = {}; (qlBy[q.id] || []).forEach(l => rates[l.line] = +l.rate);
      (r.quotes[cat] = r.quotes[cat] || []).push({ ...omit(x, ['cat']), id: q.id, vendorId: q.vendor, gst: +q.gst_pct || 0, rates, at: x.at || ts(q.created_at) });
    });
    (T.awards || []).forEach(a => { if (reqById[a.req]) reqById[a.req].award[a.line] = a.quote; });

    // purchase orders, lines and receipts
    const recBy = {};
    (T.receipts || []).forEach(x => (recBy[x.po_line] = recBy[x.po_line] || []).push(x));
    const plBy = {};
    if (T.po_lines) T.po_lines.forEach(l => (plBy[l.po] = plBy[l.po] || []).push({ ...omit(l.extra || {}, ['idx']), _idx: l.extra?.idx ?? 0, id: l.id, itemId: l.line, qty: +l.qty, rate: +l.rate, gst: +l.gst_pct }));
    else (T.store_po_lines || []).forEach(l => (plBy[l.po] = plBy[l.po] || []).push({ name: l.item, unit: l.unit, brand: '', subUnit: '', ...omit(l.line_extra || {}, ['idx']), _idx: l.line_extra?.idx ?? 0, id: l.po_line, itemId: l.req_line, qty: +l.ordered, rate: 0, gst: 0 }));
    (T.purchase_orders || []).forEach(p => {
      const r = reqById[p.req], x = p.extra || {};
      const lines = (plBy[p.id] || []).sort((a, b) => a._idx - b._idx).map(l => { const { _idx, ...rest } = l; rest.received = (recBy[l.id] || []).reduce((s, y) => s + +y.qty, 0); return rest; });
      const groups = {};
      lines.forEach((l, i) => (recBy[l.id] || []).forEach(y => {
        const g = y.extra?.group || y.id;
        const rc = groups[g] = groups[g] || { gid: g, at: y.extra?.at || ts(y.at), by: key(y.received_by), challan: y.extra?.challan || '', lines: lines.map(() => 0), rowIds: lines.map(() => null), synced: true };
        rc.lines[i] += +y.qty; rc.rowIds[i] = y.id; if (!y.tally_synced) rc.synced = false;
      }));
      const receipts = Object.values(groups).sort((a, b) => a.at - b.at);
      const coName = cos.find(c => c.id === p.company)?.name;
      S2.pos.push({ closeReq: null, closeNote: '', cat: '', ...x, id: p.id, no: p.number, reqId: p.req, reqNo: r?.no || '', site: r?.site || x.site || '', vendorId: p.vendor, company: coName || x.company || '', status: p.status, createdAt: ts(p.created_at), lines, receipts });
    });
    S2.pos.forEach(p => p.receipts.forEach(rc => S2.tally.unshift({ id: rc.gid, at: rc.at, po: p.no, vendor: S2.vendors.find(v => v.id === p.vendorId)?.name || '', text: 'Receipt ' + rc.lines.map((q, i) => q ? `${q} ${p.lines[i].unit} ${p.lines[i].name}` : '').filter(Boolean).join(', '), status: rc.synced ? 'Posted to Tally' : 'Waiting for Tally connector' })));
    S2.tally.sort((a, b) => b.at - a.at);
    S2.qty = (T.qty_requests || []).map(q => ({ ...q.extra, id: q.id, poId: q.po, status: q.status, at: q.extra?.at || ts(q.created_at), by: q.extra?.by || key(q.created_by) }));

    // stock
    const KIND = { opening: 'Opening stock', in: 'Received', issue: 'Issued', return: 'Returned' };
    const qtyBy = {};
    S2.moves = (T.stock_moves || []).filter(m => m.stock_item).map(m => {
      const signed = m.kind === 'issue' ? -m.qty : +m.qty; qtyBy[m.stock_item] = (qtyBy[m.stock_item] || 0) + signed;
      return { id: m.id, at: m.extra?.at || ts(m.at), by: key(m.by_person), site: m.site, itemId: m.stock_item, kind: m.extra?.label || KIND[m.kind], qty: +m.qty, note: m.extra?.note || '' };
    }).sort((a, b) => b.at - a.at);
    S2.stock = (T.stock_items || []).map(s => ({ cat: '', ...s.extra, id: s.id, site: s.site, name: s.name, unit: s.unit || '', barcode: s.barcode || '', qty: Math.round((qtyBy[s.id] || 0) * 1000) / 1000 }));

    // history and messages
    const reqNo = Object.fromEntries(S2.reqs.map(r => [r.id, r.no])), poNo = Object.fromEntries(S2.pos.map(p => [p.id, p.no]));
    S2.audit = (T.activity || []).filter(a => !/^(Raised KG\/|Moved from )/.test(a.what)).map(a => ({ at: ts(a.at), by: key(a.who), text: a.what, ref: a.ref || poNo[a.po] || reqNo[a.req] || '' }));
    S2.outbox = (T.outbox || []).map(m => ({ at: ts(m.created_at), to: m.to_names || m.to_mobile || '', text: m.body || '', kind: m.kind || m.template || '' }));
    return S2;
  }

  function rebuildCompanies(S2) {
    S2.companyInfo = {};
    S2._cos.forEach(c => { S2.companyInfo[c.name] = { gstin: c.gstin, address: c.address }; });
    S2.sites.forEach(s => { s.companies = S2._cos.filter(c => c.sites.includes(s.code)).map(c => c.name); });
  }
  Live.rebuildCompanies = () => rebuildCompanies(S);

  /* ---------- S -> database rows ---------- */
  const uid2 = () => crypto.randomUUID();
  const PO_AWARD = a => (a === 'pm10k' ? 'small_order' : a === 'pm' ? 'pm' : 'raunak');
  // Each table: key columns, columns only sent when the row is new, and how to build its rows from S.
  // Order matters: a row is saved after the rows it points to.
  const TABLES = [
    { t: 'sites', key: ['code'], mode: 'update', rows: S => S.sites.map(s => ({ code: s.code, delivery_address: nn(s.address) })) },
    { t: 'companies', key: ['id'], rows: S => S._cos.map(c => ({ id: c.id, name: c.name, gstin: GSTIN.test(c.gstin || '') ? c.gstin : null, address: nn(c.address) })) },
    { t: 'site_companies', key: ['site', 'company'], mode: 'nochange', rows: S => S._cos.flatMap(c => c.sites.map(s => ({ site: s, company: c.id }))) },
    { t: 'categories', key: ['kind', 'name'], mode: 'nochange', rows: S => ['re', 'mfg'].flatMap(k => (S.cats[k] || []).map(n => ({ kind: k, name: n }))) },
    { t: 'units', key: ['name'], rows: S => [...S.units.map(n => ({ name: n, permanent: true })), ...S.unitsPending.filter(n => !S.units.includes(n)).map(n => ({ name: n, permanent: false }))] },
    { t: 'areas', key: ['site', 'name'], mode: 'nochange', rows: S => Object.entries(S.areas).flatMap(([s, l]) => l.map(n => ({ site: s, name: n, approved: true }))) },
    { t: 'items', key: ['id'], rows: S => S.items.map(i => { if (!i.id) i.id = uid2(); return { id: i.id, name: i.name, kind: i.type, unit: nn(i.unit), sub_unit: nn(i.subUnit), brand: nn(i.brand), extra: omit(i, ['id', 'name', 'type', 'unit', 'subUnit', 'brand']) }; }) },
    { t: 'app_settings', key: ['key'], mode: 'update', rows: S => [['terms', S.terms], ['areaCounts', S.areaCounts], ['areaDismissed', S.areaDismissed], ['catHistory', S.catHistory]].map(([k, v]) => ({ key: k, value: v })) },
    { t: 'vendors', key: ['id'], office: true, rows: S => S.vendors.map(v => ({ id: v.id, name: v.name, gstin: GSTIN.test(v.gstin || '') ? v.gstin : null, mobile: nn(v.phone), email: nn(v.email), extra: omit(v, ['id', 'name', 'phone', 'email']) })) },
    { t: 'vendor_aliases', key: ['vendor', 'vendor_text'], office: true, rows: S => Object.entries(S.aliases || {}).filter(([vid]) => S.vendors.some(v => v.id === vid)).flatMap(([vid, m]) => Object.entries(m).map(([vt, n]) => ({ vendor: vid, vendor_text: vt, item_name: n }))) },
    { t: 'rate_lists', key: ['id'], office: true, rows: S => S.rateLists.map(l => ({ id: l.id, brand: l.brand, vendor: nn(l.vendorId), kind: l.type, gst_pct: +l.gst || 0, valid_till: nn(l.validTill), default_disc: String(l.defDisc ?? '0'), group_disc: l.disc || [], extra: omit(l, ['id', 'brand', 'vendorId', 'type', 'gst', 'validTill', 'defDisc', 'disc']) })) },
    { t: 'contract_map', key: ['list', 'item_key'], office: true, rows: S => Object.entries(S.contractMap || {}).map(([k, m]) => { const i = k.indexOf('|'); return { list: k.slice(0, i), item_key: k.slice(i + 1), sure: !!m.sure, extra: { row: m.row, factor: m.factor || 1 } }; }).filter(r => S.rateLists.some(l => l.id === r.list)) },
    { t: 'delegations', key: ['id'], office: true, rows: S => Object.entries(S.deleg || {}).filter(([f]) => TRIO.includes(f)).map(([f, d]) => ({ id: S._delegIds[f] || (S._delegIds[f] = uid2()), from_role: f, to_person: uuidOf(d.to), ends: dateIST(d.until), active: true })) },
    { t: 'requisitions', key: ['id'], insertOnly: ['number', 'raised_by'], returning: 'id,number', rows: S => S.reqs.map(r => ({ id: r.id, number: r.no, raised_by: uuidOf(r.createdBy), site: r.site, deadline: dateIST(r.deadline), stage: r.stage, return_to: r.stage === 'clarify' ? r.returnTo : null, pm_decides: !!r.pmDecides, small_order: !!r.smallOrder, remarks: nn((r.remarks || []).slice(-1)[0]?.text), extra: omit(r, ['id', 'no', 'site', 'createdBy', 'createdAt', 'stage', 'returnTo', 'pmDecides', 'smallOrder', 'items', 'quotes', 'award']) })) },
    { t: 'req_lines', key: ['id'], insertOnly: ['req'], rows: S => S.reqs.flatMap(r => r.items.map((it, i) => ({ id: it.id, req: r.id, name: it.name, name_hindi: nn(it.orig), qty: +it.qty, unit: it.unit, sub_unit: nn(it.subUnit), brand: nn(it.brand), specs: nn(it.spec), photo_path: nn(it.photoPath), extra: { ...omit(it, ['id', 'name', 'orig', 'qty', 'unit', 'subUnit', 'brand', 'spec', 'photo', 'photoPath', '_upl']), idx: i } }))) },
    { t: 'quotes', key: ['id'], office: true, insertOnly: ['req'], rows: S => S.reqs.flatMap(r => Object.entries(r.quotes || {}).flatMap(([cat, qs]) => qs.map(q => ({ id: q.id, req: r.id, vendor: q.vendorId, gst_pct: +q.gst || 0, extra: { ...omit(q, ['id', 'vendorId', 'gst', 'rates']), cat } })))) },
    { t: 'quote_lines', key: ['quote', 'line'], office: true, rows: S => S.reqs.flatMap(r => { const ids = new Set(r.items.map(i => i.id)); return Object.values(r.quotes || {}).flat().flatMap(q => Object.entries(q.rates || {}).filter(([l, x]) => ids.has(l) && +x > 0).map(([l, x]) => ({ quote: q.id, line: l, rate: +x }))); }) },
    { t: 'awards', key: ['req', 'line'], office: true, rows: S => S.reqs.flatMap(r => { const ids = new Set(r.items.map(i => i.id)), qs = new Set(Object.values(r.quotes || {}).flat().map(q => q.id)); return Object.entries(r.award || {}).filter(([l, q]) => ids.has(l) && qs.has(q)).map(([l, q]) => ({ req: r.id, line: l, quote: q })); }) },
    { t: 'purchase_orders', key: ['id'], insertOnly: ['number', 'req', 'vendor', 'company', 'award_by'], returning: 'id,number', rows: S => S.pos.map(p => ({ id: p.id, number: p.no, req: p.reqId, vendor: p.vendorId, company: S._cos.find(c => c.name === p.company)?.id || null, award_by: PO_AWARD(p.awardBy), status: p.status, extra: omit(p, ['id', 'no', 'reqId', 'reqNo', 'vendorId', 'status', 'createdAt', 'lines', 'receipts']) })) },
    { t: 'po_lines', key: ['id'], office: true, insertOnly: ['po', 'line'], rows: S => S.pos.flatMap(p => p.lines.map((l, i) => { if (!l.id) l.id = uid2(); return { id: l.id, po: p.id, line: l.itemId, qty: +l.qty, rate: +l.rate || 0, gst_pct: +l.gst || 0, extra: { ...omit(l, ['id', 'itemId', 'qty', 'rate', 'gst', 'received']), idx: i } }; })) },
    { t: 'receipts', key: ['id'], mode: 'insert', rows: S => S.pos.flatMap(p => p.receipts.flatMap(rc => { rc.gid = rc.gid || uid2(); rc.rowIds = rc.rowIds || []; return rc.lines.map((q, i) => { if (!(+q > 0) || !p.lines[i]) return null; if (!rc.rowIds[i]) rc.rowIds[i] = uid2(); return { id: rc.rowIds[i], po_line: p.lines[i].id, qty: +q, extra: { group: rc.gid, challan: rc.challan || '', at: rc.at, idx: i } }; }).filter(Boolean); })) },
    { t: 'stock_items', key: ['id'], rows: S => S.stock.map(s => ({ id: s.id, site: s.site, name: s.name, unit: nn(s.unit), barcode: nn(s.barcode), extra: omit(s, ['id', 'site', 'name', 'unit', 'barcode', 'qty']) })) },
    { t: 'stock_moves', key: ['id'], mode: 'insert', rows: S => S.moves.map(m => ({ id: m.id, site: m.site, stock_item: m.itemId, qty: Math.abs(+m.qty), kind: { 'Opening stock': 'opening', Received: 'in', Issued: 'issue', Returned: 'return' }[m.kind] || 'in', extra: { label: m.kind, note: m.note || '', at: m.at } })) },
    { t: 'qty_requests', key: ['id'], insertOnly: ['po'], rows: S => S.qty.map(q => ({ id: q.id, po: q.poId, status: q.status, extra: omit(q, ['id', 'poId', 'status']) })) }
  ];
  const kOf = (spec, row) => spec.key.map(c => row[c]).join('\u0001');
  function snapshot(S2) {
    const out = {};
    for (const spec of TABLES) {
      if (spec.office && myDbRole === 'store') { out[spec.t] = new Map(); continue; }
      const m = new Map();
      for (const row of clone(spec.rows(S2))) m.set(kOf(spec, row), row);
      out[spec.t] = m;
    }
    return out;
  }

  /* ---------- saving ---------- */
  function schedule() { if (!last) return; clearTimeout(tmr); tmr = setTimeout(sync, 120); }
  Live.save = schedule;
  Live.flush = () => new Promise(res => { waiters.push(res); schedule(); });

  async function uploadPhotos() {
    for (const r of S.reqs) for (const it of r.items) {
      if (!it.photo || !it.photo.startsWith('data:') || it._upl === it.photo) continue;
      const path = `${r.site}/photos/${it.id}-${Date.now()}.jpg`;
      const blob = await (await fetch(it.photo)).blob();
      const { error } = await sb.storage.from('files').upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      it._upl = it.photo; it.photoPath = path; photoUrl[path] = it.photo;
    }
  }

  async function sync() {
    if (!last || !S) return;
    if (busy) { again = true; return; }
    busy = true; again = false; let ok = true, numbersChanged = false;
    try {
      setStatus('Saving…');
      await uploadPhotos();
      const cur = snapshot(S);
      // 1. new and changed rows, in order
      for (const spec of TABLES) {
        const now = cur[spec.t], was = last[spec.t];
        const adds = [], ups = [];
        for (const [k, row] of now) {
          const old = was.get(k);
          if (!old) { if (spec.mode !== 'update') adds.push([k, row]); continue; }
          if (spec.mode === 'insert' || spec.mode === 'nochange') continue;
          const set = {}, ex = {}, drop = [];
          for (const c of Object.keys(row)) {
            if (c === 'extra' || spec.key.includes(c) || (spec.insertOnly || []).includes(c)) continue;
            if (!same(row[c], old[c])) set[c] = row[c];
          }
          if (row.extra) {
            for (const c of Object.keys(row.extra)) if (!same(row.extra[c], old.extra?.[c])) ex[c] = row.extra[c];
            for (const c of Object.keys(old.extra || {})) if (!(c in row.extra)) drop.push(c);
          }
          if (Object.keys(set).length || Object.keys(ex).length || drop.length) ups.push([k, row, set, ex, drop]);
        }
        if (adds.length) {
          const rows = adds.map(([, r]) => r);
          if (spec.returning) {
            const { data, error } = await sb.from(spec.t).insert(rows).select(spec.returning);
            if (error) throw error;
            (data || []).forEach(d => { numbersChanged = applyNumber(spec.t, d) || numbersChanged; });
          } else {
            const { error } = await sb.from(spec.t).insert(rows);
            if (error) throw error;
          }
          adds.forEach(([k, r]) => was.set(k, r));
        }
        for (const [k, row, set, ex, drop] of ups) {
          const keyObj = Object.fromEntries(spec.key.map(c => [c, row[c]]));
          const { error } = await sb.rpc('app_update', { p_table: spec.t, p_key: keyObj, p_set: set, p_extra: ex, p_drop: drop });
          if (error) throw error;
          was.set(k, row);
        }
      }
      // 2. removed rows, children first
      for (const spec of [...TABLES].reverse()) {
        if (spec.mode === 'insert' || spec.mode === 'update') continue;
        const now = cur[spec.t], was = last[spec.t];
        for (const [k, row] of [...was]) {
          if (now.has(k)) continue;
          const { error } = await sb.rpc('app_delete', { p_table: spec.t, p_key: Object.fromEntries(spec.key.map(c => [c, row[c]])) });
          if (error) throw error;
          was.delete(k);
        }
      }
      // 3. history and WhatsApp messages (only once what they point to is saved)
      const savedReq = id => last.requisitions.has(id), savedPo = id => last.purchase_orders.has(id);
      const ready = pendAct.filter(a => (!a.req || savedReq(a.req)) && (!a.po || savedPo(a.po)));
      if (ready.length) {
        const rows = ready.map(a => ({ what: a.what, ref: nn(a.ref), req: a.req || null, po: a.po || null }));
        const { error } = await sb.from('activity').insert(rows);
        if (error) throw error;
        pendAct = pendAct.filter(a => !ready.includes(a));
      }
      if (pendOut.length) {
        const out = pendOut.slice();
        const { error } = await sb.from('outbox').insert(out.map(m => ({ to_names: m.to, to_people: m.people, body: m.text, kind: m.kind, to_mobile: nn(m.mobile) })));
        if (error) throw error;
        pendOut = pendOut.filter(m => !out.includes(m));
      }
      clearTimeout(offlineTry);
      setStatus('Saved');
    } catch (e) {
      ok = false;
      if (isNetErr(e)) {
        setStatus('Offline · not saved yet');
        clearTimeout(offlineTry); offlineTry = setTimeout(schedule, 8000);
      } else {
        console.error(e);
        setStatus('Not saved');
        toast('Not saved: ' + errText(e));
        pendAct = []; pendOut = [];
        await reload(true).catch(() => {});
      }
    } finally {
      busy = false;
    }
    if (numbersChanged) render();
    if (again) return sync();
    const w = waiters; waiters = []; w.forEach(f => f(ok));
  }

  // The database gives requisitions and POs their real numbers (KG/JAI/2026/001).
  function applyNumber(table, d) {
    if (table === 'requisitions') {
      const r = S.reqs.find(x => x.id === d.id); if (!r || r.no === d.number) return false;
      const old = r.no; r.no = d.number;
      S.pos.forEach(p => { if (p.reqId === r.id) p.reqNo = d.number; });
      S.audit.forEach(a => { if (a.ref === old) a.ref = d.number; });
      pendAct.forEach(a => { if (a.ref === old) a.ref = d.number; });
      if (r.createdBy === S.me) toast('Sent. Number ' + d.number);
      return true;
    }
    if (table === 'purchase_orders') {
      const p = S.pos.find(x => x.id === d.id); if (!p || p.no === d.number) return false;
      const old = p.no; p.no = d.number;
      S.audit.forEach(a => { a.text = a.text.split(old).join(d.number); if (a.ref === old) a.ref = d.number; });
      pendAct.forEach(a => { a.what = a.what.split(old).join(d.number); if (a.ref === old) a.ref = d.number; });
      pendOut.forEach(m => { m.text = m.text.split(old).join(d.number); });
      return true;
    }
    return false;
  }

  // Called by the screens' log() and send().
  Live.logged = (text, ref) => {
    const r = ref ? S.reqs.find(x => x.no === ref) : null, p = ref && !r ? S.pos.find(x => x.no === ref) : null;
    pendAct.push({ what: text, ref: ref || '', req: r?.id || p?.reqId || null, po: p?.id || null });
  };
  Live.sent = (toIds, text, kind, toText) => {
    const people = (toIds || []).map(uuidOf).filter(x => /^[0-9a-f-]{36}$/.test(x || ''));
    const mobile = toText ? (String(toText).match(/\(([^)]+)\)\s*$/) || [])[1] : null;
    pendOut.push({ to: toText || (toIds || []).map(uname).join(', '), people, text, kind, mobile: mobile ? mobile.replace(/[^\d+]/g, '') : null });
  };

  /* ---------- loading and refreshing ---------- */
  function localLang() { try { return localStorage.getItem('kg-lang') || 'en'; } catch (e) { return 'en'; } }
  Live.setLang = l => { try { localStorage.setItem('kg-lang', l); } catch (e) {} };

  async function signPhotos() {
    const need = [...new Set(S.reqs.flatMap(r => r.items.map(i => i.photoPath)).filter(p => p && !photoUrl[p]))];
    if (!need.length) return false;
    const { data, error } = await sb.storage.from('files').createSignedUrls(need, 6 * 3600);
    if (error || !data) return false;
    data.forEach(d => { if (d.signedUrl) photoUrl[d.path] = d.signedUrl; });
    S.reqs.forEach(r => r.items.forEach(i => { if (i.photoPath && photoUrl[i.photoPath] && !i.photo?.startsWith('data:')) i.photo = photoUrl[i.photoPath]; }));
    return true;
  }

  async function reload(quiet) {
    const T = await loadAll();
    const me = (T.me || []).find(p => p.id === meId);
    myDbRole = me && me.active ? me.role : null;
    const S2 = fromRows(T);
    const before = last && S ? JSON.stringify([...Object.values(snapshot(S))].map(m => [...m.values()])) : '';
    S = S2;
    last = snapshot(S);
    const changed = before !== JSON.stringify([...Object.values(last)].map(m => [...m.values()]));
    setStatus('Saved');
    if (!quiet || changed) render();
    signPhotos().then(x => { if (x) render(); }).catch(() => {});
    return changed;
  }
  Live.reload = reload;

  function idle() {
    if (busy || pendAct.length || pendOut.length || !last) return false;
    if (!document.getElementById('modal')?.hidden) return false;
    const a = document.activeElement;
    if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return false;
    if (tmp.edit) return false;
    return true;
  }
  async function refresh() {
    if (!meId || !idle()) return;
    try { const snap = JSON.stringify([...Object.values(snapshot(S))].map(m => [...m.values()])); if (snap !== JSON.stringify([...Object.values(last)].map(m => [...m.values()]))) return; await reload(true); } catch (e) { if (!isNetErr(e)) console.warn(e); }
  }
  setInterval(refresh, 30000);
  window.addEventListener('focus', () => setTimeout(refresh, 300));
  window.addEventListener('beforeunload', e => { if (busy || pendAct.length || pendOut.length) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- logging in and out ---------- */
  function emptyS() {
    return { v: 4, me: null, lang: localLang(), users: [], sites: [], _cos: [], cats: { re: [], mfg: [] }, units: [], unitsPending: [], areas: {}, items: [], areaCounts: {}, areaDismissed: [], terms: [], catHistory: {}, vendors: [], aliases: {}, rateLists: [], contractMap: {}, deleg: {}, _delegIds: {}, reqs: [], pos: [], qty: [], stock: [], moves: [], audit: [], outbox: [], tally: [], companyInfo: {}, counters: {} };
  }
  Live.emptyS = emptyS;

  async function afterLogin(session) {
    meId = session.user.id;
    showLoading('Loading your requisitions…');
    try { await reload(); }
    catch (e) { console.error(e); meId = null; last = null; await sb.auth.signOut().catch(() => {}); S = emptyS(); render(); lgErrLater(errText(e) + (e?.table ? ` (while reading ${e.table}: ${e.message || ''})` : '')); return; }
    if (!myDbRole) {
      await sb.auth.signOut(); meId = null; last = null; S = emptyS(); render();
      lgErrLater('This login is not set up yet, or it has been switched off. Please ask Raunak.');
      return;
    }
    view = { v: 'home' };
    render();
  }
  function lgErrLater(m) { setTimeout(() => { const e = document.getElementById('lg_err'); if (e) e.textContent = m; }, 30); }
  function showLoading(t) { const a = document.getElementById('app'); if (a) a.innerHTML = `<div class="login"><div class="lcard"><div class="logo"><b>KG</b><span>Kailasha Group</span></div><p class="muted">${esc(t)}</p></div></div>`; }

  Live.login = async (mobile, password) => {
    const { data, error } = await sb.auth.signInWithPassword({ email: mobile + DOMAIN, password });
    if (error) return /invalid/i.test(error.message) ? 'Mobile number or password is wrong.' : errText(error);
    await afterLogin(data.session);
    return null;
  };
  Live.logout = async () => {
    if (busy || pendAct.length) await Live.flush();
    await sb.auth.signOut().catch(() => {});
    meId = null; myDbRole = null; last = null; S = emptyS(); view = { v: 'home' }; draft = null; render();
  };

  Live.boot = async () => {
    S = emptyS();
    if (!configured) { document.getElementById('app').innerHTML = '<div class="login"><div class="lcard"><h1>Almost ready</h1><p class="muted">The database key has not been added to config.js yet.</p></div></div>'; return; }
    showLoading('Opening…');
    const { data } = await sb.auth.getSession();
    if (data?.session) await afterLogin(data.session);
    else render();
  };
})();
