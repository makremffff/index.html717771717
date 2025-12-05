// api/index.js
// Supabase REST API (fetch only) – لا يستخدم supabase-js
// جداول: gifts, ad_views, users

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function headers() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

// Helpers
async function post(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function get(path, query = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${query}`, {
    headers: headers()
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function rpc(name, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ----------------- API Handler -----------------
export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ message: 'Server misconfigured: missing Supabase env vars' });
    }

    if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

    const { type, ...body } = req.body;

    switch (type) {

      // ----------------- Register User -----------------
      case 'register': {
        const { userId, username, firstName, lastName, refal_by } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        await upsert('users', {
          id: userId,
          username,
          first_name: firstName,
          last_name: lastName,
          ref_by: refal_by || null,
          created_at: new Date().toISOString(),
          last_activity: new Date().toISOString()
        });

        return res.status(200).json({ message: 'User registered' });
      }

      // ----------------- Watch Ad -----------------
      case 'watch-ad': {
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        // أضف أو زد المشاهدة
        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1
        });

        if (!up.ok) {
          console.error('upsert_gift_action failed', up);
          return res.status(500).json({ message: 'Failed to record ad view', rpc_response: up.data });
        }

        // جمع كل المشاهدات لذلك المستخدم + الهديه
        const { data: adRows } = await get(
          'ad_views',
          `user_id=eq.${userId}&gift_id=eq.${giftId}&select=views`
        );

        let views = 0;
        if (adRows && adRows.length) {
          adRows.forEach(r => { views += r.views || 0; });
        }

        return res.status(200).json({ message: 'Ad view recorded', ad_views: { [giftId]: views } });
      }

      // ----------------- Claim Gift -----------------
      case 'claim': {
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        const { data: adRows } = await get(
          'ad_views',
          `user_id=eq.${userId}&gift_id=eq.${giftId}&select=views`
        );

        let views = 0;
        if (adRows && adRows.length) {
          adRows.forEach(r => { views += r.views || 0; });
        }

        const giftReqViews = { 1: 200, 2: 250, 3: 350 }[giftId] || 200;
        if (views < giftReqViews) return res.status(400).json({ message: `Need ${giftReqViews} ad views` });

        await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1
        });

        return res.status(200).json({ message: 'Gift claimed' });
      }

      default:
        return res.status(400).json({ message: 'Unknown type' });
    }

  } catch (err) {
    console.error('Unhandled error', err);
    return res.status(500).json({ message: 'Server error', error: String(err) });
  }
}

// ----------------- Upsert Helper -----------------
async function upsert(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}