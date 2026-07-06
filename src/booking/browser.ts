import fs from "node:fs";
import path from "node:path";
import { chromium, request as pwRequest, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";

/**
 * One persistent Chromium profile for all bookings. Cookies/sessions for REALM
 * and BrokerBay live in BOOKING_DATA_DIR/profile, so a completed sign-in
 * (including any one-time 2FA) survives across bookings and restarts.
 */
export async function launchBookingContext(opts?: { headless?: boolean }): Promise<BrowserContext> {
  const c = config();
  const profileDir = path.resolve(c.BOOKING_DATA_DIR, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
  // Deployment escape hatches (not in .env.example on purpose):
  //   BOOKING_CHROMIUM_PATH        use a specific Chromium binary
  //   BOOKING_PROXY                route the booking browser through a proxy
  //   BOOKING_PROXY_BRIDGE=1       tunnel page traffic through Node's HTTP stack
  //                                (for egress proxies that reject Chromium TLS)
  //   BOOKING_IGNORE_HTTPS_ERRORS  =1 only behind a TLS-intercepting proxy
  const proxyServer = process.env.BOOKING_PROXY || "";
  const useBridge = process.env.BOOKING_PROXY_BRIDGE === "1";
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts?.headless ?? c.BOOKING_HEADLESS === "1",
    executablePath: process.env.BOOKING_CHROMIUM_PATH || undefined,
    proxy: proxyServer && !useBridge ? { server: proxyServer } : undefined,
    ignoreHTTPSErrors: process.env.BOOKING_IGNORE_HTTPS_ERRORS === "1",
    viewport: { width: 1440, height: 900 },
    // Containers have tiny /dev/shm by default; Chromium crashes without this.
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
    timezoneId: c.TZ,
    userAgent: useBridge
      ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
      : undefined,
  });
  if (useBridge) await attachProxyBridge(context, proxyServer);
  return context;
}

/**
 * Route every page request through Playwright's Node-side HTTP stack instead of
 * Chromium's own networking. Needed behind egress proxies that reset Chromium's
 * TLS handshake while accepting standard clients. Redirects are replayed as
 * client-side navigations so each hop stays inside the bridge.
 */
// Cookies are deliberately NOT forwarded from the browser: the bridge's request
// context keeps the one authoritative cookie jar (persisted below), avoiding
// stale-cookie conflicts that make SSO logins loop.
const BRIDGE_KEEP_HEADERS =
  /^(user-agent|accept|accept-language|content-type|referer|origin|authorization|x-requested-with)$/i;

async function attachProxyBridge(context: BrowserContext, proxyServer: string): Promise<void> {
  const statePath = path.resolve(config().BOOKING_DATA_DIR, "bridge-state.json");
  const api = await pwRequest.newContext({
    proxy: proxyServer ? { server: proxyServer } : undefined,
    ignoreHTTPSErrors: process.env.BOOKING_IGNORE_HTTPS_ERRORS === "1",
    storageState: fs.existsSync(statePath) ? statePath : undefined,
  });
  const saveState = () => api.storageState({ path: statePath }).catch(() => undefined);
  context.on("close", () => void saveState().then(() => api.dispose().catch(() => undefined)));
  await context.route("**/*", async (route) => {
    const req = route.request();
    // The proxy only tunnels TLS; upgrade any stray http:// hops.
    const url = req.url().replace(/^http:\/\//, "https://");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(await req.allHeaders())) {
      if (BRIDGE_KEEP_HEADERS.test(k)) headers[k] = v;
    }
    try {
      const resp = await api.fetch(url, {
        method: req.method(),
        headers,
        data: req.postDataBuffer() ?? undefined,
        maxRedirects: 0,
        timeout: 60_000,
      });
      const out: Record<string, string> = {};
      let location = "";
      for (const { name, value } of resp.headersArray()) {
        // set-cookie stays out of the browser too — the api jar owns cookies.
        if (/^(content-encoding|transfer-encoding|content-length|set-cookie)$/i.test(name)) continue;
        if (name.toLowerCase() === "location") {
          location = new URL(value.replace(/^http:\/\//, "https://"), url).href;
          continue;
        }
        out[name] = value;
      }
      if (req.isNavigationRequest()) void saveState();
      if (resp.status() >= 300 && resp.status() < 400 && location && req.isNavigationRequest()) {
        // Fulfilled 3xx responses make Chromium retry outside the bridge —
        // replay the hop as a client-side navigation instead.
        out["content-type"] = "text/html";
        await route.fulfill({
          status: 200,
          headers: out,
          body: `<script>location.replace(${JSON.stringify(location)})</script>`,
        });
      } else {
        await route.fulfill({ status: resp.status(), headers: out, body: await resp.body() });
      }
    } catch {
      await route.abort("failed");
    }
  });
}

/** Where a manually supplied REALM verification code is dropped (dashboard or shell). */
export function otpFilePath(): string {
  return path.resolve(config().BOOKING_DATA_DIR, "otp.txt");
}

export function shotsDir(bookingId: string): string {
  const dir = path.resolve(config().BOOKING_DATA_DIR, "shots", bookingId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Screenshot into the booking's shots dir; returns the file name (not path). */
export async function saveShot(page: Page, bookingId: string, name: string): Promise<string | null> {
  try {
    const dir = shotsDir(bookingId);
    // Sequence from the files already there, so retries/restarts append instead of overwriting.
    const seq = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).length + 1;
    const file = `${String(seq).padStart(2, "0")}-${name.replace(/[^a-z0-9_-]/gi, "_")}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: false });
    return file;
  } catch {
    return null;
  }
}

/** List saved screenshot file names for a booking, oldest first. */
export function listShots(bookingId: string): string[] {
  try {
    return fs.readdirSync(shotsDir(bookingId)).filter((f) => f.endsWith(".png")).sort();
  } catch {
    return [];
  }
}

export function shotPath(bookingId: string, file: string): string | null {
  // Strict allow-list — these names come from URLs.
  if (!/^[a-z0-9_-]+\.png$/i.test(file) || !/^[a-f0-9-]{36}$/i.test(bookingId)) return null;
  const p = path.join(shotsDir(bookingId), file);
  return fs.existsSync(p) ? p : null;
}
