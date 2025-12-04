import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BOT_TOKEN = Deno.env.get('BOT_TOKEN');

// استخدام التشفير الشامل (يعمل على Node.js و Browsers/Workers)
// بما أننا نعمل في Deno/Supabase، يجب استخدام globalThis.crypto
// ولكن وظيفة التحقق القديمة لن تعمل بدون إعادة كتابة جذرية.
// بما أنك طلبت إزالة التحقق الصارم، لن نعتمد على هذه الدوال.

/*
// الدالة الأصلية للتحقق (ملاحظة: تم تخطيها الآن)
function verifyTelegramInitData(initData, token) {
  // ... (الدالة هنا)
  return true; // نتركها هنا لكننا لا نستخدمها بشكل صارم
}
*/

// الدوال المساعدة للعمليات
// -------------------------------------------------------------

// 2. type: 'set-user' - تسجيل المستخدم
async function setUser({ userId, username, first_name, last_name, refal_by }) {
  if (!userId) return { ok: false, error: 'Missing userId' };

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_ANON_KEY')
  );

  const { data: existingUser } = await supabase
    .from('telegram_log')
    .select('user_id')
    .eq('user_id', userId)
    .single();

  if (existingUser) {
    return { ok: true, message: 'User already exists', data: existingUser };
  }

  const user = {
    user_id: userId,
    username: username || null,
    first_name: first_name || null,
    last_name: last_name || null,
    refal_by: refal_by || null,
  };

  const { data, error } = await supabase.from('telegram_log').insert([user]).select();

  if (error) {
    console.error('Error inserting user:', error);
    return { ok: false, error: error.message };
  }

  if (refal_by) {
    await supabase.rpc('increment_invites', { inviter_id: refal_by });
  }

  return { ok: true, data: data[0] };
}

// 3. type: 'watch-ad' - تسجيل مشاهدة إعلان وإنقاص العداد
async function watchAd({ gift, userId }) {
  // ⛔️ تمت إزالة التحقق الأمني هنا لتجنب خطأ 403
  
  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_ANON_KEY')
  );

  const columnToDecrement = `ads_${gift}`;
  const { data, error } = await supabase.rpc('decrement_ad_count', {
    user_id_param: userId,
    column_name: columnToDecrement,
  });

  if (error) {
    console.error('Error decrementing ad count:', error);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

// 4. type: 'claim' - المطالبة بهدية
async function claimGift({ gift, userId, username }) {
  // ⛔️ تمت إزالة التحقق الأمني هنا لتجنب خطأ 403
  
  if (!gift || !userId) return { ok: false, error: 'Missing gift or userId' };

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_ANON_KEY')
  );

  const { data, error } = await supabase.rpc('claim_gift_procedure', {
    gift_type: gift,
    claimer_id: userId,
  });

  if (error) {
    console.error('Error claiming gift:', error);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

// 5. type: 'claim-task' - المطالبة بهدية المهمة
async function claimTask({ task, userId, username }) {
  // ⛔️ تمت إزالة التحقق الأمني هنا لتجنب خطأ 403

  if (task !== 'bear' || !userId) return { ok: false, error: 'Invalid task or userId' };

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL'),
    Deno.env.get('SUPABASE_ANON_KEY')
  );

  const { data, error } = await supabase.rpc('claim_bear_task', {
    user_id_param: userId,
  });

  if (error) {
    console.error('Error claiming bear task:', error);
    return { ok: false, error: error.message };
  }

  return { ok: true, data };
}

// المعالج الرئيسي
// -------------------------------------------------------------

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { type, ...params } = body;
    let res;

    switch (type) {
      case 'set-user':
        res = await setUser(params);
        break;
      case 'watch-ad':
        res = await watchAd(params);
        break;
      case 'claim':
        res = await claimGift(params);
        break;
      case 'claim-task':
        res = await claimTask(params);
        break;
      default:
        res = { ok: false, error: 'Invalid type provided', status: 400 };
    }

    let status = res.status || (res.ok ? 200 : 500);

    // ⚠️ تم إزالة الشرط الخاص بالـ 403:
    /*
    if (res.status === 403 || res.error === 'Invalid Telegram Session (initData)') {
        status = 403;
    }
    */

    return new Response(JSON.stringify(res), {
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (error) {
    console.error('Global error:', error);
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});