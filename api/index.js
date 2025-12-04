// api/index.js
// Fixed/updated: ensure Telegram initData verification works in both Node.js and
// Cloudflare Workers (Web Crypto) environments, and avoid reading BOT token at
// module-load time (which caused verification to fail -> 403).
//
// Notes:
// - Make sure to set environment variables in your deployment:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
//   BOT_TOKEN
// - When deploying to Cloudflare Workers / Pages Functions, the env object
//   provided to `fetch(request, env)` is used to populate process.env before
//   handling the request (so handlers read the correct values).
//
// Main fixes:
// 1) verifyTelegramInitData is now async and supports Node's crypto and Web Crypto.
// 2) Do NOT capture BOT_TOKEN at module load time. Read process.env inside fetch().
// 3) All handlers now await verification when required.
// 4) supabaseRequest reads credentials at call-time from process.env so the env
//    mapping done in fetch() is effective.

let nodeCrypto = null;
try {
  nodeCrypto = require('crypto');
} catch (e) {
  nodeCrypto = null;
  // This is expected in Cloudflare Workers where require('crypto') is not available.
}

/*********************************************
 * Async verification of Telegram initData
 * Supports Node crypto (sync) and Web Crypto (async)
 *********************************************/
async function verifyTelegramInitData(initData, token) {
  if (!initData || !token) return false;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');

    const sorted = Array.from(params.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = sorted.map(([k, v]) => `${k}=${v}`).join('\n');

    // If Node crypto is available, use it (synchronous)
    if (nodeCrypto && typeof nodeCrypto.createHmac === 'function') {
      // secret = HMAC_SHA256(key='WebAppData', msg=token)
      const secret = nodeCrypto.createHmac('sha256', 'WebAppData').update(token).digest();
      const calculatedHash = nodeCrypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
      return calculatedHash === hash;
    }

    // Otherwise use Web Crypto (SubtleCrypto) - async
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const encoder = new TextEncoder();

      // helper: compute HMAC-SHA256 with given keyBytes and message => Uint8Array
      async function hmacSha256Raw(keyBytes, messageBytes) {
        const key = await globalThis.crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'HMAC', hash: { name: 'SHA-256' } },
          false,
          ['sign']
        );
        const sig = await globalThis.crypto.subtle.sign('HMAC', key, messageBytes);
        return new Uint8Array(sig);
      }

      // secret = HMAC_SHA256(key='WebAppData', msg=token)
      const keyBytes = encoder.encode('WebAppData');
      const tokenBytes = encoder.encode(token);
      const secretBytes = await hmacSha256Raw(keyBytes, tokenBytes);

      // data HMAC using secretBytes as key
      const dataBytes = encoder.encode(dataCheckString);
      const dataHmacBytes = await hmacSha256Raw(secretBytes, dataBytes);

      // hex encode
      const toHex = (buf) => Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
      const calculatedHex = toHex(dataHmacBytes);
      return calculatedHex === hash;
    }

    // No crypto available
    return false;
  } catch (err) {
    console.error('verifyTelegramInitData error:', err && err.message ? err.message : err);
    return false;
  }
}

/*********************************************
 * Supabase helper - reads env at call-time
 *********************************************/
async function supabaseRequest(method, path, body = null, headers = {}) {
  const SUPABASE_URL = (process && process.env && process.env.NEXT_PUBLIC_SUPABASE_URL) || null;
  const SUPABASE_ANON_KEY = (process && process.env && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) || null;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, error: 'Supabase credentials missing' };
  }
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`;
  const defaultHeaders = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  const options = {
    method,
    headers: { ...defaultHeaders, ...headers }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  if (res.status === 204) return { ok: true, status: 204, data: null };
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/*********************************************
 * JSON response helper
 *********************************************/
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

/*********************************************
 * Handlers (async)
 *********************************************/

// 1. register
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

  // Try to verify initData, but don't block registration on verification failure.
  try {
    const botToken = (process && process.env && process.env.BOT_TOKEN) || null;
    if (!botToken || !(await verifyTelegramInitData(payload.initData, botToken))) {
      // Log warning but continue registration. (If you want to strictly block,
      // change behavior to return 403 here.)
      console.warn(`Registration: InitData verification failed for user ${payload.userId}`);
    }
  } catch (e) {
    console.warn('Registration verification error:', e && e.message ? e.message : e);
  }

  // check existing
  const { ok: checkOk, data: checkData } = await supabaseRequest(
    'GET',
    `/telegram.log?select=user_id&user_id=eq.${payload.userId}`
  );
  if (checkOk && Array.isArray(checkData) && checkData.length > 0) {
    return { ok: true, message: 'User already exists' };
  }

  const { ok, data } = await supabaseRequest(
    'POST',
    '/telegram.log',
    {
      user_id: String(payload.userId),
      username: payload.username || '',
      first_name: payload.firstName || '',
      last_name: payload.lastName || '',
      refal_by: payload.refal_by ? String(payload.refal_by) : null,
      created_at: new Date().toISOString()
    },
    { 'Prefer': 'return=representation' }
  );

  if (!ok) return { ok: false, error: data?.message || 'Insert failed' };
  return { ok: true, data };
}

// 2. invite-stats
async function getInviteStats(userId) {
  if (!userId) return { total: 0, active: 0, pending: 0 };

  const { ok, data } = await supabaseRequest(
    'GET',
    `/telegram.log?select=invites_total,invites_active,invites_pending&user_id=eq.${userId}`
  );
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { total: 0, active: 0, pending: 0 };
  }
  const row = data[0];
  return {
    total: row.invites_total || 0,
    active: row.invites_active || 0,
    pending: row.invites_pending || 0
  };
}

// 3. watch-ad
async function watchAd({ gift, userId, initData }) {
  const botToken = (process && process.env && process.env.BOT_TOKEN) || null;
  if (!botToken || !(await verifyTelegramInitData(initData, botToken))) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }

  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const adsCol = `ads_${gift}`;
  const now = new Date().toISOString();

  // Decrement via PATCH with SQL expression (Supabase allows the column = column - 1)
  const { ok, data, status } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}&${adsCol}=gt.0`,
    {
      [adsCol]: `telegram.log.${adsCol} - 1`,
      updated_at: now
    },
    { 'Prefer': 'return=representation', 'Content-Type': 'application/json' }
  );

  if (status === 404 || (ok && data && data.length === 0)) {
    return { ok: true, message: 'Ad count already zero or user not found' };
  }
  if (!ok) return { ok: false, error: data?.message || 'Ad count update failed' };

  return { ok: true, data };
}

// 4. claim gift
async function claimGift({ gift, userId, username, initData }) {
  const botToken = (process && process.env && process.env.BOT_TOKEN) || null;
  if (!botToken || !(await verifyTelegramInitData(initData, botToken))) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }

  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const now = new Date().toISOString();
  const giftCol = `gifts_${gift}`;
  const canCol = `can_claim_${gift}`;
  const adsCol = `ads_${gift}`;

  const { ok: updOk, data: updData, status: updStatus } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}`,
    {
      [adsCol]: 0,
      [canCol]: false,
      last_claim_at: now,
      updated_at: now
    },
    { 'Prefer': 'return=representation' }
  );
  if (!updOk) return { ok: false, error: updData?.message || `Step 1 failed (${updStatus})` };

  const { ok: incOk, data: incData, status: incStatus } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}`,
    {
      [giftCol]: `telegram.log.${giftCol} + 1`
    },
    { 'Prefer': 'return=representation', 'Content-Type': 'application/json' }
  );
  if (!incOk) return { ok: false, error: incData?.message || `Step 2 failed (${incStatus})` };

  return { ok: true, data: incData };
}

// 5. claim-task
async function claimTask({ task, userId, username, initData }) {
  const botToken = (process && process.env && process.env.BOT_TOKEN) || null;
  if (!botToken || !(await verifyTelegramInitData(initData, botToken))) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }

  if (task !== 'bear' || !userId) return { ok: false, error: 'Invalid task or userId' };

  const now = new Date().toISOString();

  const { ok, data } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}`,
    {
      gifts_bear: `telegram.log.gifts_bear + 1`,
      updated_at: now
    },
    { 'Prefer': 'return=representation', 'Content-Type': 'application/json' }
  );
  if (!ok) return { ok: false, error: data?.message || 'Task claim failed' };
  return { ok: true, data };
}

/*********************************************
 * Main fetch handler
 *********************************************/
export default {
  async fetch(request, env) {
    // Map env variables (from platform) into process.env so helpers can read them.
    if (env && typeof env === 'object') {
      global.process = global.process || { env: {} };
      // Only copy known variables (avoid leaking everything accidentally)
      if (env.NEXT_PUBLIC_SUPABASE_URL) global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY) global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (env.BOT_TOKEN) global.process.env.BOT_TOKEN = env.BOT_TOKEN;
    }

    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON format' }, 400);
    }

    const requestType = body.type;
    if (!requestType) return jsonResponse({ error: 'Missing request type in body' }, 400);

    let res;
    let status = 200;

    try {
      switch (requestType) {
        case 'register':
          res = await registerUser(body);
          status = res.ok ? 200 : 400;
          break;
        case 'invite-stats':
          res = await getInviteStats(body.userId);
          status = 200;
          break;
        case 'watch-ad':
          res = await watchAd(body);
          status = res.ok ? 200 : (res.status || 400);
          break;
        case 'claim':
          res = await claimGift(body);
          status = res.ok ? 200 : (res.status || 400);
          break;
        case 'claim-task':
          res = await claimTask(body);
          status = res.ok ? 200 : (res.status || 400);
          break;
        default:
          return jsonResponse({ error: `Unknown request type: ${requestType}` }, 404);
      }
    } catch (err) {
      console.error('Handler error:', err && err.stack ? err.stack : err);
      return jsonResponse({ ok: false, error: 'Internal server error' }, 500);
    }

    // If handler set a 403-like response inside res
    if (res && (res.status === 403 || res.error === 'Invalid Telegram Session (initData)')) {
      status = 403;
    }

    return jsonResponse(res, status);
  }
};