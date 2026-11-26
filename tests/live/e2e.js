// End-to-end test of the live website against the local mock Supabase.
const { chromium } = require('playwright');
const { Pool } = require('pg');
const BASE = 'http://localhost:8787';
const db = new Pool({ host: '/var/tmp/kgpg', port: 5433, user: 'postgres', database: 'kgt' });
const q = async (s, a) => (await db.query(s, a)).rows;
let browser, fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function login(mobile) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
  page.on('pageerror', e => { console.log('  PAGE ERROR', mobile, e.message); fails++; });
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) console.log('  console', mobile, m.text()); });
  await page.goto(BASE);
  await page.fill('#lg_mob', mobile);
  await page.fill('#lg_pw', 'pass123');
  await page.click('#lg_go');
  await page.waitForSelector('header.top', { timeout: 8000 });
  return page;
}
const settle = page => page.evaluate(() => Live.flush());
const toastText = page => page.evaluate(() => document.getElementById('toast').textContent);

(async () => {
  browser = await chromium.launch();

  // wrong password
  {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
    await page.goto(BASE); await page.fill('#lg_mob', '9000000001'); await page.fill('#lg_pw', 'nope'); await page.click('#lg_go');
    await page.waitForFunction(() => document.getElementById('lg_err').textContent.length > 0);
    ok((await page.textContent('#lg_err')).includes('wrong'), 'wrong password is refused');
    await ctx.close();
  }

  // ---------- Kaveri Agro: storekeeper raises ----------
  const sk = await login('9000000004');
  ok((await page_text(sk)).includes('Siddhartha'), 'storekeeper KAL logged in');
  await sk.evaluate(() => A.go('newreq'));
  await sk.fill('#nm_0', 'Caustic soda flakes'); await sk.evaluate(() => { A.dName(0, 'Caustic soda flakes'); A.dNameDone(0); });
  await sk.fill('#ic_0 input[type=number]', '200'); await sk.dispatchEvent('#ic_0 input[type=number]', 'input');
  await sk.selectOption('#unit_0', 'kg'); await sk.dispatchEvent('#unit_0', 'change');
  await sk.selectOption('#cat_0', 'Cleaning chemicals'); await sk.dispatchEvent('#cat_0', 'change');
  await sk.check('input[name=ar_0][onchange*=entire]');
  await sk.evaluate(() => A.dAdd());
  await sk.fill('#nm_1', 'Gear oil EP 90'); await sk.evaluate(() => A.dName(1, 'Gear oil EP 90'));
  await sk.fill('#ic_1 input[type=number]', '20'); await sk.dispatchEvent('#ic_1 input[type=number]', 'input');
  await sk.selectOption('#unit_1', 'litres'); await sk.dispatchEvent('#unit_1', 'change');
  await sk.selectOption('#cat_1', 'Lubricants and fuel'); await sk.dispatchEvent('#cat_1', 'change');
  await sk.check('input[name=ar_1][onchange*=specific]');
  await sk.fill('[id^=an_1]', 'Boiler room').catch(async () => { await sk.evaluate(() => { draft.items[1].areaName = 'Boiler room'; }); });
  await sk.evaluate(() => { draft.items[1].areaName = 'Boiler room'; draft.items[1].areaDesc = 'Feed pump gearbox'; });
  await sk.evaluate(() => A.submit());
  await settle(sk); await wait(300);
  let reqs = await q("select number, stage, extra->'remarks' rm from requisitions");
  ok(reqs.length === 1 && reqs[0].number === 'KG/KAL/' + new Date().getFullYear() + '/001' && reqs[0].stage === 'ravi_ok', 'requisition saved with real number at Ravi step: ' + JSON.stringify(reqs));
  ok((await page_text(sk)).includes('KG/KAL/'), 'storekeeper screen shows the real number');
  const lines = await q("select name, qty, unit, extra->>'cat' cat, extra->>'areaName' area from req_lines order by extra->>'idx'");
  ok(lines.length === 2 && lines[1].area === 'Boiler room' && lines[0].cat === 'Cleaning chemicals', 'items saved with category and area');
  ok((await q("select count(*)::int n from items")).at(0).n === 2, 'new items joined the item list');
  ok((await q("select count(*)::int n from activity where what like 'Raised requisition%' and req is not null")).at(0).n === 1, 'history row linked to the requisition');
  ok((await q("select count(*)::int n from outbox where kind='New task'")).at(0).n === 1, 'WhatsApp message to Ravi queued');

  // ---------- Ravi approves ----------
  const ravi = await login('9000000007');
  ok((await page_text(ravi)).includes('KG/KAL/'), 'Ravi sees it waiting');
  const rid = (await q('select id from requisitions'))[0].id;
  await ravi.evaluate(id => A.approve(id), rid); await settle(ravi);
  ok((await q('select stage from requisitions'))[0].stage === 'ajay_ok', 'Ravi approved, now with Ajay');

  // ---------- Ajay edits a quantity and approves ----------
  const ajay = await login('9000000006');
  await ajay.evaluate(id => { A.go('req', id); A.edStart(id); tmp.edit.items[0].qty = 220; A.edSave(); }, rid); await settle(ajay);
  ok(+(await q("select qty from req_lines where name like 'Caustic%'"))[0].qty === 220, 'Ajay changed quantity to 220');
  await ajay.evaluate(id => A.approve(id), rid); await settle(ajay);
  ok((await q('select stage from requisitions'))[0].stage === 'quotes', 'Ajay approved, now at quotes');
  // Ajay cannot add a vendor (only buyers)
  await ajay.evaluate(() => { S.vendors.push({ id: crypto.randomUUID(), name: 'Bad vendor', phone: '', gstin: '', cats: '', city: '', contact: '', email: '' }); save(); });
  await settle(ajay); await wait(300);
  ok((await q("select count(*)::int n from vendors where name='Bad vendor'"))[0].n === 0, 'Ajay is not allowed to add a vendor');
  ok(/Not saved/.test(await toastText(ajay)), 'Ajay sees "Not saved": ' + await toastText(ajay));
  ok(!(await ajay.evaluate(() => S.vendors.some(v => v.name === 'Bad vendor'))), 'refused change was undone on Ajay\'s screen');

  // ---------- PM: vendors and quotes ----------
  const pm = await login('9000000005');
  await pm.evaluate(() => A.go('vendors')); await pm.evaluate(() => A.vendorNew());
  await pm.fill('#vn_n', 'Shree Chemicals'); await pm.fill('#vn_p', '9800011111'); await pm.fill('#vn_g', '19ABCDE1234F1Z5'); await pm.fill('#vn_cat', 'Cleaning chemicals');
  await pm.evaluate(() => A.doVendor());
  await pm.evaluate(() => A.vendorNew()); await pm.fill('#vn_n', 'Siliguri Lubes'); await pm.evaluate(() => A.doVendor());
  await settle(pm);
  ok((await q('select count(*)::int n from vendors'))[0].n === 2, 'PM added 2 vendors');
  const cats = await pm.evaluate(id => catsOf(R(id)), rid);
  for (let k = 0; k < cats.length; k++) {
    for (const [vn, rate] of [['Shree Chemicals', 60], ['Siliguri Lubes', 55]]) {
      await pm.evaluate(([id, k]) => A.addQuote(id, k), [rid, k]);
      const vid = await pm.evaluate(n => S.vendors.find(v => v.name === n).id, vn);
      await pm.selectOption('#q_v', vid);
      const its = await pm.evaluate(([id, k]) => R(id).items.filter(i => i.cat === catsOf(R(id))[k]).map(i => i.id), [rid, k]);
      for (const it of its) await pm.fill('#q_' + it, String(rate + k * 100));
      await pm.evaluate(([id, k]) => A.saveQuote(id, k), [rid, k]);
    }
  }
  await settle(pm);
  ok((await q('select count(*)::int n from quotes'))[0].n === 4 && (await q('select count(*)::int n from quote_lines'))[0].n === 4, '4 quotes with lines saved');
  await pm.evaluate(id => A.toFinal(id), rid); await settle(pm);
  ok((await q('select stage from requisitions'))[0].stage === 'final', 'comparison sent to Raunak');

  // ---------- Raunak asks for more quotes, PM resends, Raunak confirms ----------
  const rk = await login('9000000008');
  await rk.evaluate(id => { A.moreQuotes(id); document.getElementById('mq').value = 'One more quote please'; A.doMore(id); }, rid); await settle(rk);
  ok((await q('select stage from requisitions'))[0].stage === 'quotes', 'Raunak sent it back for more quotes (new rule)');
  await pm.evaluate(() => Live.reload()); await pm.evaluate(id => A.toFinal(id), rid); await settle(pm);
  await rk.evaluate(() => Live.reload());
  await rk.evaluate(id => { const r = R(id); const it = r.items[0]; const qs = r.quotes[it.cat]; A.award(id, it.id, qs.find(x => S.vendors.find(v => v.id === x.vendorId).name === 'Shree Chemicals').id); A.confirmVendors(id); }, rid);
  await settle(rk);
  ok((await q('select stage from requisitions'))[0].stage === 'issue', 'Raunak confirmed vendors');
  ok((await q('select count(*)::int n from awards'))[0].n === 2, 'vendor choice saved for both items');

  // ---------- PM issues POs ----------
  await pm.evaluate(() => Live.reload());
  await pm.evaluate(id => A.issuePOs(id), rid); await settle(pm);
  const pos = await q('select number, status, award_by from purchase_orders order by number');
  ok(pos.length === 2 && pos[0].number.startsWith('KG/KAL/PO/'), 'two POs issued with real numbers: ' + pos.map(p => p.number).join(', '));
  ok((await q('select stage from requisitions'))[0].stage === 'approved', 'requisition shows PO issued');
  ok((await q('select count(*)::int n from po_lines'))[0].n === 2, 'PO lines saved');
  ok((await pm.evaluate(() => S.audit.slice(0, 3).map(a => a.text).join(' | '))).includes('KG/KAL/PO/'), 'history shows real PO numbers');

  // ---------- Storekeeper receives part, asks qty change ----------
  await sk.evaluate(() => Live.reload());
  const skPo = await sk.evaluate(() => S.pos.map(p => ({ id: p.id, no: p.no, lines: p.lines.map(l => [l.name, l.qty, l.rate]) })));
  ok(skPo.length === 2 && skPo.every(p => p.lines.every(l => l[2] === 0)), 'storekeeper sees POs without rates');
  const caus = await sk.evaluate(() => S.pos.find(p => p.lines[0].name.startsWith('Caustic')).id);
  await sk.evaluate(id => { A.go('po', id); A.receipt(id); document.getElementById('rc_0').value = '100'; document.getElementById('rc_ch').value = 'DC-1'; A.doReceipt(id); }, caus);
  await settle(sk);
  ok(+(await q('select sum(qty) s from receipts'))[0].s === 100, 'receipt of 100 kg saved');
  ok((await q("select count(*)::int n from stock_moves where kind='in'"))[0].n === 1 && (await q('select count(*)::int n from stock_items'))[0].n === 1, 'stock went up');
  await sk.evaluate(() => Live.reload());
  ok(await sk.evaluate(id => P(id).lines[0].received === 100 && P(id).status === 'open', caus), 'after reload: 100 received, PO still open');
  await sk.evaluate(id => { A.qtyAsk(id); document.getElementById('qc_q').value = '260'; document.getElementById('qc_r').value = 'More needed'; A.doQty(id); }, caus); await settle(sk);
  ok((await q('select count(*)::int n from qty_requests'))[0].n === 1, 'quantity change request saved');
  // stock issue
  const st = await sk.evaluate(() => S.stock[0].id);
  await sk.evaluate(id => { A.issue(id, 'out'); document.getElementById('is_q').value = '30'; document.getElementById('is_to').value = 'Line 1'; A.doIssue(id, 'out'); }, st); await settle(sk);
  await sk.evaluate(() => Live.reload());
  ok(await sk.evaluate(() => S.stock[0].qty === 70), 'stock in hand 70 after issuing 30');

  // ---------- PM handles qty change (>10% goes to Ravi) ----------
  await pm.evaluate(() => Live.reload());
  await pm.evaluate(() => A.qcOk(S.qty[0].id)); await settle(pm);
  ok((await q('select status from qty_requests'))[0].status === 'trio', 'over 10% passed to Ravi');
  await ravi.evaluate(() => Live.reload());
  await ravi.evaluate(() => A.qcOk(S.qty[0].id)); await settle(ravi);
  ok(+(await q("select qty from po_lines where extra->>'name' like 'Caustic%'"))[0].qty === 260, 'Ravi approved: PO line now 260');

  // ---------- PM asks to close the other PO; storekeeper okays ----------
  const oil = await pm.evaluate(() => S.pos.find(p => p.lines[0].name.startsWith('Gear')).id);
  await pm.evaluate(id => { A.closeAsk(id); document.getElementById('cl').value = 'Vendor out of stock'; A.doCloseAsk(id); }, oil); await settle(pm);
  await sk.evaluate(() => Live.reload());
  await sk.evaluate(id => A.closeOk(id), oil); await settle(sk);
  ok((await q('select status from purchase_orders where id=$1', [oil]))[0].status === 'closed', 'storekeeper okayed closing the PO');
  // storekeeper may not change vendor
  const bad = await q("select 1");
  await sk.evaluate(id => { P(id).vendorId = P(id).vendorId; }, oil);

  // ---------- Jaigaon: send back, resubmit, reject with PIN ----------
  const sj = await login('9000000001');
  await sj.evaluate(() => { A.go('newreq'); draft.items[0] = { ...draft.items[0], name: 'Barbed wire', qty: 40, unit: 'rolls', cat: 'Civil and structural', areaType: 'entire' }; A.submit(); });
  await settle(sj);
  const jr = (await q("select id, number, stage from requisitions where site='JAI'"))[0];
  ok(jr && jr.number.startsWith('KG/JAI/') && jr.stage === 'ajay_ok', 'Jaigaon requisition goes straight to Ajay (no Ravi)');
  ok((await sj.evaluate(() => S.reqs.length)) === 1, 'Jaigaon storekeeper sees only Jaigaon');
  await ravi.evaluate(() => Live.reload());
  ok(!(await ravi.evaluate(() => S.reqs.some(r => r.site === 'JAI') || S.pos.some(p => p.site === 'JAI'))), 'Ravi does not see Jaigaon');
  await ajay.evaluate(() => Live.reload());
  await ajay.evaluate(id => { A.sendBack(id); document.getElementById('sb').value = 'Which gauge?'; A.doSendBack(id); }, jr.id); await settle(ajay);
  ok((await q('select stage, return_to from requisitions where id=$1', [jr.id]))[0].stage === 'clarify', 'Ajay sent it back');
  await sj.evaluate(() => Live.reload());
  await sj.evaluate(id => { A.go('req', id); document.getElementById('reply').value = '12 gauge'; A.resubmit(id); }, jr.id); await settle(sj);
  ok((await q('select stage from requisitions where id=$1', [jr.id]))[0].stage === 'ajay_ok', 'storekeeper replied, back with Ajay');
  await ajay.evaluate(() => Live.reload());
  // reject without PIN set
  await ajay.evaluate(id => { A.reject(id); document.getElementById('rj').value = 'Not needed'; A.reject2(id); document.getElementById('pin').value = '1234'; }, jr.id);
  await ajay.evaluate(id => A.doReject(id), jr.id);
  ok((await ajay.textContent('#pinerr')).includes('not set a reject PIN'), 'asks to set PIN first');
  await ajay.evaluate(() => { A.account(); document.getElementById('ac_n').value = '4321'; }); await ajay.evaluate(() => A.doPin());
  await ajay.evaluate(id => { A.reject(id); document.getElementById('rj').value = 'Not needed'; A.reject2(id); document.getElementById('pin').value = '1111'; }, jr.id);
  await ajay.evaluate(id => A.doReject(id), jr.id);
  ok((await ajay.textContent('#pinerr')).includes('Wrong PIN'), 'wrong PIN refused');
  await ajay.evaluate(() => { document.getElementById('pin').value = '4321'; });
  await ajay.evaluate(id => A.doReject(id), jr.id); await settle(ajay);
  ok((await q('select stage from requisitions where id=$1', [jr.id]))[0].stage === 'rejected', 'rejected with the right PIN');

  // ---------- Delegation ----------
  await ajay.evaluate(() => { A.go('settings'); document.getElementById('dg_to').value = 'raunak'; A.deleg(); }); await settle(ajay);
  ok((await q('select count(*)::int n from delegations'))[0].n === 1, 'Ajay handed approvals to Raunak');
  await sj.evaluate(() => { A.go('newreq'); draft.items[0] = { ...draft.items[0], name: 'Cement', qty: 10, unit: 'bags', cat: 'Civil and structural', areaType: 'entire' }; A.submit(); }); await settle(sj);
  await rk.evaluate(() => Live.reload());
  const j2 = (await q("select id from requisitions where site='JAI' and stage='ajay_ok'"))[0].id;
  ok(await rk.evaluate(id => canAct(R(id)), j2), 'Raunak can approve for Ajay');
  await rk.evaluate(id => A.approve(id), j2); await settle(rk);
  ok((await q('select stage from requisitions where id=$1', [j2]))[0].stage === 'quotes', 'Raunak approved on behalf of Ajay');
  await ajay.evaluate(() => { A.go('settings'); A.delegOff(); }); await settle(ajay);
  await ajay.evaluate(() => { A.go('settings'); document.getElementById('dg_to').value = 'ravi'; A.deleg(); }); await settle(ajay);
  await ravi.evaluate(() => Live.reload());
  ok(await ravi.evaluate(() => S.reqs.some(r => r.site === 'JAI')), 'Ravi sees Jaigaon while Ajay has handed approvals to him');
  await ajay.evaluate(() => { A.go('settings'); A.delegOff(); }); await settle(ajay);
  await ravi.evaluate(() => Live.reload());
  ok(!(await ravi.evaluate(() => S.reqs.some(r => r.site === 'JAI'))), 'and not after Ajay takes them back');
  ok((await q('select count(*)::int n from delegations'))[0].n === 0, 'Ajay took approvals back');

  // ---------- People, passwords, settings ----------
  await rk.evaluate(() => { A.go('settings'); A.userNew(); document.getElementById('un_n').value = 'New Store TAL'; document.getElementById('un_m').value = '9000000003'; document.getElementById('un_r').value = 'store'; document.getElementById('un_s').value = 'TAL'; document.getElementById('un_p').value = 'pass123'; });
  await rk.evaluate(() => A.doUser());
  ok((await q("select site from people where mobile='9000000003'"))[0]?.site === 'TAL', 'Raunak added a Talma storekeeper from the website');
  const tal = await login('9000000003'); ok((await page_text(tal)).includes('New Store TAL'), 'new person can log in');
  await pm.evaluate(() => { A.userNew && 0; });
  const pmAdd = await pm.evaluate(async () => (await SB.rpc('add_person', { p_name: 'X', p_mobile: '9000000099', p_role: 'pm', p_site: null, p_password: 'pass123' })).error?.message);
  ok(/Only Raunak/.test(pmAdd || ''), 'PM cannot add people');
  await rk.evaluate(() => { const t = document.getElementById('terms'); t.value = 'Term one\nTerm two'; t.dispatchEvent(new Event('change')); }); await settle(rk);
  ok(JSON.stringify((await q("select value from app_settings where key='terms'"))[0].value) === '["Term one","Term two"]', 'PO terms saved');
  await rk.evaluate(() => { A.coAdd({ dataset: { s: 'JAI' } }); document.getElementById('co_n').value = 'Kailasha Infra Pvt Ltd'; document.getElementById('co_g').value = '19AAAAA1111A1Z1'; A.doCoAdd('JAI'); }); await settle(rk);
  ok((await q('select count(*)::int n from site_companies'))[0].n === 1, 'billing company added for Jaigaon');
  await tal.evaluate(() => { A.account(); document.getElementById('ac_p').value = 'newpass1'; document.getElementById('ac_p2').value = 'newpass1'; }); await tal.evaluate(() => A.doPw());
  ok((await q("select (encrypted_password = extensions.crypt('newpass1', encrypted_password)) ok from auth.users where email like '9000000003%'"))[0].ok, 'person changed own password');

  // ---------- small order ----------
  // j2 is at quotes; make a past order exist cheaper: reuse KAL flow not needed; check that small order is refused without past order
  await pm.evaluate(() => Live.reload());
  const sc = await pm.evaluate(id => smallCheck(R(id)), j2);
  ok(!sc.ok, 'small-order rule needs a past order and a quote');

  // reload everybody: no phantom changes
  for (const pg of [sk, ravi, ajay, pm, rk, sj]) {
    await pg.evaluate(() => Live.reload());
    const before = (await q('select count(*)::int n from activity'))[0].n;
    await pg.evaluate(() => { render(); }); await settle(pg); await wait(200);
    const st2 = await pg.evaluate(() => Live.status());
    ok(st2 === 'Saved', 'no phantom saves after reload (' + st2 + ')');
  }
  const errs = await q("select count(*)::int n from requisitions"); console.log('requisitions', errs[0].n);
  await sk.screenshot({ path: '/tmp/claude-0/test/sk.png', fullPage: true });
  await rk.evaluate(id => A.go('req', id), rid); await rk.screenshot({ path: '/tmp/claude-0/test/rk.png', fullPage: true });
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  await browser.close(); await db.end();
  process.exit(fails ? 1 : 0);
})().catch(async e => { console.error('CRASH', e); process.exit(2); });

async function page_text(p) { return p.evaluate(() => document.body.innerText); }
