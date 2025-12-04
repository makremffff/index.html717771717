// api/index.js
// Supabase REST API (fetch only) – لا يستخدم supabase-js

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function supabaseHeaders() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

function fullUrl(path, query = '') {
  return `${SUPABASE_URL}/rest/v1${path}${query}`;
}

// مساعد لاستدعاء fetch وإرجاع نتيجة مبسطة
async function post(table, body, match = {}) {
  const opts = {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body)
  };
  const url = fullUrl(`/${table}`);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function get(table, query) {
  const url = fullUrl(`/${table}`, query);
  const res = await fetch(url, { headers: supabaseHeaders() });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function upsert(table, body) {
  const opts = {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(body)
  };
  const url = fullUrl(`/${table}`);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function rpc(functionName, params) {
  const opts = {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(params)
  };
  const url = fullUrl(`/rpc/${functionName}`);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ===== معالجات الطلبات =====
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  const { type, ...body } = req.body;

  try {
    switch (type) {
      case 'register': {
        const { userId, username, firstName, lastName, refal_by, initData } = body;
        // التحقق من initData (نفس المنطق السابق)
        const verify = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_telegram_data`, {
          method: 'POST',
          headers: supabaseHeaders(),
          body: JSON.stringify({ init_data: initData })
        }).then(r => r.json()).catch(() => false);
        if (!verify) return res.status(401).json({ message: 'Invalid initData' });

        const payload = {
          user_id: userId,
          username,
          first_name: firstName,
          last_name: lastName,
          refal_by: refal_by || 0,
          created_at: new Date().toISOString()
        };
        const { ok, data } = await upsert('gifts', payload);
        if (!ok) throw new Error('Upsert failed');
        return res.status(200).json({ message: 'User registered' });
      }

      case 'invite-stats': {
        const { userId } = body;
        const { data: stats } = await rpc('get_user_invite_stats', { p_user_id: userId });
        if (!stats || !stats.length) return res.json({ total: 0, active: 0, pending: 0 });
        const row = stats[0];
        return res.json({ total: row.total, active: row.active, pending: row.pending });
      }

      case 'watch-ad': {
        const { gift, userId } = body;
        await post('ad_views', { user_id: userId, gift, viewed_at: new Date().toISOString() });
        return res.json({ message: 'Ad view recorded' });
      }

      case 'claim': {
        const { gift, userId, username } = body;
        const { data: last } = await get('claims', `?user_id=eq.${userId}&gift=eq.${gift}&order=created_at.desc&limit=1`);
        if (last && last.length) {
          const lastDate = new Date(last[0].created_at);
          const now = new Date();
          const diffHours = (now - lastDate) / (1000 * 60 * 60);
          if (diffHours < 48) return res.status(400).json({ message: 'Wait 48h between claims' });
        }
        const { data: active } = await rpc('get_user_invite_stats', { p_user_id: userId });
        if (!active || !active.length || active[0].active < 10) return res.status(400).json({ message: 'Need 10 active invites' });

        await post('claims', { user_id: userId, gift, created_at: new Date().toISOString() });
        return res.json({ message: 'Claimed' });
      }

      case 'claim-task': {
        const { task, userId, username } = body;
        if (task === 'bear') {
          const { data: stats } = await rpc('get_user_invite_stats', { p_user_id: userId });
          if (!stats || !stats.length || stats[0].active < 10) return res.status(400).json({ message: 'Need 10 active invites' });
          await post('task_claims', { user_id: userId, task, created_at: new Date().toISOString() });
          return res.json({ message: 'Task reward claimed' });
        }
        return res.status(400).json({ message: 'Unknown task' });
      }

      default:
        return res.status(400).json({ message: 'Unknown type' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Server error' });
  }
}
