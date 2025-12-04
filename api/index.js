// api/index.js
// Hybrid REST + Client-Side Logic WebApp API
// يعمل على Cloudflare Pages Functions أو أي serverless يدعم file-system routing
// يعتمد على المتغيرات البيئية:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
//   BOT_TOKEN
// ويتعامل مع جدول واحد فقط: telegram.log

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN; 

// Modification: Implement check for initData
function verifyTelegramInitData(initData, token) {
  if (!initData) return false;
  try {
    const data = new URLSearchParams(initData);
    const hash = data.get('hash');
    data.delete('hash');
    
    // يحتاج بيئة Node.js أو Cloudflare Workers (للوصول إلى crypto)
    const crypto = require('crypto'); 

    const params = Array.from(data.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = params.map(([key, value]) => `${key}=${value}`).join('\n');

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

// مسار: type: 'register'
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

  if (!BOT_TOKEN || !verifyTelegramInitData(payload.initData, BOT_TOKEN)) {
    // التحقق الأمني: لا يمنع التسجيل، لكن يجب تسجيل تحذير في اللوغز.
  }

  // Check if user already exists
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

// مسار: type: 'invite-stats'
async function getInviteStats(userId) {
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

// 💡 الدالة الجديدة: مسار: type: 'watch-ad'
async function watchAd({ gift, userId, initData }) {
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }
  
  const adsCol = `ads_${gift}`;
  const now = new Date().toISOString();
  
  // ننقص العداد بواحد (مشاهدة إعلانين = خصم 1 من العداد)
  const { ok, data } = await supabaseRequest(
    'PATCH',
    `/telegram.log?user_id=eq.${userId}&${adsCol}=gt.0`, // تأكد من أن العداد أكبر من صفر
    {
      [adsCol]: `telegram.log.${adsCol} - 1`,
      updated_at: now
    },
    // ملاحظة: لزيادة/إنقاص قيمة رقمية في Supabase تحتاج إلى استخدام دالة SQL
    // هذا الكود يفترض وجود سياسة RLS تسمح بتنفيذ `column = column - 1`
    { 'Prefer': 'return=representation', 'Content-Type': 'application/json' }
  );
  if (!ok) return { ok: false, error: data?.message || 'ad count update failed' };
  return { ok: true, data };
}

// مسار: type: 'claim'
async function claimGift({ gift, userId, username, initData }) {
  // Security Check - Deny claim if initData is invalid
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }

  const now = new Date().toISOString();
  const giftCol = `gifts_${gift}`;        
  const canCol = `can_claim_${gift}`;     
  const adsCol = `ads_${gift}`;           

  // أولاً: تصفير عداد الإعلانات وإغلاق إمكانية السحب (can_claim) وتحديث تاريخ السحب
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

  // ثانيًا: زيادة عدد الهدايا بـ +1
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

// مسار: type: 'claim-task'
async function claimTask({ task, userId, username, initData }) {
  // Security Check - Deny claim if initData is invalid
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

// المُعالج الرئيسي الموحد
export default {
  async fetch(request, env) {
    // استخراج المتغيرات البيئية
    if (!SUPABASE_URL) {
      global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      global.process.env.BOT_TOKEN = env.BOT_TOKEN;
    }

    const method = request.method;
    
    if (method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON format' }, 400);
    }
    
    // التحقق من نوع الطلب (type) بدلاً من المسار (path)
    const requestType = body.type;

    if (!requestType) {
        return jsonResponse({ error: 'Missing request type in body' }, 400);
    }

    let res;
    let status = 200;

    switch (requestType) {
      case 'register':
        res = await registerUser(body);
        status = res.ok ? 200 : 400;
        break;
      case 'invite-stats':
        res = await getInviteStats(body.userId);
        status = 200;
        break;
      case 'watch-ad': // 💡 المعالج الجديد لعداد الإعلانات
        res = await watchAd(body);
        status = res.ok ? 200 : 403;
        break;
      case 'claim':
        res = await claimGift(body);
        status = res.ok ? 200 : 403;
        break;
      case 'claim-task':
        res = await claimTask(body);
        status = res.ok ? 200 : 403;
        break;
      default:
        // إذا كان نوع الطلب غير معروف
        return jsonResponse({ error: `Unknown request type: ${requestType}` }, 404);
    }
    
    return jsonResponse(res, status);
  }
};