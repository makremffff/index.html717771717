// api/index.js
// Supabase REST API (fetch only) – لا يستخدم supabase-js
// جدول واحد: gifts (register, ad_view, claim, task_claim)

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

// upsert مع merge duplicates
async function upsert(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// معالجة الطلبات
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  const { type, ...body } = req.body;

  try {
    switch (type) {

      // ----------------- Register User -----------------
      case 'register': {
        const { userId, username, firstName, lastName, refal_by, initData } = body;

        // ✅ تحقق من initData
        if (!initData) return res.status(401).json({ message: 'Missing initData' });

        const { data: valid } = await rpc('verify_telegram_data', { init_data: initData });
        if (!valid) return res.status(401).json({ message: 'Invalid initData' });

        // سجل المستخدم
        await upsert('gifts', {
          user_id: userId,
          username,
          first_name: firstName,
          last_name: lastName,
          refal_by: refal_by || 0,
          action: 'register',
          gift: 'none',
          views: 0,
          created_at: new Date().toISOString()
        });

        return res.status(200).json({ message: 'User registered' });
      }

      // ----------------- Invite Stats -----------------
      case 'invite-stats': {
        const { userId } = body;
        const { data } = await rpc('get_user_invite_stats', { p_user_id: userId });
        if (!data || !data.length) return res.json({ total: 0, active: 0, pending: 0 });
        const row = data[0];
        return res.json({ total: row.total, active: row.active, pending: row.pending });
      }

      // ----------------- Watch Ad -----------------
      case 'watch-ad': {
        const { gift, userId } = body;
        if (!gift) return res.status(400).json({ message: 'Gift required' });

        // زيادة views لكل إعلان
        await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_action: 'ad_view',
          p_gift: gift,
          p_inc: 1
        });

        return res.json({ message: 'Ad view recorded' });
      }

      // ----------------- Claim Gift -----------------
      case 'claim': {
        const { gift, userId } = body;
        if (!gift) return res.status(400).json({ message: 'Gift required' });

        // تحقق من آخر claim
        const { data: last } = await get(
          'gifts',
          `user_id=eq.${userId}&gift=eq.${gift}&action=eq.claim&order=updated_at.desc&limit=1`
        );

        if (last && last.length) {
          const lastDate = new Date(last[0].updated_at);
          const now = new Date();
          const diffHours = (now - lastDate) / (1000 * 60 * 60);
          if (diffHours < 48) return res.status(400).json({ message: 'Wait 48h between claims' });
        }

        // تحقق عدد الإعلانات
        const { data: countRow } = await get(
          'gifts',
          `user_id=eq.${userId}&gift=eq.${gift}&action=eq.ad_view&select=count:id`
        );

        const views = countRow?.[0]?.count || 0;
        const required = { bear: 200, heart: 250, box: 350, rose: 350 }[gift] || 200;
        if (views < required) return res.status(400).json({ message: `Need ${required} ad views` });

        // تحقق من الدعوات
        const { data: stats } = await rpc('get_user_invite_stats', { p_user_id: userId });
        if (!stats?.[0]?.active || stats[0].active < 10) return res.status(400).json({ message: 'Need 10 active invites' });

        await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_action: 'claim',
          p_gift: gift,
          p_inc: 1
        });

        return res.json({ message: 'Claimed' });
      }

      // ----------------- Claim Task -----------------
      case 'claim-task': {
        const { task, userId } = body;
        if (!task) return res.status(400).json({ message: 'Task required' });

        if (task === 'bear') {
          const { data: stats } = await rpc('get_user_invite_stats', { p_user_id: userId });
          if (!stats?.[0]?.active || stats[0].active < 10) return res.status(400).json({ message: 'Need 10 active invites' });

          await rpc('upsert_gift_action', {
            p_user_id: userId,
            p_action: 'task_claim',
            p_gift: 'bear',
            p_inc: 1
          });

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