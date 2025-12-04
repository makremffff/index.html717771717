// api/index.js
// NOTE: initData verification has been removed by request.
// WARNING: Disabling initData verification reduces security. Do not expose this
// API publicly without other protections (auth / rate-limit / proper Supabase rules).

// Environment variables used:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY

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
 * Handlers (verification REMOVED)
 *********************************************/

// 1. register
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

  // NOTE: initData verification removed. We still allow registration attempt.
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

// 3. watch-ad (no initData verification)
async function watchAd({ gift, userId, initData }) {
  // verification removed intentionally
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

// 4. claim gift (no initData verification)
async function claimGift({ gift, userId, username, initData }) {
  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const now = new Date().toISOString();
  const giftCol = `gifts_${gift}`;        
  const canCol = `can_claim_${gift}`;     
  const adsCol = `ads_${gift}`;           

  // 1. تصفير العداد، إغلاق إمكانية السحب، تحديث تاريخ آخر سحب
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

  // 2. زيادة عدد الهدايا بـ +1 باستخدام دالة SQL
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

// 5. claim-task (no initData verification)
async function claimTask({ task, userId, username, initData }) {
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
      if (env.NEXT_PUBLIC_SUPABASE_URL) global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      if (env.NEXT_PUBLIC_SUPABASE_ANON_KEY) global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

    return jsonResponse(res, status);
  }
};