// Checks reading a handwritten slip photo on the New requisition screen.
// Usage: node slip_test.js soon   (server has no Anthropic key: expect the "coming soon" note)
//        node slip_test.js on     (server has a key: expect the items to be filled in)
const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://localhost:8787';
const mode = process.argv[2];
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
  page.on('pageerror', e => { console.log('  PAGE ERROR', e.message); fails++; });

  // without signing in, the server refuses to read
  const anon = await page.request.post(BASE + '/api/read', { data: { prompt: 'x', images: [] } });
  ok(mode === 'soon' ? anon.status() === 503 : anon.status() === 401, 'reading needs a key and a signed-in person (' + anon.status() + ')');

  await page.goto(BASE);
  await page.fill('#lg_mob', '9000000004');
  await page.fill('#lg_pw', 'pass123');
  await page.click('#lg_go');
  await page.waitForSelector('header.top', { timeout: 8000 });
  await page.evaluate(() => A.go('newreq'));
  await page.setInputFiles('#slipup', path.join(__dirname, 'slip.jpg'));

  if (mode === 'soon') {
    await page.waitForFunction(() => !document.getElementById('slipst').hidden, null, { timeout: 5000 });
    const t = await page.evaluate(() => document.getElementById('slipst').textContent);
    ok(/coming soon/i.test(t), 'shows coming soon: ' + t);
  } else {
    await page.waitForFunction(() => draft && draft.items.filter(i => i.name.trim()).length >= 2, null, { timeout: 20000 }).catch(() => {});
    const items = await page.evaluate(() => draft.items.filter(i => i.name.trim()).map(i => [i.name, i.qty, i.unit, i.slipSure]));
    ok(items.length === 2 && items[0][0] === 'PVC pipe 1 inch' && items[0][1] === '20', 'items filled from the slip: ' + JSON.stringify(items));
    ok(items[1] && items[1][3] === false, 'unclear line is marked for checking');
    const msg = await page.evaluate(() => document.body.innerText);
    ok(/Read 2 items from the slip/.test(msg), 'tells the storekeeper to check the items');
  }
  await page.screenshot({ path: '/tmp/claude-0/test/slip-' + mode + '.png' });
  await browser.close();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})();
