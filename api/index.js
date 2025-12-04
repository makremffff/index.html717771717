// api/index.js
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function supabaseHeaders() {
  return {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function supabaseRpc(rpcName, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function supabaseGet(table, query = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (Array.isArray(v)) v.forEach(val => params.append(k, val));
    else params.set(k, v);
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'GET',
    headers: supabaseHeaders()
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function supabasePost(table, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function supabaseUpsert(table, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  const { type, ...body } = req.body;

  switch (type) {
    case 'register': {
      const { userId, username, firstName, lastName, refal_by, initData } = body;
      const { ok } = await supabaseUpsert('users', {
        user_id: userId,
        username,
        first_name: firstName,
        last_name: lastName,
        refal_by,
        init_data: initData
      });
      return res.status(ok ? 200 : 400).json({ message: ok ? 'ok' : 'registration failed' });
    }

    case 'invite-stats': {
      const { userId } = body;
      const { data, ok } = await supabaseRpc('get_user_invite_stats', { p_user_id: userId });
      if (!ok) return res.status(400).json({ message: 'rpc error' });
      return res.status(200).json({
        total: data[0]?.total ?? 0,
        active: data[0]?.active ?? 0,
        pending: data[0]?.pending ?? 0
      });
    }

    case 'watch-ad': {
      const { gift, userId } = body;
      const { ok } = await supabasePost('ad_views', { gift_key: gift, user_id: userId });
      return res.status(ok ? 200 : 400).json({ message: ok ? 'ad saved' : 'failed' });
    }

    case 'claim': {
      const { gift, userId, username } = body;
      const { data: stats } = await supabaseRpc('get_user_invite_stats', { p_user_id: userId });
      const active = stats[0]?.active ?? 0;
      if (active < 10) return res.status(400).json({ message: 'not enough active invites' });

      const { ok } = await supabasePost('claims', { gift_key: gift, user_id: userId, username });
      if (!ok) return res.status(400).json({ message: 'claim failed' });
      return res.status(200).json({ message: 'claimed' });
    }

    case 'claim-task': {
      const { task, userId, username } = body;
      const { data: stats } = await supabaseRpc('get_user_invite_stats', { p_user_id: userId });
      const active = stats[0]?.active ?? 0;
      if (active < 10) return res.status(400).json({ message: 'not enough active invites' });

      const { ok } = await supabasePost('task_claims', { task_key: task, user_id: userId, username });
      if (!ok) return res.status(400).json({ message: 'task claim failed' });
      return res.status(200).json({ message: 'task claimed' });
    }

    default:
      return res.status(400).json({ message: 'unknown type' });
  }
}
