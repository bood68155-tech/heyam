const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const { Telegraf } = require('telegraf');
const { google } = require('googleapis');
const { GoogleGenAI, Type } = require('@google/genai');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is missing. Add it to the .env file (get a token from @BotFather).');
  process.exit(1);
}

if (!SPREADSHEET_ID) {
  console.error('❌ SPREADSHEET_ID is missing. Add it to the .env file.');
  process.exit(1);
}

if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY is missing. Only the dash format will be accepted.');
}

const SPREADSHEET_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

// Arabic headers that are written to row 1 when that row is empty.
const SHEET_HEADERS = [
  'الاسم رباعي',
  'الرقم الجامعي',
  'الشعبة',
  'التخصص',
  'رقم الهاتف واتس',
  'الوقت والتاريخ',
];

const WELCOME_MESSAGE = `أهلاً بك. يرجى إرسال بياناتك بالصيغة التالية:
الاسم رباعي - الرقم الجامعي - الشعبة - التخصص - رقم الهاتف واتس`;

const FORMAT_ERROR_MESSAGE = `⚠️ عذراً، الصيغة غير صحيحة. يرجى إرسال بياناتك بالصيغة التالية:
الاسم رباعي - الرقم الجامعي - الشعبة - التخصص - رقم الهاتف واتس`;

const SUCCESS_MESSAGE = '✅ تم حفظ بياناتك بنجاح في الجدول.';
const SAVE_ERROR_MESSAGE = '❌ حدث خطأ أثناء حفظ البيانات، يرجى المحاولة مرة أخرى.';

// ---------------------------------------------------------------------------
// Bot and Google Sheets clients
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);

let sheetsClient = null;

function getCredentialsKeyFile() {
  return process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'credentials.json');
}

function getSheetsClient() {
  if (!sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: getCredentialsKeyFile(),
      scopes: SPREADSHEET_SCOPES,
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

function quoteSheetTitle(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

// Writes the Arabic headers in row 1 if that row is empty, and returns
// the title of the first sheet of the spreadsheet.
async function ensureHeaders(sheets) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties(title))',
  });

  const sheetTitle =
    meta.data.sheets && meta.data.sheets[0] && meta.data.sheets[0].properties.title;

  if (!sheetTitle) {
    throw new Error('The spreadsheet does not contain any sheet.');
  }

  const headerRow = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetTitle(sheetTitle)}!A1:F1`,
  });

  const values = (headerRow.data.values && headerRow.data.values[0]) || [];
  const isEmpty = values.length === 0 || values.every((value) => String(value ?? '').trim() === '');

  if (isEmpty) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteSheetTitle(sheetTitle)}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }

  return sheetTitle;
}

// Appends one student row: name, id, section, major, WhatsApp number, timestamp.
async function appendStudentRow(sheets, sheetTitle, data) {
  const row = [
    data.name,
    data.studentId,
    data.section,
    data.major,
    data.phone,
    buildTimestamp(),
  ];

  // RAW keeps phone numbers as text so leading zeros are never lost.
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteSheetTitle(sheetTitle)}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// ---------------------------------------------------------------------------
// Gemini parser
// ---------------------------------------------------------------------------
const STUDENT_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING, description: 'الاسم الرباعي للطالب' },
    studentId: { type: Type.STRING, description: 'الرقم الجامعي' },
    section: { type: Type.STRING, description: 'الشعبة: عربي أو انجليزي' },
    major: { type: Type.STRING, description: 'التخصص' },
    phone: { type: Type.STRING, description: 'رقم هاتف الواتس' },
  },
  required: ['name', 'studentId', 'section', 'major', 'phone'],
};

function buildStudentPrompt(text) {
  return `أنت مساعد يستخرج بيانات الطلاب من رسائل تيليجرام.

استخرج الحقول الخمسة التالية من رسالة الطالب:
- name: الاسم الرباعي للطالب كما ورد
- studentId: الرقم الجامعي
- section: الشعبة، ويجب أن تكون "عربي" أو "انجليزي"
- major: التخصص
- phone: رقم هاتف الواتس

القواعد:
- لا تخترع أي بيانات. إذا لم يكن الحقل مذكوراً في الرسالة فأعد نصاً فارغاً "".
- حوّل الأرقام العربية-الهندية (٠١٢٣٤٥٦٧٨٩ و ۰۱۲۳۴۵۶۷۸۹) إلى أرقام إنجليزية.
- أعد الرقم الجامعي ورقم الهاتف أرقاماً فقط بدون مسافات أو شرطات، مع الاحتفاظ بعلامة + في بداية الرقم إن وجدت.
- إذا كانت الرسالة لا تحتوي على بيانات طالب (مثل تحية أو سؤال) فأعد كل الحقول فارغة.

رسالة الطالب:
"""
${text}
"""`;
}

let genaiClient = null;

function getGeminiClient() {
  if (!GEMINI_API_KEY) {
    return null;
  }
  if (!genaiClient) {
    genaiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }
  return genaiClient;
}

// Converts Arabic-Indic digits (٠-٩ / ۰-۹) to ASCII digits.
function normalizeDigits(value) {
  const arabicIndic = '٠١٢٣٤٥٦٧٨٩';
  const extendedArabicIndic = '۰۱۲۳۴۵۶۷۸۹';
  return String(value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const index = arabicIndic.indexOf(digit);
    return index !== -1 ? String(index) : String(extendedArabicIndic.indexOf(digit));
  });
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

// Parses a free-form Arabic message into student fields using Google Gemini.
// Returns null when the message does not contain all five fields.
async function parseStudentDataWithGemini(text) {
  const ai = getGeminiClient();
  if (!ai) {
    return null;
  }

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: buildStudentPrompt(text),
    config: {
      responseMimeType: 'application/json',
      responseSchema: STUDENT_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const raw = typeof response.text === 'string' ? response.text.trim() : '';
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw);
  const data = {
    name: cleanText(parsed.name),
    studentId: normalizeDigits(cleanText(parsed.studentId)).replace(/[\s-]/g, ''),
    section: cleanText(parsed.section),
    major: cleanText(parsed.major),
    phone: normalizeDigits(cleanText(parsed.phone)).replace(/[\s\-()]/g, ''),
  };

  const hasAllFields =
    data.name && data.studentId && data.section && data.major && data.phone;

  return hasAllFields ? data : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// Fallback parser for "الاسم رباعي - الرقم الجامعي - الشعبة - التخصص - رقم الهاتف واتس".
// Returns null when the message does not contain exactly 5 dash-separated fields.
function parseStudentData(text) {
  const parts = text
    .split('-')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length !== 5) {
    return null;
  }

  const [name, studentId, section, major, phone] = parts;
  return { name, studentId, section, major, phone };
}

function buildTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Bot handlers
// ---------------------------------------------------------------------------
bot.command('start', (ctx) => ctx.reply(WELCOME_MESSAGE));

bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();

  // Any other command (/help, /cancel, ...) just shows the format again.
  if (text.startsWith('/')) {
    return ctx.reply(WELCOME_MESSAGE);
  }

  let data = null;
  try {
    data = await parseStudentDataWithGemini(text);
  } catch (error) {
    console.error('Gemini parsing failed, falling back to the dash format:', error.message);
  }

  // Fallback when Gemini is unavailable or returns incomplete fields.
  if (!data) {
    data = parseStudentData(text);
  }

  if (!data) {
    return ctx.reply(FORMAT_ERROR_MESSAGE);
  }

  try {
    const sheets = getSheetsClient();
    const sheetTitle = await ensureHeaders(sheets);
    await appendStudentRow(sheets, sheetTitle, data);
    return ctx.reply(SUCCESS_MESSAGE);
  } catch (error) {
    console.error('Failed to save student data:', error);
    return ctx.reply(SAVE_ERROR_MESSAGE);
  }
});

bot.catch((err, ctx) => {
  console.error(`Unhandled error while processing ${ctx.updateType}:`, err);
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
function main() {
  const keyFile = getCredentialsKeyFile();
  if (!fs.existsSync(keyFile)) {
    console.error('❌ Google service account key file not found.');
    console.error(`   Expected: ${keyFile}`);
    console.error('   Download a service account JSON key from Google Cloud, then either');
    console.error('   rename it to credentials.json or set GOOGLE_APPLICATION_CREDENTIALS in .env.');
    console.error('   Also share the spreadsheet with the service account client_email.');
    process.exit(1);
  }

  console.log('Bot is running... Press Ctrl+C to stop.');
  console.log(`Parsing messages with Gemini model: ${GEMINI_MODEL}`);

  bot.launch(() => {
    console.log('Telegram bot started successfully.');
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { bot, parseStudentData };
