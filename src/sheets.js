'use strict';

/**
 * Google Sheets data layer.
 *
 * Sheet layout (row 1 is written automatically on first run):
 *   A: الاسم الرباعي | B: الرقم الجامعي | C: الشعبة | D: التخصص | E: رقم الهاتف واتس
 *
 * All writes use RAW input so university IDs keep leading zeros and phone
 * numbers are never converted to scientific notation by the Sheets UI.
 */

const { google } = require('googleapis');

const { config } = require('./config');
const logger = require('./logger');
const { FIELD_ORDER, matchesQuery, digitsOnly, formatPhone } = require('./utils');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const HEADERS = ['الاسم الرباعي', 'الرقم الجامعي', 'الشعبة', 'التخصص', 'رقم الهاتف واتس'];
const LAST_COLUMN = 'E';

let clientPromise = null;
let metaCache = null;

// The header check is cached, but only for a few minutes: a long-running
// (polling) instance must notice when someone clears the tab. Otherwise the
// flag stays "already checked" forever and the next student is appended into
// row 1, leaving the sheet without a header row.
const HEADER_TTL_MS = 5 * 60 * 1000;
let headerState = { verifiedAt: 0, status: 'unknown' };

// Serialize mutations: two students pressing "حفظ" at the same time must not
// interleave append/delete operations.
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function quotedSheetName() {
  return `'${String(config.sheets.sheetName).replace(/'/g, "''")}'`;
}

async function getClient() {
  if (!clientPromise) {
    const { options } = config.sheets.credentials;
    const auth = new google.auth.GoogleAuth({ ...options, scopes: SCOPES });
    clientPromise = (async () => {
      const authClient = await auth.getClient();
      return google.sheets({ version: 'v4', auth: authClient });
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/**
 * Make sure the target tab exists and cache its numeric id (needed to delete rows).
 * @returns {Promise<{ sheetId: number, title: string }>}
 */
async function ensureSheet() {
  if (metaCache) return metaCache;

  const sheets = await getClient();
  const { spreadsheetId, sheetName } = config.sheets;

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title))',
  });

  let sheet = (meta.data.sheets || []).find((s) => s.properties?.title === sheetName);

  if (!sheet) {
    logger.info(`Worksheet "${sheetName}" not found — creating it`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }],
      },
    });
    const refreshed = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title))',
    });
    sheet = (refreshed.data.sheets || []).find((s) => s.properties?.title === sheetName);
    if (!sheet) throw new Error(`تعذّر إنشاء ورقة العمل "${sheetName}"`);
  }

  metaCache = { sheetId: sheet.properties.sheetId, title: sheet.properties.title };
  return metaCache;
}

/**
 * Classify row 1 of the tab:
 *   'empty'   nothing written yet — the header row gets written
 *   'header'  already our header row (blank cells are treated as ours to fill)
 *   'foreign' somebody else's data — never overwritten
 */
function headerRowStatus(firstRow = []) {
  const cells = HEADERS.map((_, index) => String(firstRow?.[index] ?? '').trim());
  if (cells.every((cell) => cell === '')) return 'empty';
  // A partially labelled tab (some header cells filled by hand) is still ours
  // as long as no cell holds a value that does not belong to that column.
  const ours = cells.every((cell, index) => cell === '' || cell === HEADERS[index]);
  return ours ? 'header' : 'foreign';
}

/**
 * Bootstrap the header row, so a brand-new spreadsheet needs no manual setup:
 * it is written automatically when the tab is empty and repaired when only some
 * header cells are present. Runs before every read/write through ensureReady().
 *
 * Row 1 is never overwritten when it already holds real data (a student record
 * added by hand, a custom header, …) — losing a record to a bootstrap is worse
 * than a missing header, so that case is reported instead.
 *
 * @returns {Promise<{ created: boolean, repaired: boolean, status: string, cached?: boolean }>}
 */
async function ensureHeader({ force = false } = {}) {
  const fresh = headerState.verifiedAt && Date.now() - headerState.verifiedAt < HEADER_TTL_MS;
  if (fresh && !force) {
    return { created: false, repaired: false, status: headerState.status, cached: true };
  }

  const sheets = await getClient();
  const { spreadsheetId, sheetName } = config.sheets;
  const range = `${quotedSheetName()}!A1:${LAST_COLUMN}1`;

  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const firstRow = current.data.values?.[0] || [];
  const status = headerRowStatus(firstRow);

  if (status === 'foreign') {
    headerState = { verifiedAt: Date.now(), status };
    logger.warn(
      `الصف الأول في "${sheetName}" يحتوي بيانات ليست ترويسة البوت — لم تُكتب الترويسة فوقها`,
    );
    return { created: false, repaired: false, status };
  }

  const exact = HEADERS.every((label, index) => String(firstRow?.[index] ?? '').trim() === label);
  if (exact) {
    headerState = { verifiedAt: Date.now(), status: 'header' };
    return { created: false, repaired: false, status: 'header' };
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADERS] },
  });

  headerState = { verifiedAt: Date.now(), status: 'header' };
  logger.info(
    status === 'empty'
      ? `تم إنشاء صف الترويسة في "${sheetName}": ${HEADERS.join(' | ')}`
      : `تم إكمال صف الترويسة الناقص في "${sheetName}"`,
  );
  return { created: true, repaired: status === 'header', status: status === 'empty' ? 'created' : 'repaired' };
}

/**
 * Make the tab + header row exist before reading or writing.
 *
 * Under long polling `main()` runs a health check at startup, which does this
 * implicitly. A serverless cold start has no such bootstrap, so every data path
 * calls this itself — otherwise the first append fails with
 * "Unable to parse range: 'Students'!A:E" when the tab does not exist yet.
 */
async function ensureReady() {
  await ensureSheet();
  await ensureHeader();
}

/** Read every student row (row 2 onwards) with its real sheet row number. */
async function listStudents() {
  await ensureReady();
  const sheets = await getClient();
  const { spreadsheetId } = config.sheets;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quotedSheetName()}!A2:${LAST_COLUMN}`,
    majorDimension: 'ROWS',
  });

  const rows = res.data.values || [];
  return rows
    .map((row, index) => {
      const cells = FIELD_ORDER.map((_, i) => String(row?.[i] ?? '').trim());
      if (!cells.some(Boolean)) return null; // skip blank rows
      const [fullName, universityId, section, major, phone] = cells;
      return { rowNumber: index + 2, fullName, universityId, section, major, phone };
    })
    .filter(Boolean);
}

/** Append one student record. Returns the row that was written. */
async function appendStudent(student) {
  const values = FIELD_ORDER.map((field) => {
    if (field === 'phone') return formatPhone(student.phone);
    return String(student[field] ?? '').trim();
  });

  await ensureReady();
  const sheets = await getClient();
  const { spreadsheetId } = config.sheets;

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${quotedSheetName()}!A:${LAST_COLUMN}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });

  logger.info(`Appended student record at ${res.data.updates?.updatedRange || 'unknown range'}`);
  return { values, updatedRange: res.data.updates?.updatedRange || null };
}

/** Find students whose name or university ID matches the query. */
async function searchStudents(query) {
  const students = await listStudents();
  return students.filter((student) => matchesQuery(student, query));
}

/** Exact university-ID lookup, used to block duplicate registrations. */
async function findByUniversityId(universityId) {
  const target = digitsOnly(universityId);
  if (!target) return null;
  const students = await listStudents();
  return students.find((s) => digitsOnly(s.universityId) === target) || null;
}

/**
 * Delete a single row by its sheet row number.
 * Refuses to touch the header row (row 1).
 */
async function deleteRow(rowNumber) {
  const row = Number(rowNumber);
  if (!Number.isInteger(row) || row < 2) {
    throw new Error('رقم الصف غير صالح للحذف');
  }

  const sheets = await getClient();
  const { sheetId } = await ensureSheet();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheets.spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
          },
        },
      ],
    },
  });

  logger.info(`Deleted sheet row ${row}`);
  return { rowNumber: row };
}

/** Wrapped mutations, serialized. */
function safeAppend(student) {
  return withWriteLock(() => appendStudent(student));
}

function safeDelete(rowNumber) {
  return withWriteLock(() => deleteRow(rowNumber));
}

/**
 * Prove the whole write path against the real spreadsheet: append a marked row,
 * then delete it again so the sheet is left exactly as it was.
 * Used by GET /health?write=1 to verify credentials *and* permissions.
 */
async function writeRoundTrip() {
  const probe = {
    fullName: 'HEALTH CHECK (صف اختبار يُحذف تلقائياً)',
    universityId: 'HEALTHCHECK',
    section: 'عربي',
    major: 'فحص الكتابة التلقائي',
    phone: '967000000000',
  };

  return withWriteLock(async () => {
    const saved = await appendStudent(probe);
    const rowMatch = /![A-Za-z]+(\d+)/.exec(saved.updatedRange || '');
    if (!rowMatch) {
      return { ok: false, error: 'تعذّر تحديد الصف المكتوب', range: saved.updatedRange };
    }
    const rowNumber = Number(rowMatch[1]);
    await deleteRow(rowNumber);
    return { ok: true, range: saved.updatedRange, deletedRow: rowNumber };
  });
}

/** Startup check: credentials work, sheet is reachable, header present. */
async function healthCheck() {
  try {
    await ensureSheet();
    const header = await ensureHeader();
    const students = await listStudents();
    return {
      ok: true,
      headerCreated: header.created,
      headerStatus: header.status,
      count: students.length,
      sheetName: config.sheets.sheetName,
    };
  } catch (err) {
    // Keep Google's machine-readable reason: PERMISSION_DENIED means the sheet was
    // never shared with the service account, SERVICE_DISABLED means the Sheets API
    // is off in the Cloud project. The message alone cannot tell those apart.
    const reason =
      err?.errors?.[0]?.reason ||
      err?.response?.data?.error?.errors?.[0]?.reason ||
      err?.response?.data?.error?.status ||
      null;

    return {
      ok: false,
      error: err.message,
      status: err?.code || err?.response?.status || null,
      reason,
      sheetName: config.sheets.sheetName,
    };
  }
}

module.exports = {
  HEADERS,
  headerRowStatus,
  ensureSheet,
  ensureHeader,
  ensureReady,
  writeRoundTrip,
  listStudents,
  appendStudent: safeAppend,
  searchStudents,
  findByUniversityId,
  deleteRow: safeDelete,
  healthCheck,
};
