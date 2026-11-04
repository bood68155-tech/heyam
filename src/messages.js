'use strict';

/**
 * All user-facing copy lives here (Arabic first, with English where useful).
 * Keeping it in one module makes the tone consistent and the flows short.
 */

const { escapeHtml, FIELD_LABELS, formatPhone } = require('./utils');

const SEP = '━━━━━━━━━━━━━━━';

function recordBlock(record) {
  return [
    `${SEP}`,
    `👤 <b>${FIELD_LABELS.fullName}:</b> ${escapeHtml(record.fullName)}`,
    `🎓 <b>${FIELD_LABELS.universityId}:</b> <code>${escapeHtml(record.universityId)}</code>`,
    `📚 <b>${FIELD_LABELS.section}:</b> ${escapeHtml(record.section)}`,
    `🧩 <b>${FIELD_LABELS.major}:</b> ${escapeHtml(record.major)}`,
    `📱 <b>${FIELD_LABELS.phone}:</b> ${escapeHtml(formatPhone(record.phone))}`,
    SEP,
  ].join('\n');
}

const messages = {
  recordBlock,

  welcome: `👋 أهلاً بك في بوت تسجيل بيانات الطلاب

سأجمع بياناتك الخمسة وأحفظها في Google Sheets بعد تنظيمها بالذكاء الاصطناعي.

<b>الأوامر:</b>
/add — تسجيل بيانات جديدة
/find — البحث عن بيانات طالب
/delete — حذف سجل (للمشرفين)
/help — المساعدة
/cancel — إلغاء العملية الحالية`,

  help: `ℹ️ <b>كيف يعمل البوت؟</b>

يجمع البوت خمسة حقول:
1️⃣ ${FIELD_LABELS.fullName}
2️⃣ ${FIELD_LABELS.universityId}
3️⃣ ${FIELD_LABELS.section} (عربي أو إنجليزي)
4️⃣ ${FIELD_LABELS.major}
5️⃣ ${FIELD_LABELS.phone}

<b>طريقتان للتسجيل:</b>
• أرسل /add وأجب عن الأسئلة واحداً واحداً.
• أو ألصق كل البيانات في رسالة واحدة، مثلاً:
<pre>الاسم: محمد أحمد علي الصالح
الرقم الجامعي: 20231234
الشعبة: عربي
التخصص: هندسة حاسوب
الهاتف: 0771234567</pre>
وسيتم استخراج الحقول تلقائياً.

<b>تنظيف البيانات:</b> قبل الحفظ يمر السجل على Google Gemini لتوحيد الاسم والتخصص والشعبة ورقم الهاتف، ثم يعرض عليك مراجعة أخيرة.`,

  hint: `أرسل /add للتسجيل، أو /help للمساعدة.`,

  cancelled: `↩️ تم إلغاء العملية. أرسل /add للبدء من جديد.`,

  needAdmin: `⛔ هذا الأمر متاح للمشرفين فقط.`,

  errors: {
    sheets: `❌ تعذّر الوصول إلى Google Sheets حالياً.
تأكد من مشاركة الجدول مع حساب الخدمة ومن صحة الإعدادات، ثم حاول مرة أخرى.`,
    generic: `❌ حدث خطأ غير متوقع. حاول مرة أخرى بعد قليل.`,
    textOnly: `✍️ أرسل الإجابة كنص من فضلك.`,
  },

  add: {
    intro: `📝 <b>تسجيل طالب جديد</b>\nأجب عن الأسئلة التالية، أو ألصق كل البيانات في رسالة واحدة.\nللسياق: /cancel للإلغاء في أي وقت.`,

    ask: {
      fullName: `👤 <b>${FIELD_LABELS.fullName}</b>\nاكتب أربعة أسماء كاملة مفصولة بمسافات.\nمثال: <code>محمد أحمد علي الصالح</code>`,
      universityId: `🎓 <b>${FIELD_LABELS.universityId}</b>\nأرسل الرقم الجامعي بأرقام فقط.\nمثال: <code>20231234</code>`,
      section: `📚 <b>${FIELD_LABELS.section}</b>\nاختر الشعبة:`,
      major: `🧩 <b>${FIELD_LABELS.major}</b>\nمثال: <code>هندسة حاسوب</code> أو <code>علوم إدارية</code>`,
      phone: `📱 <b>${FIELD_LABELS.phone}</b>\nأرسل الرقم مع رمز الدولة إن أمكن.\nمثال: <code>+967771234567</code>`,
    },

    invalid(field, error) {
      const label = FIELD_LABELS[field] || 'الحقل';
      return `⚠️ <b>${label}</b>: ${escapeHtml(error)}`;
    },

    parsing: `🤖 أقرأ البيانات وأستخرج الحقول...`,

    parsedIntro: `✅ استخرجت بعض الحقول من رسالتك. أكمل الناقص فقط:`,

    structuring: `🧠 جاري تنظيم البيانات بالذكاء الاصطناعي...`,

    preview(record, meta = {}) {
      const notes = [];
      if (meta.aiUsed) notes.push('✨ تم تنظيم البيانات تلقائياً بواسطة Google Gemini.');
      else notes.push('ℹ️ تم التنظيم محلياً (خدمة الذكاء الاصطناعي غير متاحة الآن).');
      if (meta.changes?.length) {
        notes.push('<b>تعديلات التنظيم:</b>', ...meta.changes.map((c) => `• ${escapeHtml(c)}`));
      }
      if (meta.notes) notes.push(`📝 ${escapeHtml(meta.notes)}`);

      return [
        `📋 <b>مراجعة البيانات قبل الحفظ</b>`,
        recordBlock(record),
        ...notes,
        '',
        'هل تريد حفظ هذه البيانات في الجدول؟',
      ].join('\n');
    },

    saved(record, range) {
      return [
        `✅ <b>تم حفظ بياناتك بنجاح</b>`,
        recordBlock(record),
        range ? `📄 موقع السجل: <code>${escapeHtml(range)}</code>` : '',
        'شكراً لك! 🎓',
      ]
        .filter(Boolean)
        .join('\n');
    },

    duplicate(existing) {
      return [
        `⚠️ <b>الرقم الجامعي مسجّل مسبقاً</b>`,
        `يوجد سجل بالرقم <code>${escapeHtml(existing.universityId)}</code> باسم ${escapeHtml(existing.fullName)}.`,
        '',
        'إن كانت البيانات خاطئة، تواصل مع المشرف لتعديل السجل.',
      ].join('\n');
    },

    notUnderstood: `🤔 لم أستطع استخراج البيانات من الرسالة.\nأرسل <b>الاسم الرباعي</b> فقط، أو استخدم الصيغة:\n<pre>الاسم: ...\nالرقم الجامعي: ...\nالشعبة: ...\nالتخصص: ...\nالهاتف: ...</pre>`,

    alreadySaved: `ℹ️ لا يوجد سجل بانتظار الحفظ. أرسل /add لبدء تسجيل جديد.`,

    expired: `⚠️ انتهت صلاحية هذه المراجعة ولم أستطع قراءة البيانات منها.\nلم يُحفظ أي شيء — أرسل /add لتسجيل البيانات من جديد.`,
  },

  remove: {
    prompt: `🔎 <b>حذف سجل طالب</b>\nأرسل الاسم أو جزءاً منه، أو الرقم الجامعي.`,

    searching: `🔍 جاري البحث...`,

    notFound(query) {
      return `❌ لم يتم العثور على سجل مطابق لـ «${escapeHtml(query)}».\nتأكد من الاسم أو الرقم الجامعي وحاول مرة أخرى.`;
    },

    multiple(count) {
      return `🔎 وجدنا <b>${count}</b> سجلات مطابقة. اختر السجل المطلوب حذفه:`;
    },

    confirm(record) {
      return [
        `⚠️ <b>تأكيد الحذف</b>`,
        `سيتم حذف السجل التالي نهائياً من الجدول:`,
        recordBlock(record),
        'اضغط <b>تم</b> للتأكيد أو <b>إلغاء</b>.',
      ].join('\n');
    },

    deleted(record) {
      return `✅ <b>تم</b> حذف سجل <b>${escapeHtml(record.fullName)}</b> (${escapeHtml(record.universityId)}).`;
    },

    aborted: `↩️ تم إلغاء الحذف، لم يُحذف أي سجل.`,

    stale: `ℹ️ لا يوجد سجل بانتظار التأكيد. أرسل /delete للبدء من جديد.`,
  },

  find: {
    prompt: `🔎 أرسل الاسم أو الرقم الجامعي للبحث.`,
    results(count) {
      return `🔎 عدد النتائج: <b>${count}</b>`;
    },
  },

  health(ok, info) {
    if (!ok) {
      return `🩺 <b>حالة الخدمات</b>\n❌ Google Sheets: غير متاح\n<code>${escapeHtml(info.error || '')}</code>`;
    }
    return [
      `🩺 <b>حالة الخدمات</b>`,
      `✅ Google Sheets: متصل (${escapeHtml(info.sheetName)})`,
      `📊 عدد السجلات: ${info.count}`,
      `🤖 Gemini: ${info.ai ? 'مفعّل' : 'غير مفعّل (وضع محلي)'}`,
    ].join('\n');
  },
};

module.exports = messages;
