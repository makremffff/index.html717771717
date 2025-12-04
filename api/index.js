// Supabase-backed serverless backend (Node.js / CommonJS)
// Updated to use a single table "telegram_gifts" that stores all gift & task records.
// Routes supported (POST):
//   /api/register        -> upsert user in `users`
//   /api/invite-stats    -> return invite stats for a user (counts users with ref_by = userId)
//   /api/claim           -> record a claimed gift into `telegram_gifts` and update users.last_claim_date
//   /api/claim-task      -> record a completed task into `telegram_gifts` and update users.last_claim_date
//
// Requirements:
// - Set environment variables: SUPABASE_URL, SUPABASE_ANON_KEY (or NEXT_PUBLIC_* fallbacks)
// - Ensure table `telegram_gifts` exists with columns compatible with inserts below:
//     - id (serial / uuid), user_id (int), kind (text)  -- 'gift' | 'task'
//     - name (text) -- gift name or task name
//     - username (text), reward_amount (numeric, nullable)
//     - metadata (jsonb, nullable)
//     - created_at (timestamp)  -- should default to now() if desired
// - Table `users` should exist and include last_claim_date (timestamp) and ref_by columns
//
// Security note:
// - Using ANON key server-side is not ideal. Prefer SUPABASE_SERVICE_ROLE_KEY for server operations.

const fetch = global.fetch || require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('SUPABASE_URL or SUPABASE_ANON_KEY not set. Supabase calls will fail.');
}

const REQUIRED_ACTIVE_INVITES = 10;
const MIN_DAYS_BETWEEN_CLAIMS = 2;

// -------------------- supabaseFetch helper --------------------
async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  };

  const res = await fetch(url, options);

  if (res.ok) {
    const text = await res.text();
    try {
      const json = text ? JSON.parse(text) : { success: true };
      return Array.isArray(json) ? json : json;
    } catch (e) {
      return { success: true };
    }
  }

  let errBody = null;
  try { errBody = await res.json(); } catch (_) { /* ignore */ }

  const msg = (errBody && (errBody.message || errBody.error || JSON.stringify(errBody))) || `${res.status} ${res.statusText}`;
  const error = new Error(`Supabase error: ${msg}`);
  error.status = res.status;
  throw error;
}

// -------------------- helpers --------------------
function sendJSON(res, status = 200, payload = {}) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status);
  res.end(JSON.stringify(payload));
}

function daysBetweenISO(isoA, isoB) {
  if (!isoA || !isoB) return Infinity;
  const a = new Date(isoA);
  const b = new Date(isoB);
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.round(Math.abs((b - a) / oneDay));
}

async function parseBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk.toString());
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Invalid JSON payload')); }
    });
    req.on('error', reject);
  });
}

// -------------------- Route handlers --------------------

/**
 * register
 * Body: { userId, username, firstName, lastName, refal_by }
 */
async function handleRegister(req, res, body) {
  const { userId, username, firstName, lastName, refal_by } = body;
  if (!userId) return sendJSON(res, 400, { ok: false, error: 'Missing userId' });

  const id = parseInt(String(userId), 10);

  try {
    // check if user exists
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id`);
    if (Array.isArray(users) && users.length > 0) {
      // update optional fields
      const payload = {};
      if (username !== undefined) payload.username = username;
      if (firstName !== undefined) payload.first_name = firstName;
      if (lastName !== undefined) payload.last_name = lastName;
      if (refal_by !== undefined && refal_by !== null && refal_by !== '') payload.ref_by = parseInt(refal_by, 10);

      if (Object.keys(payload).length > 0) {
        await supabaseFetch('users', 'PATCH', payload, `?id=eq.${id}`);
      }
      return sendJSON(res, 200, { ok: true, message: 'User updated' });
    } else {
      const newUser = {
        id,
        username: username || null,
        first_name: firstName || null,
        last_name: lastName || null,
        ref_by: refal_by ? parseInt(refal_by, 10) : null,
        balance: 0,
        ads_watched_today: 0,
        spins_today: 0,
        is_banned: false,
        last_activity: new Date().toISOString(),
        task_link_clicks_today: 0,
        task_completed: false
      };
      await supabaseFetch('users', 'POST', newUser, '?select=id');
      return sendJSON(res, 200, { ok: true, message: 'User created' });
    }
  } catch (err) {
    console.error('handleRegister error:', err.message || err);
    return sendJSON(res, 500, { ok: false, error: 'Registration failed: ' + (err.message || 'Supabase error') });
  }
}

/**
 * invite-stats
 * Body: { userId }
 */
async function handleInviteStats(req, res, body) {
  const { userId } = body;
  if (!userId) return sendJSON(res, 400, { ok: false, error: 'Missing userId' });

  const id = parseInt(String(userId), 10);

  try {
    const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id,is_banned`);
    const total = Array.isArray(referrals) ? referrals.length : 0;
    const active = Array.isArray(referrals) ? referrals.filter(r => !r.is_banned).length : 0;
    const pending = Math.max(0, total - active);
    return sendJSON(res, 200, { ok: true, data: { total, active, pending } });
  } catch (err) {
    console.error('handleInviteStats error:', err.message || err);
    return sendJSON(res, 500, { ok: false, error: 'Failed to fetch invite stats: ' + (err.message || 'Supabase error') });
  }
}

/**
 * claim
 * Body: { gift, userId, username }
 * Behavior:
 *  - cooldown based on users.last_claim_date
 *  - check active invites count
 *  - insert into telegram_gifts with kind='gift'
 *  - update users.last_claim_date
 */
async function handleClaim(req, res, body) {
  const { gift, userId, username } = body;
  if (!gift || !userId) return sendJSON(res, 400, { ok: false, error: 'Missing gift or userId' });

  const id = parseInt(String(userId), 10);
  try {
    // fetch user
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,username,last_claim_date`);
    if (!Array.isArray(users) || users.length === 0) return sendJSON(res, 404, { ok: false, error: 'User not found' });
    const user = users[0];

    const nowISO = new Date().toISOString();
    if (user.last_claim_date) {
      const days = daysBetweenISO(user.last_claim_date, nowISO);
      if (days < MIN_DAYS_BETWEEN_CLAIMS) {
        return sendJSON(res, 429, { ok: false, error: `You must wait ${MIN_DAYS_BETWEEN_CLAIMS} days between claims` });
      }
    }

    // check active invites
    const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id,is_banned`);
    const activeCount = Array.isArray(referrals) ? referrals.filter(r => !r.is_banned).length : 0;
    if (activeCount < REQUIRED_ACTIVE_INVITES) {
      return sendJSON(res, 403, { ok: false, error: `Not enough active invites (need ${REQUIRED_ACTIVE_INVITES})` });
    }

    // Insert into telegram_gifts
    const giftRecord = {
      user_id: id,
      kind: 'gift',
      name: String(gift),
      username: username || (user.username || null),
      reward_amount: null,
      metadata: { source: 'web', active_invites: activeCount },
      created_at: nowISO
    };
    await supabaseFetch('telegram_gifts', 'POST', giftRecord, '?select=user_id');

    // update user's last_claim_date
    await supabaseFetch('users', 'PATCH', { last_claim_date: nowISO }, `?id=eq.${id}`);

    return sendJSON(res, 200, { ok: true, data: { gift, user_id: id, created_at: nowISO } });
  } catch (err) {
    console.error('handleClaim error:', err.message || err);
    return sendJSON(res, 500, { ok: false, error: 'Claim failed: ' + (err.message || 'Supabase error') });
  }
}

/**
 * claim-task
 * Body: { task, userId, username, reward_amount? }
 * Behavior:
 *  - prevent duplicate task completion by checking telegram_gifts for same user/kind='task'/name
 *  - insert a 'task' record into telegram_gifts (single-table approach)
 *  - update users.last_claim_date (optional)
 */
async function handleClaimTask(req, res, body) {
  const { task, userId, username, reward_amount } = body;
  if (!task || !userId) return sendJSON(res, 400, { ok: false, error: 'Missing task or userId' });

  const id = parseInt(String(userId), 10);
  try {
    // check duplicate (in telegram_gifts)
    // Note: encodeURIComponent not necessary for REST filter but keep safe usage for strings with spaces
    const encodedTask = encodeURIComponent(String(task));
    const duplicates = await supabaseFetch('telegram_gifts', 'GET', null, `?user_id=eq.${id}&kind=eq.task&name=eq.${encodedTask}&select=id`);
    if (Array.isArray(duplicates) && duplicates.length > 0) {
      return sendJSON(res, 409, { ok: false, error: 'Task already claimed' });
    }

    const nowISO = new Date().toISOString();
    const taskRecord = {
      user_id: id,
      kind: 'task',
      name: String(task),
      username: username || null,
      reward_amount: reward_amount !== undefined ? parseFloat(reward_amount) : null,
      metadata: { source: 'web' },
      created_at: nowISO
    };
    await supabaseFetch('telegram_gifts', 'POST', taskRecord, '?select=user_id');

    // optionally update user's last_claim_date / last_activity
    try {
      await supabaseFetch('users', 'PATCH', { last_activity: nowISO }, `?id=eq.${id}`);
    } catch (_) { /* non-fatal */ }

    return sendJSON(res, 200, { ok: true, data: { task, user_id: id, created_at: nowISO } });
  } catch (err) {
    console.error('handleClaimTask error:', err.message || err);
    return sendJSON(res, 500, { ok: false, error: 'Claim task failed: ' + (err.message || 'Supabase error') });
  }
}

// -------------------- Main Handler --------------------
module.exports = async (req, res) => {
  // Basic CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return sendJSON(res, 200, { ok: true });
  if (req.method !== 'POST') return sendJSON(res, 405, { ok: false, error: `Method ${req.method} not allowed` });

  let body = {};
  try { body = await parseBody(req); } catch (err) { return sendJSON(res, 400, { ok: false, error: err.message }); }

  const rawPath = (req.url || '/').split('?')[0];
  const normalized = rawPath.replace(/^\/+|\/+$/g, '');
  const route = normalized.split('/').pop() || '';

  try {
    switch (route) {
      case 'register':        return await handleRegister(req, res, body);
      case 'invite-stats':    return await handleInviteStats(req, res, body);
      case 'claim':           return await handleClaim(req, res, body);
      case 'claim-task':      return await handleClaimTask(req, res, body);
      default: return sendJSON(res, 404, { ok: false, error: 'Unknown endpoint', route });
    }
  } catch (err) {
    console.error('Unhandled error:', err && err.stack ? err.stack : err);
    return sendJSON(res, 500, { ok: false, error: 'Internal server error' });
  }
};