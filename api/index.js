// api/index.js
// Supabase REST API (fetch only) – لا يستخدم supabase-js
// جداول متوقعة: gifts, ad_views, users
// يقدم endpoints: register, watch-ad, claim, claim-task, invite-stats, get-user-state

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
  const url = query ? `${SUPABASE_URL}/rest/v1/${path}?${query}` : `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
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

    // Accept body like: { type: 'watch-ad', giftId: 'bear', userId: '123' }
    const { type, ...body } = req.body || {};

    switch (type) {

      // ----------------- Register User -----------------
      case 'register': {
        const { userId, username, firstName, lastName, refal_by, initData } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        await upsert('users', {
          id: userId,
          username,
          first_name: firstName,
          last_name: lastName,
          ref_by: refal_by || null,
          created_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          // store initData for server-side validation if needed (optional)
          init_data: initData ? JSON.stringify(initData) : null
        });

        return res.status(200).json({ message: 'User registered' });
      }

      // ----------------- Watch Ad -----------------
      case 'watch-ad': {
        // Expect giftId and userId (frontend now sends giftId,userId)
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        // Use RPC to increment/create ad_views row (RPC should handle upsert semantics)
        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1,
          p_action: 'ad_view'
        });

        if (!up.ok) {
          console.error('upsert_gift_action failed', up);
          return res.status(500).json({ message: 'Failed to record ad view', rpc_response: up.data });
        }

        // Return aggregated views for that gift for the user
        const adRes = await get('ad_views', `user_id=eq.${userId}&gift_id=eq.${giftId}&select=views`);
        let views = 0;
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => { views += Number(r.views || 0); });
        }

        return res.status(200).json({ message: 'Ad view recorded', ad_views: { [giftId]: views } });
      }

      // ----------------- Claim Gift -----------------
      case 'claim': {
        // Expect giftId and userId
        const { giftId, userId } = body;
        if (!giftId || !userId) return res.status(400).json({ message: 'giftId and userId required' });

        // Compute current ad views for this gift/user
        const adRes = await get('ad_views', `user_id=eq.${userId}&gift_id=eq.${giftId}&select=views`);
        let views = 0;
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => { views += Number(r.views || 0); });
        }

        // Map giftId to required views if giftId is numeric id; if giftId is string key,
        // consumer of API should use numeric ids. We'll accept both:
        // if giftId is numeric-like string, use mapping; else default 200.
        const numericGiftId = Number(giftId);
        const giftReqViewsMap = { 1: 200, 2: 250, 3: 350 };
        const giftReqViews = (Number.isInteger(numericGiftId) && giftReqViewsMap[numericGiftId])
          ? giftReqViewsMap[numericGiftId]
          : 200;

        if (views < giftReqViews) return res.status(400).json({ message: `Need ${giftReqViews} ad views`, current: views });

        // Record the claim (RPC increments claim counter or inserts to gifts table)
        const up = await rpc('upsert_gift_action', {
          p_user_id: userId,
          p_gift_id: giftId,
          p_inc: 1,
          p_action: 'claim'
        });

        if (!up.ok) {
          console.error('upsert_gift_action (claim) failed', up);
          return res.status(500).json({ message: 'Failed to record claim', rpc_response: up.data });
        }

        // Optionally update user's last_claim_date
        await upsert('users', { id: userId, last_claim_date: new Date().toISOString() });

        return res.status(200).json({ message: 'Gift claimed' });
      }

      // ----------------- Claim Task (e.g., bear reward) -----------------
      case 'claim-task': {
        // frontend sends taskId and userId
        const { taskId, userId } = body;
        if (!taskId || !userId) return res.status(400).json({ message: 'taskId and userId required' });

        // Map taskId to gift id (adjust mapping to your DB)
        const TASK_TO_GIFT = { bear: 1 }; // example: bear -> gift id 1
        const giftMapped = TASK_TO_GIFT[taskId] || null;
        if (!giftMapped) {
          // If there's no mapping, still allow record but mark task action
          const upTask = await rpc('upsert_gift_action', {
            p_user_id: userId,
            p_gift_id: taskId, // store task name if schema supports it
            p_inc: 1,
            p_action: 'task_claim'
          });
          if (!upTask.ok) {
            console.error('upsert_gift_action (task fallback) failed', upTask);
            return res.status(500).json({ message: 'Failed to record task claim', rpc_response: upTask.data });
          }
        } else {
          const up = await rpc('upsert_gift_action', {
            p_user_id: userId,
            p_gift_id: giftMapped,
            p_inc: 1,
            p_action: 'claim'
          });
          if (!up.ok) {
            console.error('upsert_gift_action (task) failed', up);
            return res.status(500).json({ message: 'Failed to record task claim', rpc_response: up.data });
          }
        }

        // Increment user's bear_task_level if applicable (assumes users table has bear_task_level)
        if (taskId === 'bear') {
          // read current level
          const u = await get('users', `id=eq.${userId}&select=bear_task_level`);
          let level = 0;
          if (u.ok && Array.isArray(u.data) && u.data.length) {
            level = Number(u.data[0].bear_task_level || 0);
          }
          level = level + 1;
          await upsert('users', { id: userId, bear_task_level: level });
        }

        // update last claim date
        await upsert('users', { id: userId, last_claim_date: new Date().toISOString() });

        return res.status(200).json({ message: 'Task claimed' });
      }

      // ----------------- Invite Stats -----------------
      case 'invite-stats': {
        const { userId } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        // total invites: users with ref_by == userId
        const totalRes = await get('users', `ref_by=eq.${userId}&select=id,created_at,is_active`);
        let total = 0, active = 0, pending = 0;
        if (totalRes.ok && Array.isArray(totalRes.data)) {
          total = totalRes.data.length;
          // if `is_active` exists, count active; otherwise fallback heuristics (e.g., last_activity)
          totalRes.data.forEach(u => {
            if (typeof u.is_active !== 'undefined') {
              if (u.is_active === true || u.is_active === 't' || u.is_active === 'true') active++;
            } else if (u.created_at) {
              // fallback: consider accounts older than 2 days as active (heuristic)
              try {
                const created = new Date(u.created_at);
                const now = new Date();
                const diffDays = Math.round(Math.abs((now - created) / (24*60*60*1000)));
                if (diffDays >= 2) active++;
              } catch(e){}
            }
          });
          pending = total - active;
        }

        return res.status(200).json({ total, active, pending });
      }

      // ----------------- Get User State -----------------
      case 'get-user-state': {
        const { userId } = body;
        if (!userId) return res.status(400).json({ message: 'userId required' });

        // ad_views: all rows for this user
        const adRes = await get('ad_views', `user_id=eq.${userId}&select=gift_id,views`);
        const ad_views = {};
        if (adRes.ok && Array.isArray(adRes.data)) {
          adRes.data.forEach(r => {
            const k = String(r.gift_id);
            ad_views[k] = (ad_views[k] || 0) + Number(r.views || 0);
          });
        }

        // claims: try to read from 'gifts' table or from rpc if different schema
        // assume 'gifts' table has rows with user_id and gift_id and maybe quantity
        const claimRes = await get('gifts', `user_id=eq.${userId}&select=gift_id,quantity`);
        const claims = {};
        if (claimRes.ok && Array.isArray(claimRes.data)) {
          claimRes.data.forEach(r => {
            const k = String(r.gift_id);
            claims[k] = (claims[k] || 0) + (Number(r.quantity || 1));
          });
        }

        // user-level fields: last_claim_date, bear_task_level
        const userRes = await get('users', `id=eq.${userId}&select=last_claim_date,bear_task_level`);
        let last_claim_date = null, bear_task_level = 0;
        if (userRes.ok && Array.isArray(userRes.data) && userRes.data.length) {
          last_claim_date = userRes.data[0].last_claim_date || null;
          bear_task_level = Number(userRes.data[0].bear_task_level || 0);
        }

        return res.status(200).json({
          ad_views,
          claims,
          last_claim_date,
          bear_task_level
        });
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