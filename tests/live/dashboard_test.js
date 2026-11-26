// Checks the home dashboard for Raunak, Ajay and Ravi: overdue, urgent, the rest, and waiting on others.
// Run on a freshly reset database, with the mock server started without an Anthropic key.
const { chromium } = require('playwright');
const BASE = 'http://localhost:8787';
let browser, fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function login(mobile) {
  const page = await (await browser.newContext()).newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
  page.on('pageerror', e => { console.log('  PAGE ERROR', mobile, e.message); fails++; });
  await page.goto(BASE);
  await page.fill('#lg_mob', mobile); await page.fill('#lg_pw', 'pass123'); await page.click('#lg_go');
  await page.waitForSelector('header.top', { timeout: 8000 });
  return page;
}
const raise = (page, name, deadline, cat, site) => page.evaluate(([name, deadline, cat, mfg]) => {
  A.go('newreq'); draft.deadline = deadline;
  draft.items[0] = { ...draft.items[0], name, qty: 5, unit: mfg ? 'kg' : 'bags', cat, areaType: 'entire', fromList: true };
  A.submit();
}, [name, deadline, cat, site === 'KAL']).then(() => page.evaluate(() => Live.flush()));
const sec = (page, id) => page.evaluate(id => { const e = document.getElementById(id); return e ? e.innerText : null; }, id);

(async () => {
  browser = await chromium.launch();
  const sj = await login('9000000001'); // Jaigaon storekeeper
  await raise(sj, 'PPC cement', day(-1), 'Civil and structural', 'JAI');   // overdue
  await raise(sj, 'River sand', day(1), 'Civil and structural', 'JAI');    // due tomorrow, urgent
  await raise(sj, 'Wall putty', day(10), 'Paint and finishing', 'JAI');    // later
  const nos = await sj.evaluate(() => S.reqs.map(r => r.no));
  const sk = await login('9000000004'); // Kaveri Agro storekeeper
  await raise(sk, 'Caustic soda flakes', day(5), 'Cleaning chemicals', 'KAL');
  await sk.evaluate(() => { A.go('req', S.reqs[0].id); A.urgent(S.reqs[0].id); }); await sk.evaluate(() => Live.flush());

  const ajay = await login('9000000006');
  const late = await sec(ajay, 'd_late'), urg = await sec(ajay, 'd_urg'), rest = await sec(ajay, 'd_rest'), oth = await sec(ajay, 'd_oth');
  ok(late && late.includes(nos[0]) && !late.includes(nos[1]), 'Ajay: overdue requisition in Overdue');
  ok(urg && urg.includes(nos[1]), 'Ajay: requisition due tomorrow in Urgent');
  ok(rest && rest.includes(nos[2]), 'Ajay: later requisition in "Also waiting for you"');
  ok(oth && /Kaveri/.test(oth) && /Marked urgent/.test(oth), 'Ajay: Kaveri requisition with Ravi shows under Waiting on others, marked urgent');
  const tiles = await ajay.evaluate(() => [...document.querySelectorAll('.tile')].map(t => t.innerText.replace(/\s+/g, ' ')));
  ok(tiles[0].startsWith('3') && tiles[1].startsWith('1') && tiles[2].startsWith('1'), 'Ajay: tiles show 3 waiting, 1 overdue, 1 urgent: ' + tiles.join(' | '));
  await ajay.click('#d_late .row');
  ok(await ajay.evaluate(() => view.v === 'req' && !!document.querySelector('button[onclick^="A.approve"]')), 'Ajay: a card opens straight into the approval');

  const ravi = await login('9000000007');
  const rv = await ravi.evaluate(() => document.querySelector('main, #app, body').innerText);
  ok(/Kaveri/.test(await sec(ravi, 'd_urg') || '') || /Kaveri/.test(await sec(ravi, 'd_rest') || ''), 'Ravi: Kaveri requisition waiting for him');
  ok(!nos.some(n => rv.includes(n)) && !/Jaigaon/.test(rv), 'Ravi: no Jaigaon requisitions anywhere on his screen');

  const rk = await login('9000000008');
  const roth = await sec(rk, 'd_oth');
  ok(nos.every(n => roth.includes(n)), 'Raunak: all three Jaigaon requisitions under Waiting on others');
  const order = await rk.evaluate(() => [...document.querySelectorAll('#d_oth .row .mono')].map(e => e.textContent));
  ok(order.indexOf(nos[0]) < order.indexOf(nos[1]) && order.indexOf(nos[1]) < order.indexOf(nos[2]), 'Raunak: earliest deadline first');
  await rk.screenshot({ path: '/tmp/claude-0/test/dash-raunak.png', fullPage: true });
  await ajay.goto(BASE); await ajay.waitForSelector('header.top'); await ajay.screenshot({ path: '/tmp/claude-0/test/dash-ajay.png', fullPage: true });

  await browser.close();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
