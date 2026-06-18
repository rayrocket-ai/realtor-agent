// TEMPORARY: open the BrokerBay booking handoff and log ALL network traffic so
// we can see which hosts the SPA needs (and which are blocked by egress).
// Never submits. Usage: node scripts/realm/_bb2.mjs [TREB-N12851994]

import { existsSync, writeFileSync } from 'node:fs';
import { launchRealmBrowser } from './browser.mjs';
import { login } from './login.mjs';

const LISTING = process.argv[2] || 'TREB-N12851994';
const STATE = '/tmp/realm-state.json';
const OUT = '/tmp';

async function ensureSession() {
  if (existsSync(STATE)) {
    const ctx = await launchRealmBrowser({ headless: true, storageState: STATE });
    await ctx.page.goto('https://app.realmmlp.ca/dashboard', { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await ctx.page.waitForTimeout(3000);
    if (!/signin|sso\.ampre/.test(ctx.page.url())) { console.log('[bb] reused session'); return ctx; }
    await ctx.browser.close();
  }
  const ctx = await launchRealmBrowser({ headless: true });
  await login(ctx.page);
  writeFileSync(STATE, JSON.stringify(await ctx.context.storageState()));
  console.log('[bb] logged in, saved session');
  return ctx;
}

const hostStats = new Map(); // host -> { ok, fail, statuses:Set, failures:[] }
function note(host, ok, status, detail) {
  if (!hostStats.has(host)) hostStats.set(host, { ok: 0, fail: 0, statuses: new Set(), failures: [] });
  const s = hostStats.get(host);
  if (ok) s.ok++; else s.fail++;
  if (status) s.statuses.add(status);
  if (!ok && detail) s.failures.push(detail);
}

function wire(p, tag) {
  p.on('console', (m) => { const t = m.text(); if (/error|fail|flag|launchdarkly|ld|timeout|init/i.test(t)) console.log(`[console:${tag}] ${m.type()}: ${t.slice(0, 200)}`); });
  p.on('pageerror', (e) => console.log(`[pageerror:${tag}] ${String(e).slice(0, 200)}`));
  p.on('requestfailed', (req) => {
    try { const u = new URL(req.url()); note(u.host, false, null, `${req.failure()?.errorText || 'failed'} ${req.method()} ${u.pathname}`); }
    catch {}
  });
  p.on('response', (res) => {
    try {
      const u = new URL(res.url());
      const st = res.status();
      note(u.host, st < 400, st, st >= 400 ? `${st} ${res.request().method()} ${u.pathname}` : null);
    } catch {}
  });
}

async function dump(page, tag) {
  const data = await page.evaluate(() => {
    const out = { url: location.href, title: document.title, frames: [] };
    const grab = (doc, label) => {
      const vis = (el) => { try { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; } catch { return false; } };
      const inputs = [...doc.querySelectorAll('input,textarea,select')].filter(vis).map((e) => ({
        tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
        placeholder: e.placeholder || '', aria: e.getAttribute('aria-label') || '' }));
      const clickers = [...doc.querySelectorAll('a,button,[role="button"],[role="option"],[role="tab"],[class*="slot" i],[class*="time" i],[class*="day" i]')].filter(vis).map((e) => ({
        tag: e.tagName.toLowerCase(), text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
        aria: e.getAttribute('aria-label') || '' })).filter((e) => e.text || e.aria);
      return { label, body: (doc.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1500), inputs, clickers };
    };
    out.frames.push(grab(document, 'main'));
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) out.frames.push(grab(f.contentDocument, `iframe src=${f.src}`)); }
      catch { out.frames.push({ label: `iframe src=${f.src} (cross-origin)`, inputs: [], clickers: [], body: '' }); }
    }
    return out;
  });
  console.log(`\n===== [${tag}] ${data.url}  (title: ${data.title})`);
  for (const fr of data.frames) {
    console.log(`  --- frame: ${fr.label}`);
    if (fr.body) console.log('    body:', fr.body);
    for (const i of fr.inputs) console.log('    input:', JSON.stringify(i));
    for (const c of fr.clickers) console.log('    click:', JSON.stringify(c));
  }
  return data;
}

(async () => {
  const { browser, context, page } = await ensureSession();
  wire(page, 'realm');
  let bbPage = null;
  context.on('page', (p) => { wire(p, 'popup'); console.log('[bb] >>> new tab/popup:', p.url()); if (/brokerbay/.test(p.url())) bbPage = p; });

  try {
    await page.goto(`https://app.realmmlp.ca/view/listings/${LISTING}?view=agent-full`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);
    console.log('[bb] clicking "Online Appt"...');
    const link = page.getByRole('link', { name: /online appt/i }).first();
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
      link.click({ timeout: 10000 }).catch((e) => console.log('[bb] click err:', e.message)),
    ]);
    const target = bbPage || popup || page;
    console.log('[bb] waiting for BrokerBay SPA to settle (up to 40s)...');
    await target.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    // Poll for the spinner to be replaced by real content.
    for (let i = 0; i < 8; i++) {
      await target.waitForTimeout(5000);
      const len = await target.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length).catch(() => 0);
      const nframes = await target.evaluate(() => document.querySelectorAll('iframe').length).catch(() => 0);
      console.log(`[bb] poll ${i}: bodyTextLen=${len} iframes=${nframes} url=${target.url()}`);
      if (len > 60 || nframes > 0) break;
    }
    await target.screenshot({ path: `${OUT}/bb2-final.png`, fullPage: true }).catch(() => {});
    await dump(target, 'brokerbay');
  } catch (err) {
    console.error('[bb] error:', err.message);
  } finally {
    console.log('\n===== NETWORK BY HOST =====');
    const rows = [...hostStats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [host, s] of rows) {
      const flag = s.fail > 0 ? '⚠️ ' : '   ';
      console.log(`${flag}${host}  ok=${s.ok} fail=${s.fail} statuses=[${[...s.statuses].join(',')}]`);
      for (const f of s.failures.slice(0, 4)) console.log(`        ${f}`);
    }
    await browser.close();
  }
})();
