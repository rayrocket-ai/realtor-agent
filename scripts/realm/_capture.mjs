// TEMPORARY discovery harness — maps the Realm search -> listing -> Online
// Appointment -> BrokerBay flow so the BrokerBay booking can be implemented
// against real selectors. This NEVER submits a booking; it only reads the DOM,
// follows the BrokerBay handoff, and screenshots. Safe to delete once mapped.
//
// Usage: node scripts/realm/_capture.mjs "85 Ronan Cres"

import { existsSync, writeFileSync } from 'node:fs';
import { launchRealmBrowser } from './browser.mjs';
import { login } from './login.mjs';

const QUERY = process.argv[2] || '85 Ronan Cres';
const STATE = '/tmp/realm-state.json';
const OUT = '/tmp';

async function dumpInteractive(page, tag) {
  const data = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const inputs = [...document.querySelectorAll('input, textarea, select')].filter(vis).map((e) => ({
      tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.name || '',
      placeholder: e.placeholder || '', aria: e.getAttribute('aria-label') || '', value: (e.value || '').slice(0, 30),
    }));
    const clickers = [...document.querySelectorAll('a, button, [role="button"], [role="option"]')].filter(vis).map((e) => ({
      tag: e.tagName.toLowerCase(), id: e.id || '',
      text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
      href: e.getAttribute('href') || '', title: e.getAttribute('title') || '', aria: e.getAttribute('aria-label') || '',
    })).filter((e) => e.text || e.title || e.aria);
    return { url: location.href, title: document.title, inputs, clickers };
  });
  console.log(`\n===== [${tag}] ${data.url}  (title: ${data.title})`);
  console.log('inputs:');
  for (const i of data.inputs) console.log('  ', JSON.stringify(i));
  console.log('clickers:');
  for (const c of data.clickers) console.log('  ', JSON.stringify(c));
  return data;
}

async function ensureSession() {
  if (existsSync(STATE)) {
    const ctx = await launchRealmBrowser({ headless: true, storageState: STATE });
    await ctx.page.goto('https://app.realmmlp.ca/dashboard', { waitUntil: 'load', timeout: 45000 }).catch(() => {});
    await ctx.page.waitForTimeout(4000);
    if (!/signin|sso\.ampre/.test(ctx.page.url())) {
      console.log('[cap] reused saved session');
      return ctx;
    }
    console.log('[cap] saved session expired, re-logging in');
    await ctx.browser.close();
  }
  const ctx = await launchRealmBrowser({ headless: true });
  await login(ctx.page);
  writeFileSync(STATE, JSON.stringify(await ctx.context.storageState()));
  await ctx.page.goto('https://app.realmmlp.ca/dashboard', { waitUntil: 'load', timeout: 45000 }).catch(() => {});
  await ctx.page.waitForTimeout(4000);
  console.log('[cap] logged in, session saved');
  return ctx;
}

(async () => {
  const { browser, context, page } = await ensureSession();
  const popups = [];
  context.on('page', (p) => { popups.push(p); console.log('[cap] >>> new tab/popup:', p.url()); });

  try {
    // 1) Open the search overlay (it's a button, not an inline field).
    const searchBtn = await page.$('button[aria-label="Open search"], button:has-text("Search REALM")');
    if (searchBtn) { await searchBtn.click(); await page.waitForTimeout(1500); }
    await page.screenshot({ path: `${OUT}/cap-02-search-open.png` }).catch(() => {});

    // 2) Type the query into whatever input appeared, then submit to the full
    //    results page (/s) which lists matching listings.
    const input = await page.$('input[placeholder*="Search" i], input[type="search"], input[autofocus], input:focus');
    if (input) {
      await input.fill(QUERY);
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/cap-03-typed.png`, fullPage: true }).catch(() => {});
      await input.press('Enter');
      await page.waitForTimeout(6000);
      await page.screenshot({ path: `${OUT}/cap-03b-results.png`, fullPage: true }).catch(() => {});
      const results = await dumpInteractive(page, 'search-results-page');

      // 3) Click the result link whose text matches the street name.
      const num = QUERY.split(/\s+/)[0];
      const street = QUERY.split(/\s+/)[1] || '';
      const match = results.clickers.find((c) =>
        /\/view\/listings\//.test(c.href) && c.text.toLowerCase().includes(num.toLowerCase()) &&
        c.text.toLowerCase().includes(street.toLowerCase()));
      if (match) {
        console.log('[cap] opening listing:', match.text, '->', match.href);
        await page.goto(`https://app.realmmlp.ca${match.href}`, { waitUntil: 'load', timeout: 45000 }).catch(() => {});
      } else {
        console.log(`[cap] no result link matched "${QUERY}" — listing dump below is whatever is on screen`);
      }
    } else {
      console.log('[cap] no search input appeared after opening overlay');
      await dumpInteractive(page, 'no-input');
    }

    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${OUT}/cap-04-listing.png`, fullPage: true }).catch(() => {});
    const listing = await dumpInteractive(page, 'listing');
    console.log('\n[cap] listing URL:', page.url());

    // 4) Find and click the showing / Online Appointment button.
    const showing = listing.clickers.find((c) =>
      /online appointment|book.*show|showing|appointment|broker\s*bay/i.test(`${c.text} ${c.title} ${c.aria}`));
    if (showing) {
      console.log('[cap] candidate showing button:', JSON.stringify(showing));
      const label = (showing.text || showing.title || showing.aria).split('\n')[0].trim();
      await page.getByText(label, { exact: false }).first().click({ timeout: 8000 })
        .catch((e) => console.log('[cap] showing click failed:', e.message));
      await page.waitForTimeout(8000);
    } else {
      console.log('[cap] NO showing/appointment button found on listing — see dump above');
    }

    // 5) Capture whatever opened (same page or BrokerBay popup).
    await page.screenshot({ path: `${OUT}/cap-05-after-showing.png`, fullPage: true }).catch(() => {});
    await dumpInteractive(page, 'after-showing-click (main page)');
    for (let i = 0; i < popups.length; i++) {
      const p = popups[i];
      await p.waitForTimeout(4000).catch(() => {});
      await p.screenshot({ path: `${OUT}/cap-06-popup-${i}.png`, fullPage: true }).catch(() => {});
      await dumpInteractive(p, `popup-${i} (likely BrokerBay)`);
    }
  } catch (err) {
    console.error('[cap] error:', err.message);
    await page.screenshot({ path: `${OUT}/cap-error.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
})();
