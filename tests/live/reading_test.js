// Checks automatic reading (vendor quotations and price lists, office team only).
// Usage: node reading_test.js soon   (server has no Anthropic key)
//        node reading_test.js on     (server has a key, pointed at tests/live/fake_anthropic.js)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const BASE = 'http://localhost:8787';
const mode = process.argv[2];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const IMG = fs.readFileSync(path.join(__dirname, 'quote.jpg')).toString('base64');

async function login(browser, mobile) {
  const page = await (await browser.newContext()).newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
  page.on('pageerror', e => { console.log('  PAGE ERROR', e.message); fails++; });
  await page.goto(BASE);
  await page.fill('#lg_mob', mobile); await page.fill('#lg_pw', 'pass123'); await page.click('#lg_go');
  await page.waitForSelector('header.top', { timeout: 8000 });
  return page;
}
// calls /api/read the way the page does, as the signed-in person
const callRead = page => page.evaluate(async img => {
  const t = (await SB.auth.getSession()).data.session.access_token;
  const r = await fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ prompt: 'Read this quotation. Reply with JSON only.', images: [{ type: 'image/jpeg', data: img }] }) });
  return { status: r.status, body: await r.json() };
}, IMG);

(async () => {
  const browser = await chromium.launch();
  const anon = await (await browser.newContext()).request.post(BASE + '/api/read', { data: { prompt: 'x', images: [] } });
  ok(anon.status() === (mode === 'soon' ? 503 : 401), 'not signed in is refused (' + anon.status() + ')');

  const sk = await login(browser, '9000000004');
  await sk.evaluate(() => A.go('newreq'));
  ok(!(await sk.$('.slipbox')) && !(await sk.$('#slipup')), 'storekeeper has no slip photo button');
  if (mode === 'on') { const r = await callRead(sk); ok(r.status === 403, 'storekeeper cannot use reading (' + r.status + ')'); }

  const pm = await login(browser, '9000000005');
  const r = await callRead(pm);
  if (mode === 'soon') ok(r.status === 503 && r.body.error === 'not_configured', 'without a key, the server says not configured');
  else ok(r.status === 200 && Array.isArray(r.body.result?.items), 'purchase manager gets a reading back (' + r.status + ')');
  const ready = await pm.evaluate(() => !!SAMPLE);
  ok(ready === (mode === 'on'), 'page knows whether reading is switched on: ' + ready);

  await browser.close();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
