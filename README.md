# بوت تسجيل بيانات الطلاب — Telegram + Google Sheets + Gemini

بوت تيليجرام يجمع بيانات الطلاب الخمسة، ينظّمها بالذكاء الاصطناعي (Google Gemini)،
ويحفظها في Google Sheet — بنفس منطق سيناريو Make.com:
`Trigger (Telegram) ← Parser/Transformer (Gemini) ← Action (Google Sheets)`.

**Overview (EN):** a Telegram bot that collects five student fields interactively,
normalizes them with Gemini (with a deterministic offline fallback), and writes them
to Google Sheets. Admins can search by name or university ID and delete a record
after confirming (`تم` / `Done`).

---

## 1. المكوّنات

| الطبقة | التقنية |
| --- | --- |
| واجهة المحادثة | [grammY](https://grammy.dev) (Long Polling) |
| قاعدة البيانات | Google Sheets API v4 (service account) |
| تنظيم البيانات | Google Gemini (`generateContent` + JSON schema) |
| التشغيل | Node.js ≥ 20 |

الحقول الخمسة (وبنفس هذا الترتيب في الجدول):

1. `الاسم الرباعي` — يجب أن يكون ٤ أسماء (يُحسب «عبد الله» اسماً واحداً)
2. `الرقم الجامعي` — أرقام فقط، ٣ إلى ١٥ رقماً
3. `الشعبة` — `عربي` أو `إنجليزي` (تُقبل كل الصيغ: Arabic / English / انجليزي …)
4. `التخصص`
5. `رقم الهاتف واتس` — يُطبَّع إلى أرقام مع رمز الدولة إن ضُبط `DEFAULT_COUNTRY_CODE`

---

## 2. الإعداد في خمس خطوات

### أ) تثبيت الحزم

```bash
cd student-bot
npm install
cp .env.example .env
```

### ب) إنشاء البوت

1. افتح [@BotFather](https://t.me/BotFather) ← `/newbot`.
2. انسخ التوكن إلى `BOT_TOKEN` في `.env`.
3. لمعرفة معرّفك الرقمي (للمشرفين) استخدم [@userinfobot](https://t.me/userinfobot) وضعه في `ADMIN_IDS`.

### ج) تجهيز Google Sheets

1. أنشئ مشروعاً في [Google Cloud Console](https://console.cloud.google.com/).
2. **APIs & Services ← Library** ← فعّل **Google Sheets API**.
3. **IAM & Admin ← Service Accounts ← Create Service Account** (بدون أدوار خاصة).
4. من الحساب: **Keys ← Add key ← Create new key ← JSON** ونزّل الملف إلى
   `student-bot/credentials/service-account.json`.
5. انسخ بريد حساب الخدمة (`...@....iam.gserviceaccount.com`).
6. أنشئ جدول Google Sheets، ثم **Share** وأضف بريد حساب الخدمة بصلاحية **Editor**.
7. انسخ رابط الجدول إلى `GOOGLE_SHEET_ID` (الرابط الكامل مقبول، ويُستخرج منه المعرّف).

> بدائل لبيانات الاعتماد: `GOOGLE_SERVICE_ACCOUNT_JSON` (الملف كاملاً في سطر واحد)
> أو `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY`.
> هذا مفيد على الاستضافات التي لا تسمح برفع ملفات.

### د) مفتاح Gemini (اختياري لكن مستحسن)

1. احصل على مفتاح من [Google AI Studio](https://aistudio.google.com/apikey).
2. ضعه في `GEMINI_API_KEY`.

بدون مفتاح يعمل البوت بمحلل محلي (Regex + قواعد) — كل شيء يعمل عدا التنظيف الذكي.

### هـ) التشغيل

```bash
npm start      # تشغيل عادي
npm run dev    # إعادة تشغيل تلقائية أثناء التطوير
npm run check  # اختبارات المنطق بدون شبكة (٣٤ تحقق)
```

عند أول تشغيل يُنشئ البوت ورقة العمل (إن لم تكن موجودة) ويكتب صف العناوين.

---

## 3. متغيرات البيئة

| المتغير | إلزامي | الوصف |
| --- | --- | --- |
| `BOT_TOKEN` | نعم | توكن البوت من BotFather |
| `ADMIN_IDS` | لا | معرّفات تيليجرام المسموح لها بالحذف، مفصولة بفواصل (فارغ = الجميع) |
| `GOOGLE_SHEET_ID` | نعم | معرّف الجدول أو رابطه الكامل |
| `GOOGLE_SHEET_NAME` | لا | اسم الورقة، الافتراضي `Students` |
| `GOOGLE_APPLICATION_CREDENTIALS` | نعم* | مسار ملف حساب الخدمة |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | نعم* | بديل: محتوى الملف كـ JSON |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_PRIVATE_KEY` | نعم* | بديل: بيانات مفصولة |
| `GEMINI_API_KEY` | لا | مفتاح Gemini |
| `GEMINI_MODEL` | لا | الافتراضي `gemini-2.5-flash` |
| `DEFAULT_COUNTRY_CODE` | لا | رمز الدولة لأرقام الواتس المحلية (مثال `967`) |
| `LOG_LEVEL` | لا | `debug` / `info` / `warn` / `error` |
| `WEBHOOK_SECRET` | لا | سرّ ويبهوك تيليجرام (يُرسل في هيدر `X-Telegram-Bot-Api-Secret-Token`) |
| `PUBLIC_URL` | لا | عنوان الويبهوك الافتراضي في `npm run webhook:set` |

\* واحد من الخيارات الثلاثة فقط.

> على Vercel لا يوجد ملف على القرص، لذا استخدم `GOOGLE_SERVICE_ACCOUNT_JSON`
> (محتوى الملف كاملاً في سطر واحد) بدلاً من `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 4. هيكل الجدول

| A | B | C | D | E |
| --- | --- | --- | --- | --- |
| الاسم الرباعي | الرقم الجامعي | الشعبة | التخصص | رقم الهاتف واتس |

- الصف الأول (الترويسة) يُكتب تلقائياً: إذا كانت الورقة فارغة يكتبها البوت كاملة،
  وإذا كانت بعض خلاياها فقط مكتوبة يكمل الناقص. لا حاجة لأي إعداد يدوي في Google Sheets.
- لا يُكتب فوق الصف الأول إذا كان يحتوي بيانات حقيقية (سجل أُدخل يدوياً مثلاً)؛
  يُسجَّل تحذير بدلاً من إتلاف السجل، ويعمل التطبيق بشكل طبيعي مع إبقاء الترويسة كما هي.
- تُكتب القيم بصيغة **RAW** حتى يحتفظ الرقم الجامعي بأصفاره البادئة ولا يتحول الهاتف
  إلى صيغة علمية.

---

## 5. الأوامر

| الأمر | الوظيفة | الصلاحية |
| --- | --- | --- |
| `/start` | الترحيب والقائمة | الجميع |
| `/add` | تسجيل طالب جديد (حقل حقل) | الجميع |
| `/find [اسم/رقم]` | بحث وعرض السجلات | الجميع |
| `/delete [اسم/رقم]` | حذف سجل بعد التأكيد | المشرفون |
| `/cancel` | إلغاء العملية الحالية | الجميع |
| `/health` | فحص الاتصال بـ Sheets وحالة Gemini | المشرفون |
| `/help` | شرح الاستخدام | الجميع |

---

## 6. سير العمل

### إضافة طالب

```
/add
  ↓  الاسم الرباعي → الرقم الجامعي → الشعبة (أزرار) → التخصص → الهاتف
  ↓  إعادة تحقق محلية لكل حقل عند الكتابة
  ↓  Gemini: structureRecord()  →  تنظيف وتوحيد (الاسم، الشعبة، الهاتف…)
  ↓  تحقق محلي نهائي (رأي النموذج لا يُعتمد إن خالف القواعد)
  ↓  فحص تكرار الرقم الجامعي
  ↓  معاينة + زر «حفظ» / «إلغاء»
  ↓  Google Sheets: append (صف جديد)
```

**الإدخال دفعة واحدة:** يمكن للطالب لصق كل البيانات في رسالة واحدة بدل الإجابة حقل حقل:

```
الاسم: محمد أحمد علي الصالح
الرقم الجامعي: 20231234
الشعبة: عربي
التخصص: هندسة حاسوب
الهاتف: 0771234567
```

يستخرج البوت الحقول عبر Gemini (`parseStudentText`) ثم يسأل عن الناقص فقط.
يمكن أيضاً لصق البيانات دون كتابة `/add` أصلاً.

### حذف سجل

```
/delete
  ↓  ابحث بالاسم أو الرقم الجامعي (البحث يتجاهل فروق الهمزات: أحمد = احمد)
  ↓  نتيجة واحدة → بطاقة السجل + زر «تم ✅» / «إلغاء»
     نتائج متعددة → قائمة أزرار (حتى ١٠) لاختيار السجل
  ↓  التأكيد بالنقر على «تم» أو بكتابة «تم» / «Done» / «نعم»
  ↓  حذف الصف فعلياً من الجدول (deleteDimension)
  ↓  رسالة تأكيد: «✅ تم حذف سجل …»
```

ملاحظة: الحذف يعتمد على رقم الصف الحقيقي في الجدول، لذا يُنفَّذ فور التأكيد
(لا يُخزَّن للاستخدام لاحقاً).

---

## 7. طبقة الذكاء الاصطناعي

`src/gemini.js` مسؤول عن كل تفاعل مع Gemini عبر REST (`generateContent`) مع
`responseMimeType: application/json` و`responseSchema` — أي مخرجات JSON منظمة
بدل نص حر.

| الدالة | الاستخدام |
| --- | --- |
| `parseStudentText(text)` | رسالة حرة ← كائن حقول جزئي |
| `structureRecord(record)` | سجل كامل ← نسخة منظّمة + قائمة التعديلات |
| `aiEnabled()` | هل المفتاح مضبوط؟ |

**ضمانات:**

- كل قيمة من النموذج تُمرَّر على `validators.js`؛ إن كانت غير صالحة تُرفض ويُستخدم
  التحقق المحلي.
- عند فشل الشبكة أو انتهاء الحصة أو غياب المفتاح: `heuristic.js` (محلل محلي) يكمل
  العمل، ويظهر ذلك للمستخدم في المعاينة.
- التعديلات تُعرض في شاشة المراجعة (`👤 الاسم: "محمد احمد…" ← "محمد أحمد…"`).
- `temperature` منخفضة (0–0.05) لتقليل الانحراف.

### مقابل Make.com

| خطوة Make | هنا |
| --- | --- |
| Telegram Bot → Watch Updates | `src/index.js` (Long Polling) |
| Text parser / AI module | `src/gemini.js` + `src/heuristic.js` |
| Filter / validation | `src/validators.js` |
| Google Sheets → Add a Row | `src/sheets.js` `appendStudent()` |
| Google Sheets → Delete a Row | `src/sheets.js` `deleteRow()` |
| Router + human confirmation | `src/flows/*.js` |

---

## 8. بنية المشروع

```
src/
  index.js            تشغيل البوت وتوجيه التحديثات
  config.js           قراءة .env والتحقق من الإعدادات
  messages.js         كل نصوص الواجهة (عربي)
  state.js            حالة المحادثة في الذاكرة (TTL = ٣٠ دقيقة)
  validators.js       تحقق وتطبيع الحقول الخمسة
  utils.js            تطبيع عربي، أرقام، هواتف، مطابقة البحث
  heuristic.js        محلل محلي بديل عن Gemini
  gemini.js           تكامل Gemini + مواءمة المخرجات
  sheets.js           قراءة/إضافة/حذف في Google Sheets
  logger.js           سجل موحّد بدون أسرار
  flows/
    addStudent.js     محادثة الإضافة + المعاينة + الحفظ
    deleteStudent.js  البحث + التأكيد + الحذف
    findStudent.js    بحث للقراءة فقط
scripts/selfcheck.js  اختبارات بدون شبكة (npm run check)
scripts/webhook.js    إدارة ويبهوك تيليجرام (info / set / delete)
api/webhook.js        نقطة دخول Vercel (وضع الويبهوك)
api/health.js         تشخيص النشر: قراءة/كتابة فعلية على الجدول + آخر الأخطاء
vercel.json           إعدادات Vercel: المسار + إعدادات الدالة
```

---

## 9. النشر

```bash
npm install --omit=dev
npm start
```

- **pm2** (Linux/Windows): `pm2 start src/index.js --name student-bot && pm2 save`.
- **Windows بدون pm2**: أنشئ مهمة في Task Scheduler تعمل عند بدء التشغيل وتنفّذ
  `node src/index.js` من مجلد المشروع.
- يعمل Long Polling افتراضياً — لا تحتاج دومين أو HTTPS.

السجلات تُطبع على stdout؛ `LOG_LEVEL=debug` لمزيد من التفاصيل.

### النشر على Vercel (وضع الويبهوك)

المسار الجاهز: `POST /api/webhook` (ومنه يعمل `GET` لحالة الخدمة).
Vercel يدعو الدالة بـ `(req, res)` لذا يستخدم `api/webhook.js` محوّل `http` من grammY
(لا يوجد محوّل باسم `vercel` في grammY 1.x).

1. أضف المتغيرات في **Vercel → Settings → Environment Variables** — خاصّة
   `BOT_TOKEN` و`GOOGLE_SHEET_ID` و`GOOGLE_SERVICE_ACCOUNT_JSON` و`GEMINI_API_KEY`.
2. انشر المشروع (ربط Git: كل `push` إلى `main` يعيد النشر تلقائياً).
3. تأكّد أن المسار يستجيب:
   ```bash
   curl https://heyam-five.vercel.app/api/webhook
   ```
   يجب أن يعيد JSON فيه `"service":"heyam student bot"`.

   ولتشخيص الكتابة إلى الجدول (صلاحية حساب الخدمة + القراءة + الكتابة):
   ```bash
   curl https://heyam-five.vercel.app/health
   curl "https://heyam-five.vercel.app/health?write=1"   # يضيف صفاً ثم يحذفه
   ```
   `?write=1` يضيف صفاً موسوماً `HEALTH CHECK` ثم يحذفه فوراً، فيثبت أن الكتابة
   تعمل دون أن يترك أثراً. الاستجابة `503` تعني أن هناك خللاً، و`problems` و
   `recent` فيهما السبب الفعلي من داخل الدالة (لأن سجلات Vercel لا تُقرأ إلا من لوحة التحكم).
4. اضبط الويبهوك (يفحص المسار أولاً ويرفض إن لم يكن جاهزاً):
   ```bash
   npm run webhook:set        # أو: npm run webhook:set -- https://your-domain/api/webhook
   npm run webhook:info
   ```

⚠️ الويبهوك و Long Polling لا يعملان معاً. قبل تشغيل `npm start` محلياً نفّذ
`npm run webhook:delete`، وإلا أعاد تيليجرام خطأ `409 Conflict`.

---

## 10. ملاحظات أمنية وحدود معروفة

- **لا ترفع** `.env` أو ملف حساب الخدمة إلى Git (مستبعدان في `.gitignore`).
- اترك `ADMIN_IDS` مضبوطاً في الإنتاج، وإلا أصبح الحذف متاحاً للجميع.
- الجلسات في الذاكرة: على Vercel قد يصل زر «حفظ» إلى نسخة (instance) أخرى فلا
  تجد الجلسة. لذلك يُعاد بناء السجل من رسالة المراجعة نفسها قبل الحفظ، ويُتحقّق من
  عدم تكرار الرقم الجامعي — فلا تضيع بيانات الطالب. أما فقدان الجلسة في منتصف
  الأسئلة فيعني إعادة `/add`.
- إعادة تشغيل البوت تُلغي أي محادثة نصف مكتملة (الجدول يبقى سليماً).
- الحذف بالاعتماد على رقم الصف: إذا كان أحدهم يحرّر الجدول يدوياً في اللحظة نفسها
  فقد يتغيّر ترقيم الصفوف؛ استخدم `/health` و`/find` للتحقق عند الشك.
- لا يوجد سجل تدقيق دائم للحذف (يمكن إضافته لاحقاً بورقة `Audit`).
- التعديل (update) لسجل قائم غير منفّذ — الإضافة والحذف فقط حسب المتطلبات.
- حدود Gemini: `maxOutputTokens = 1024`، مهلة ٢٠ ثانية، محاولتان.

---

## 11. التحقق

```bash
npm run check
```

يفحص ٢١ حالة: تحويل الأرقام العربية، تطبيع الهمزات، قواعد الاسم الرباعي،
رقم الهاتف مع رمز الدولة، مطابقة الشعبة، البحث بالاسم/الرقم، محلل الإدخال الحر
(بالعربية والإنجليزية)، ورفض المدخلات غير الصالحة.

اختبار الاتصال الفعلي بـ Google/Gemini يتم عبر `/health` داخل تيليجرام بعد التشغيل.
