// TEMPORARY: follow the "Online Appt" redirect into BrokerBay and map the
// booking UI. Never submits. Usage: node scripts/realm/_bb.mjs TREB-N12851994

import { existsSync, writeFileSync } from 'node:fs';
import { launchRealmBrowser } from './browser.mjs';
import { login } from './login.mjs';

const LISTING = process.argv[2] || 'TREB-N12851994';
const STATE = '/tmp/realm-state.json';
const OUT = '/tmp';

async function dump(page, tag) {
  const data = await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis).map((e) => ({
      tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
      placeholder: e.placeholder || '', aria: e.getAttribute('aria-label') || '', value: (e.value || '').slice(0, 30) }));
    const clickers = [...document.querySelectorAll('a,button,[role="button"],[role="option"],[role="tab"]')].filter(vis).map((e) => ({
      tag: e.tagName.toLowerCase(), id: e.id || '',
      text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
      href: e.getAttribute('href') || '', aria: e.getAttribute('aria-label') || '' })).filter((e) => e.text || e.aria);
    return { url: location.href, title: document.title, bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200), inputs, clickers };
  });
  console.log(`\n===== [${tag}] ${data.url}  (title: ${data.title})`);
  console.log('bodyText:', data.bodyText);
  console.log('inputs:'); for (const i of data.inputs) console.log('  ', JSON.stringify(i));
  console.log('clickers:'); for (const c of data.clickers) console.log('  ', JSON.stringify(c));
  return data;
}

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

(async () => {
  const { browser, context, page } = await ensureSession();
  const popups = [];
  context.on('page', (p) => { popups.push(p); console.log('[bb] >>> new tab/popup:', p.url()); });

  try {
    await page.goto(`https://app.realmmlp.ca/view/listings/${LISTING}?view=agent-full`, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(4000);

    console.log('[bb] clicking "Online Appt"...');
    const link = page.getByRole('link', { name: /online appt/i }).first();
    // It may open a new tab; race the popup against same-tab navigation.
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 15000 }).catch(() => null),
      link.click({ timeout: 10000 }).catch((e) => console.log('[bb] click err:', e.message)),
    ]);
    await page.waitForTimeout(8000);

    const target = popup || page;
    await target.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
    await target.waitForTimeout(6000);
    await target.screenshot({ path: `${OUT}/bb-01.png`, fullPage: true }).catch(() => {});
    await dump(target, popup ? 'brokerbay (popup)' : 'brokerbay (same tab)');

    // Capture any further popups too.
    for (let i = 0; i < popups.length; i++) {
      const p = popups[i];
      if (p === target) continue;
      await p.waitForTimeout(3000).catch(() => {});
      await p.screenshot({ path: `${OUT}/bb-extra-${i}.png`, fullPage: true }).catch(() => {});
      await dump(p, `extra-popup-${i}`);
    }
  } catch (err) {
    console.error('[bb] error:', err.message);
    await page.screenshot({ path: `${OUT}/bb-error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
