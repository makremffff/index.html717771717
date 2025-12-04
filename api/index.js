// api/index.js
// Hybrid REST + Client-Side Logic WebApp API
// يعمل على Cloudflare Pages Functions أو أي serverless يدعم file-system routing
// يعتمد فقط على المتغيرات البيئية:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
// ويتعامل مع جدول واحد فقط: telegram.log

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

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
// يستقبل: { userId, username, firstName, lastName, refal_by }
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

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
// يستقبل: { gift, userId, username }
// يُحدّث العداد ويُسجل الهدية
async function claimGift({ gift, userId, username }) {
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
// يستقبل: { task, userId, username }
// يُحدّف المهمة ويزيد gifts_bear
async function claimTask({ task, userId, username }) {
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
      global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

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
      return jsonResponse(res, res.ok ? 200 : 400);
    }

    if (path === '/api/claim-task') {
      const res = await claimTask(body);
      return jsonResponse(res, res.ok ? 200 : 400);
    }

    return jsonResponse({ error: 'not found' }, 404);
  }
};
