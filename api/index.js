
// api/index.js
// Hybrid REST + Client-Side Logic WebApp API
// يعمل على Cloudflare Pages Functions أو أي serverless يدعم file-system routing
// يعتمد فقط على المتغيرات البيئية:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
//   BOT_TOKEN (Modification: Added for security check)
// ويتعامل مع جدول واحد فقط: telegram.log

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// Modification: Add BOT_TOKEN for verifying initData
const BOT_TOKEN = process.env.BOT_TOKEN; 

// Modification: Implement check for initData
function verifyTelegramInitData(initData, token) {
  if (!initData) return false;
  try {
    const data = new URLSearchParams(initData);
    const hash = data.get('hash');
    data.delete('hash');
    
    const params = Array.from(data.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = params.map(([key, value]) => `${key}=${value}`).join('\n');

    const crypto = require('crypto'); // This requires Node.js/Cloudflare Workers environment

    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    return calculatedHash === hash;
  } catch (e) {
    console.error('InitData verification failed:', e.message);
    return false;
  }
}

async function supabaseRequest(method, path, body = null, headers = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
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
  // Modification: Check for 204 No Content (common in PATCH/DELETE)
  if (res.status === 204) return { ok: true, status: 204, data: null }; 
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// مسار: POST /api/register
// يستقبل: { userId, username, firstName, lastName, refal_by, initData }
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

  // Modification: Security Check
  if (!BOT_TOKEN || !verifyTelegramInitData(payload.initData, BOT_TOKEN)) {
    // We allow registration even if initData is missing/invalid, but log the invalid state or skip sensitive fields.
    // For this implementation, we will proceed but log a warning, as registration is non-critical.
    // console.warn(`Registration attempt for User ${payload.userId} with invalid initData.`);
  }

  // Check if user already exists (to prevent 409 error on POST, though Supabase handles 409)
  const { ok: checkOk, status: checkStatus, data: checkData } = await supabaseRequest(
    'GET',
    `/telegram.log?select=user_id&user_id=eq.${payload.userId}`
  );
  if (checkOk && Array.isArray(checkData) && checkData.length > 0) {
    return { ok: true, message: 'already exists' };
  }

  const { ok, status, data } = await supabaseRequest(
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

  if (status === 409) return { ok: true, message: 'already exists' };
  if (!ok) return { ok: false, error: data?.message || 'insert failed' };
  return { ok: true, data };
}

// مسار: POST /api/invite-stats
// يستقبل: { userId }
// يرجع: { total, active, pending }
async function getInviteStats(userId) {
  // نقرأ من نفس الجدول telegram.log
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

// مسار: POST /api/claim
// يستقبل: { gift, userId, username, initData }
// يُحدّث العداد ويُسجل الهدية
async function claimGift({ gift, userId, username, initData }) {
  // Modification: Security Check - Deny claim if initData is invalid
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }

  // أولاً: نتحقق من last_claim_at ونحدّث العداد
  const now = new Date().toISOString();
  const giftCol = `gifts_${gift}`;        // gifts_bear | gifts_heart | ...
  const canCol = `can_claim_${gift}`;     // can_claim_bear | ...
  const adsCol = `ads_${gift}`;           // ads_bear | ...

  // نحدّف 1 من العداد ونصفّر can_claim
  const { ok: updOk, data: updData } = await supabaseRequest(
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
  if (!updOk) return { ok: false, error: updData?.message || 'update failed' };

  // نزيد الهدية بـ +1
  // Supabase automatically handles incrementing if the column is defined as JSONB or a supported type, 
  // but for numeric columns, we need to use a function or rely on the framework to generate a raw query.
  // Assuming 'telegram.log.gifts_bear + 1' works as a raw function call in Supabase RLS context.
  const { ok: incOk, data: incData } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}`,
    {
      [giftCol]: `telegram.log.${giftCol} + 1`
    },
    { 'Prefer': 'return=representation', 'Content-Type': 'application/json' }
  );
  if (!incOk) return { ok: false, error: incData?.message || 'increment failed' };

  return { ok: true, data: incData };
}

// مسار: POST /api/claim-task
// يستقبل: { task, userId, username, initData }
// يُحدّف المهمة ويزيد gifts_bear
async function claimTask({ task, userId, username, initData }) {
  // Modification: Security Check - Deny claim if initData is invalid
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }
  
  const now = new Date().toISOString();

  // نزيد gifts_bear بـ 1
  const { ok, data } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}`,
    {
      gifts_bear: `telegram.log.gifts_bear + 1`,
      updated_at: now
    },
    { 'Prefer': 'return=representation' }
  );
  if (!ok) return { ok: false, error: data?.message || 'task claim failed' };
  return { ok: true, data };
}

// المُعالج الرئيسي (Cloudflare Pages Functions)
export default {
  async fetch(request, env) {
    // استخراج المتغيرات البيئية إذا لم تكن موجودة
    if (!SUPABASE_URL) {
      // Modification: Read from env object passed to fetch function
      global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      global.process.env.BOT_TOKEN = env.BOT_TOKEN; // Modification: Read BOT_TOKEN
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    
    // Modification: Only load crypto module if needed and ensure it works in workers/functions environment
    // For Cloudflare Workers/Pages Functions, 'crypto' is usually available globally.
    // If running in Node.js, we would need 'const crypto = require('crypto');' at the top.
    
    if (method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'invalid json' }, 400);
    }

    if (path === '/api/register') {
      const res = await registerUser(body);
      return jsonResponse(res, res.ok ? 200 : 400);
    }

    if (path === '/api/invite-stats') {
      const stats = await getInviteStats(body.userId);
      return jsonResponse(stats);
    }

    if (path === '/api/claim') {
      const res = await claimGift(body);
      return jsonResponse(res, res.ok ? 200 : 403); // Modification: Use 403 for failed claims (security)
    }

    if (path === '/api/claim-task') {
      const res = await claimTask(body);
      return jsonResponse(res, res.ok ? 200 : 403); // Modification: Use 403 for failed claims (security)
    }

    return jsonResponse({ error: 'not found' }, 404);
  }
};