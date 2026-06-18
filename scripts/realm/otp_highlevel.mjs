// Fetch the Realm login OTP from HighLevel (LeadConnector) SMS.
//
// The Realm/Keycloak MFA step texts a code to a phone number that lives in
// HighLevel. This reads that SMS back via the LeadConnector v2 API so login can
// run unattended.
//
// Required env:
//   HIGHLEVEL_API_TOKEN    Private Integration token (Conversations read scope)
//   HIGHLEVEL_LOCATION_ID  sub-account/location that owns the number
// Optional env:
//   HIGHLEVEL_API_BASE     default https://services.leadconnectorhq.com
//   HIGHLEVEL_API_VERSION  default 2021-04-15
//   REALM_OTP_REGEX        default \b(\d{6})\b   (6-digit code)
//   REALM_OTP_SENDER       substring to match the sending number/name (optional)
//
// NOTE: the exact LeadConnector response shape should be confirmed against the
// live API on first run (run this file directly to print the latest code).
// Endpoints used are the documented v2 Conversations endpoints.

const BASE = process.env.HIGHLEVEL_API_BASE || 'https://services.leadconnectorhq.com';
const VERSION = process.env.HIGHLEVEL_API_VERSION || '2021-04-15';
const OTP_REGEX = new RegExp(process.env.REALM_OTP_REGEX || '\\b(\\d{6})\\b');

function authHeaders() {
  const token = process.env.HIGHLEVEL_API_TOKEN;
  if (!token) throw new Error('Missing env var HIGHLEVEL_API_TOKEN.');
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    Accept: 'application/json',
  };
}

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HighLevel ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Return the most recent inbound SMS messages (newest first) as
// { body, ts, sender }. Looks at the most recently active conversations.
async function recentInboundSms(limit = 5) {
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!locationId) throw new Error('Missing env var HIGHLEVEL_LOCATION_ID.');

  const search = await api('/conversations/search', {
    locationId,
    sortBy: 'last_message_date',
    sortOrder: 'desc',
    limit,
  });
  const conversations = search.conversations || [];

  const out = [];
  for (const c of conversations) {
    // Pull this conversation's messages and keep inbound SMS ones.
    const msgResp = await api(`/conversations/${c.id}/messages`).catch(() => null);
    const messages = msgResp?.messages?.messages || msgResp?.messages || [];
    for (const m of messages) {
      const direction = (m.direction || '').toLowerCase();
      const type = (m.messageType || m.type || '').toUpperCase();
      if (direction === 'inbound' && type.includes('SMS')) {
        out.push({
          body: m.body || '',
          ts: new Date(m.dateAdded || m.dateUpdated || c.lastMessageDate || 0).getTime(),
          // All identifying fields for the sender, so the REALM_OTP_SENDER filter
          // can match a phone number (any format) or an alphanumeric sender ID.
          sender: [c.contactName, c.fullName, c.phone, m.from].filter(Boolean).join(' '),
        });
      }
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function extractCode(body) {
  const m = body.match(OTP_REGEX);
  return m ? m[1] : null;
}

// Does this message's sender match REALM_OTP_SENDER? Format-agnostic: if the
// filter contains enough digits, compare digits-only (so "+1 234-567-8900",
// "12345678900", and "2345678900" all match). Otherwise fall back to a
// case-insensitive text match (for alphanumeric sender IDs like "Realm").
function senderMatches(sender, filter) {
  if (!filter) return true;
  const filterDigits = filter.replace(/\D/g, '');
  if (filterDigits.length >= 4) {
    return sender.replace(/\D/g, '').includes(filterDigits);
  }
  return sender.toLowerCase().includes(filter.toLowerCase());
}

/**
 * Poll HighLevel until an OTP code arrives.
 * @param {object} opts
 * @param {number} [opts.sinceMs=0]  only accept messages newer than this epoch ms
 * @param {number} [opts.timeoutMs=120000]
 * @param {number} [opts.pollMs=5000]
 * @returns {Promise<string>} the code
 */
export async function getLatestOtp({ sinceMs = 0, timeoutMs = 120000, pollMs = 5000 } = {}) {
  const sender = process.env.REALM_OTP_SENDER;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await recentInboundSms().catch((e) => { throw e; });
    for (const m of msgs) {
      if (m.ts < sinceMs) continue;
      if (!senderMatches(m.sender, sender)) continue;
      const code = extractCode(m.body);
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error('Timed out waiting for the OTP SMS in HighLevel.');
}

// CLI: print the latest detectable code (no time filter), to verify wiring.
if (import.meta.url === `file://${process.argv[1]}`) {
  getLatestOtp({ sinceMs: 0, timeoutMs: 1, pollMs: 0 })
    .then((c) => console.log('Latest OTP code found:', c))
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}
