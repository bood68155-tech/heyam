'use strict';

/**
 * Telegram webhook management for the Vercel deployment.
 *
 *   npm run webhook:info                    // current state
 *   npm run webhook:set                     // point Telegram at the deployed route
 *   npm run webhook:set -- <url>            // ...or an explicit URL
 *   npm run webhook:set -- --force          // skip the endpoint probe
 *   npm run webhook:delete                  // back to long polling (npm start)
 *
 * The probe exists on purpose: pointing Telegram at a route that does not
 * answer yet silently kills the bot, so we check first.
 */

const { config } = require('../src/config');

const DEFAULT_URL = process.env.PUBLIC_URL || 'https://heyam-five.vercel.app/api/webhook';
const SECRET = (process.env.WEBHOOK_SECRET || '').trim();

if (!config.botToken) {
  console.error('BOT_TOKEN مفقود — لا يمكن إدارة الويبهوك');
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${config.botToken}/${method}`;

async function callTelegram(method, body) {
  const res = await fetch(api(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(`${method} failed: ${json.description || `HTTP ${res.status}`}`);
  }
  return json.result;
}

/** GET the deployed route and check it really is this bot's handler. */
async function probe(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (res.ok && json && json.service === 'heyam student bot') {
      return { ok: true, detail: `HTTP ${res.status}, ok=${json.ok}` };
    }
    return {
      ok: false,
      detail: `HTTP ${res.status} — الرد ليس من هذا البوت (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`,
    };
  } catch (err) {
    return { ok: false, detail: `تعذّر الوصول: ${err.message}` };
  }
}

function printInfo(info) {
  console.log('--- حالة الويبهوك / webhook state ---');
  console.log('url              :', info.url || '(لا يوجد — polling)');
  console.log('pending_updates  :', info.pending_update_count);
  console.log('last_error       :', info.last_error_message || '(لا يوجد)');
  console.log('last_error_date  :', info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : '-');
  console.log('max_connections  :', info.max_connections ?? '-');
  console.log('secret_token     :', info.has_custom_certificate ? 'custom cert' : SECRET ? 'set (local env)' : 'not set');
}

async function main() {
  const [command = 'info', ...rest] = process.argv.slice(2);
  const force = rest.includes('--force');
  const url = rest.find((a) => a.startsWith('http')) || DEFAULT_URL;

  const me = await callTelegram('getMe');
  console.log(`bot: @${me.username} (${me.id})\n`);

  if (command === 'info') {
    printInfo(await callTelegram('getWebhookInfo'));
    return;
  }

  if (command === 'delete') {
    await callTelegram('deleteWebhook', { drop_pending_updates: false });
    console.log('✅ تم حذف الويبهوك — البوت سيستخدم polling عند تشغيل npm start');
    printInfo(await callTelegram('getWebhookInfo'));
    return;
  }

  if (command === 'set') {
    console.log(`target: ${url}`);
    const check = await probe(url);
    console.log(`probe : ${check.ok ? '✅' : '❌'} ${check.detail}`);

    if (!check.ok && !force) {
      console.error(
        '\nتم الإلغاء: هذا المسار لا يستجيب بمعالج البوت بعد.\n' +
          'نشر الكود على Vercel أولاً، ثم أعد المحاولة. لتجاوز الفحص: --force',
      );
      // Set the code and return rather than process.exit(), which can abort on
      // Windows while fetch sockets are still open.
      process.exitCode = 2;
      return;
    }

    await callTelegram('setWebhook', {
      url,
      drop_pending_updates: true,
      ...(SECRET ? { secret_token: SECRET } : {}),
    });
    console.log('\n✅ تم ضبط الويبهوك\n');

    const info = await callTelegram('getWebhookInfo');
    printInfo(info);
    if (info.last_error_message) {
      console.error('\n⚠️ آخر خطأ من تيليجرام:', info.last_error_message);
      process.exitCode = 3;
    }
    return;
  }

  console.error(`أمر غير معروف: ${command}\nاستخدم: info | set [url] [--force] | delete`);
  process.exit(1);
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
