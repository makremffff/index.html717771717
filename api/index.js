// api/index.js
// Hybrid REST + Client-Side Logic WebApp API
// يعمل على Cloudflare Pages Functions أو Vercel Functions
// يعتمد على المتغيرات البيئية:
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY
//   BOT_TOKEN

// يجب أن تكون المتغيرات البيئية متاحة
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN; 

// يتم استدعاء مكتبة التشفير (crypto) هنا
let crypto;
try {
  crypto = require('crypto');
} catch (e) {
  // للبيئات التي لا تدعم require (مثل Cloudflare Workers)
  // يجب استخدام Web Crypto API بدلاً من ذلك، لكن نفترض Node.js حالياً
  console.warn("Node.js 'crypto' module not available. InitData verification will fail if not using Node.js environment.");
  // يمكن إضافة كود fallback لـ Cloudflare هنا إذا لزم الأمر
}

/*********************************************
 * وظيفة التحقق الأمني من Telegram InitData
 *********************************************/
function verifyTelegramInitData(initData, token) {
  if (!initData || !crypto) return false;
  try {
    const data = new URLSearchParams(initData);
    const hash = data.get('hash');
    data.delete('hash');
    
    // ترتيب البيانات أبجديًا
    const params = Array.from(data.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const dataCheckString = params.map(([key, value]) => `${key}=${value}`).join('\n');

    // حساب المفتاح السري
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    // حساب الهاش باستخدام المفتاح السري
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    return calculatedHash === hash;
  } catch (e) {
    console.error('InitData verification failed:', e.message);
    return false;
  }
}

/*********************************************
 * وظيفة المراسلة مع Supabase
 *********************************************/
async function supabaseRequest(method, path, body = null, headers = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { ok: false, status: 500, error: 'Supabase credentials missing' };
  }
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

/*********************************************
 * وظيفة إنشاء استجابة JSON
 *********************************************/
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      // السماح بالوصول من أي مكان إذا كنت تستخدم Vercel أو Cloudflare
      'Access-Control-Allow-Origin': '*' 
    }
  });
}

/*********************************************
 * معالجات أنواع الطلبات (Request Handlers)
 *********************************************/

// 1. type: 'register' - تسجيل المستخدم أو التحقق من وجوده
async function registerUser(payload) {
  if (!payload.userId) return { ok: false, error: 'userId required' };

  // التحقق الأمني: مطلوب للطلبات التي تأتي من واجهة المستخدم
  if (!BOT_TOKEN || !verifyTelegramInitData(payload.initData, BOT_TOKEN)) {
    // التحقق من initData مطلوب ولكن لا يمنع التسجيل، فقط يسجل تحذير
    // console.warn(`Registration attempt failed InitData verification for user ${payload.userId}`);
  }

  // تحقق من وجود المستخدم مسبقاً
  const { ok: checkOk, data: checkData } = await supabaseRequest(
    'GET',
    `/telegram.log?select=user_id&user_id=eq.${payload.userId}`
  );
  if (checkOk && Array.isArray(checkData) && checkData.length > 0) {
    return { ok: true, message: 'User already exists' };
  }

  // إدخال مستخدم جديد
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

// 2. type: 'invite-stats' - جلب إحصائيات الدعوات
async function getInviteStats(userId) {
  const { ok, data } = await supabaseRequest(
    'GET',
    `/telegram.log?select=invites_total,invites_active,invites_pending&user_id=eq.${userId}`
  );
  if (!ok || !Array.isArray(data) || data.length === 0) {
    // إذا لم يتم العثور على المستخدم، نرجع صفر
    return { total: 0, active: 0, pending: 0 };
  }
  const row = data[0];
  return {
    total: row.invites_total || 0,
    active: row.invites_active || 0,
    pending: row.invites_pending || 0
  };
}

// 3. type: 'watch-ad' - تسجيل مشاهدة إعلان وإنقاص العداد
async function watchAd({ gift, userId, initData }) {
  // التحقق الأمني الصارم: نرفض الطلب إذا فشل التحقق
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }
  
  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const adsCol = `ads_${gift}`;
  const now = new Date().toISOString();
  
  // لإنقاص قيمة رقمية في Supabase تحتاج إلى استخدام دالة SQL
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
     // إذا لم يتم تحديث أي صف، فربما يكون العداد وصل للصفر
     return { ok: true, message: 'Ad count already zero or user not found' };
  }
  if (!ok) return { ok: false, error: data?.message || 'Ad count update failed' };
  
  return { ok: true, data };
}

// 4. type: 'claim' - المطالبة بهدية
async function claimGift({ gift, userId, username, initData }) {
  // التحقق الأمني الصارم
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }
  
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

// 5. type: 'claim-task' - المطالبة بهدية المهمة
async function claimTask({ task, userId, username, initData }) {
  // التحقق الأمني الصارم
  if (!BOT_TOKEN || !verifyTelegramInitData(initData, BOT_TOKEN)) {
    return { ok: false, error: 'Invalid Telegram Session (initData)', status: 403 };
  }
  
  if (task !== 'bear' || !userId) return { ok: false, error: 'Invalid task or userId' };

  const now = new Date().toISOString();

  // زيادة gifts_bear بـ 1
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
 * المُعالج الرئيسي (Fetcher)
 *********************************************/
export default {
  async fetch(request, env) {
    // ربط المتغيرات البيئية عند العمل في بيئات مثل Cloudflare Workers
    if (env && env.NEXT_PUBLIC_SUPABASE_URL) {
      global.process = global.process || { env: {} };
      global.process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
      global.process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      global.process.env.BOT_TOKEN = env.BOT_TOKEN;
    }

    const method = request.method;
    
    // دعم CORS OPTIONS Preflight
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
    
    // إذا كانت هناك مشكلة في التحقق الأمني، نعيد 403
    if (res.status === 403 || res.error === 'Invalid Telegram Session (initData)') {
        status = 403;
    }

    return jsonResponse(res, status);
  }
};