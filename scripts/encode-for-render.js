// Produces copy-paste-ready Render environment variables.
//
//   npm run render-env
//
// Reads .env + the service account key file, then writes render-secrets.txt
// containing every env var Render needs, with the key base64-encoded so it
// fits on one line. The output file is git-ignored.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

const OUT_FILE = path.join(ROOT, 'render-secrets.txt');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readKeyFile() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.join(ROOT, 'credentials.json');

  if (!fs.existsSync(keyFile)) {
    fail(
      `Service account key not found: ${keyFile}\n` +
        '   Download it from Google Cloud (IAM & Admin -> Service Accounts -> Keys)\n' +
        '   and save it as credentials.json in the project folder.'
    );
  }

  const raw = fs.readFileSync(keyFile, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${keyFile} is not valid JSON.`);
  }

  if (parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) {
    fail(
      `${keyFile} is not a service account key (type: ${parsed.type}).\n` +
        '   Download the JSON key for a service account, not an OAuth client.'
    );
  }

  return { keyFile, parsed, raw };
}

function main() {
  const warnings = [];

  for (const name of ['BOT_TOKEN', 'SPREADSHEET_ID', 'GEMINI_API_KEY']) {
    if (!process.env[name]) fail(`${name} is missing from .env.`);
  }

  if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('AIza')) {
    warnings.push(
      `GEMINI_API_KEY does not look like an AI Studio key (AIza...). Google rejected\n` +
        `   the current value with 401, so AI parsing will fail and only the dash format\n` +
        `   will work. Get a key at https://aistudio.google.com/apikey`
    );
  }

  const { keyFile, parsed, raw } = readKeyFile();

  if (parsed._mock) {
    warnings.push(
      `${path.basename(keyFile)} is the MOCK placeholder (project: ${parsed.project_id}).\n` +
        '   Google will answer "invalid_grant: account not found" and no row will be\n' +
        '   saved. Replace it with a real key, then run npm run render-env again.'
    );
  }

  const base64Key = Buffer.from(raw, 'utf8').toString('base64');

  const lines = [
    '# Render environment variables — paste each value in the dashboard.',
    '# Generated from .env and ' + path.basename(keyFile) + ' on ' + new Date().toISOString(),
    '# NOTE: keep this file private; it contains live credentials.',
    '',
    `BOT_TOKEN=${process.env.BOT_TOKEN}`,
    `SPREADSHEET_ID=${process.env.SPREADSHEET_ID}`,
    `GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`,
    `GEMINI_MODEL=${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}`,
    '',
    '# Full service account JSON, base64-encoded (single line)',
    `GOOGLE_CREDENTIALS_JSON=${base64Key}`,
    '',
  ];

  fs.writeFileSync(OUT_FILE, lines.join('\n'), { mode: 0o600 });

  console.log(`✅ Wrote ${OUT_FILE}`);
  console.log(`   Service account: ${parsed.client_email}`);
  console.log(`   Project:         ${parsed.project_id}`);
  console.log(`   GOOGLE_CREDENTIALS_JSON: ${base64Key.length} chars (base64)`);

  if (warnings.length > 0) {
    console.log('');
    for (const warning of warnings) {
      console.log(`⚠️  ${warning}\n`);
    }
  }

  console.log('\nNext: Render Dashboard -> your service -> Environment -> paste each value.');
  console.log('Then, in Google Sheets, share the spreadsheet with the service account email above (Editor).');
}

main();
