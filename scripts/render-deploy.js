// Applies render-secrets.txt to a Render service and starts a deployment.
//
//   RENDER_API_KEY=rnd_xxx npm run render-deploy
//   RENDER_API_KEY=rnd_xxx npm run render-deploy -- --dry-run
//   RENDER_API_KEY=rnd_xxx npm run render-deploy -- --service srv-abc123
//
// --dry-run parses everything and reports what would change without calling
// the Render API. --force pushes values even when they are known to be
// unusable (mock service account / rejected Gemini key).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SECRETS_FILE = path.join(ROOT, 'render-secrets.txt');
const API = 'https://api.render.com/v1';
const SERVICE_NAME = 'telegram-student-bot';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const serviceFlagIndex = argv.indexOf('--service');
const SERVICE_ID = serviceFlagIndex !== -1 ? argv[serviceFlagIndex + 1] : null;

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) {
    fail(`render-secrets.txt not found. Run "npm run render-env" first.`);
  }

  const env = {};
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }

  const required = ['BOT_TOKEN', 'SPREADSHEET_ID', 'GEMINI_API_KEY', 'GOOGLE_CREDENTIALS_JSON'];
  for (const name of required) {
    if (!env[name]) fail(`${name} is missing or empty in render-secrets.txt.`);
  }

  return env;
}

// Refuses to deploy credentials that Google has already rejected, unless forced.
function checkUsability(env) {
  const problems = [];

  let key;
  try {
    key = JSON.parse(Buffer.from(env.GOOGLE_CREDENTIALS_JSON, 'base64').toString('utf8'));
  } catch {
    fail('GOOGLE_CREDENTIALS_JSON is not valid base64 or does not decode to JSON.');
  }

  if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
    fail('GOOGLE_CREDENTIALS_JSON is not a service account key.');
  }

  if (key._mock) {
    problems.push(
      `GOOGLE_CREDENTIALS_JSON is the MOCK key (project: ${key.project_id}).\n` +
        '   Google will reject every write with "invalid_grant: account not found".'
    );
  }

  if (!env.GEMINI_API_KEY.startsWith('AIza')) {
    problems.push(
      'GEMINI_API_KEY is not an AI Studio key (AIza...); Google returns 401,\n' +
        '   so AI parsing will fail and only the dash format will work.'
    );
  }

  return { problems, clientEmail: key.client_email, projectId: key.project_id };
}

async function api(method, endpoint, body) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RENDER_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data);
    fail(`Render API ${method} ${endpoint} -> HTTP ${response.status}: ${detail}`);
  }

  return data;
}

async function resolveServiceId() {
  if (SERVICE_ID) return SERVICE_ID;

  const services = await api('GET', '/services?limit=100');
  const list = Array.isArray(services) ? services.map((item) => item.service || item) : [];
  const match = list.find((service) => service.name === SERVICE_NAME);

  if (!match) {
    fail(
      `No service named "${SERVICE_NAME}" found in your Render account.\n` +
        '   Create it first: Dashboard -> New -> Blueprint -> this repository.\n' +
        '   Or pass an existing one: npm run render-deploy -- --service srv-xxxxx'
    );
  }

  return match.id;
}

async function waitForDeploy(serviceId, deployId) {
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastStatus = '';

  while (Date.now() < deadline) {
    const deploy = await api('GET', `/services/${serviceId}/deploys/${deployId}`);
    const status = deploy.status || 'unknown';
    if (status !== lastStatus) {
      console.log(`   deploy status: ${status}`);
      lastStatus = status;
    }
    if (['live', 'build_failed', 'update_failed', 'canceled', 'pre_deploy_failed'].includes(status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }

  return 'timeout';
}

async function main() {
  const env = readSecrets();
  const { problems, clientEmail, projectId } = checkUsability(env);
  const vars = Object.entries(env).map(([key, value]) => ({ key, value }));

  console.log(`Read ${vars.length} variables from render-secrets.txt:`);
  for (const [key, value] of Object.entries(env)) {
    const shown = key === 'GOOGLE_CREDENTIALS_JSON' ? `<${value.length} chars base64>` : `${value.slice(0, 6)}...`;
    console.log(`   ${key} = ${shown}`);
  }
  console.log(`   service account: ${clientEmail}`);
  console.log(`   project:         ${projectId}`);

  if (problems.length > 0) {
    console.log('');
    for (const problem of problems) console.log(`⚠️  ${problem}\n`);
  }

  if (DRY_RUN) {
    console.log('🔍 Dry run — no Render API calls made.');
    return;
  }

  if (problems.length > 0 && !FORCE) {
    fail(
      'Refusing to deploy credentials Google will reject — students would get\n' +
        '   "❌ حدث خطأ أثناء حفظ البيانات" on every message.\n' +
        '   Fix credentials.json / GEMINI_API_KEY, re-run "npm run render-env", then retry.\n' +
        '   To deploy anyway: add -- --force'
    );
  }

  if (!process.env.RENDER_API_KEY) {
    fail(
      'RENDER_API_KEY is not set.\n' +
        '   Create one: Render Dashboard -> Account Settings -> API Keys -> Create API Key\n' +
        '   Then: RENDER_API_KEY=rnd_xxx npm run render-deploy'
    );
  }

  const serviceId = await resolveServiceId();
  console.log(`\n▶ Service: ${serviceId}`);

  await api('PUT', `/services/${serviceId}/env-vars`, vars);
  console.log(`✅ Applied ${vars.length} environment variables.`);

  const deploy = await api('POST', `/services/${serviceId}/deploys`, { clearCache: 'do_not_clear' });
  console.log(`✅ Deploy started: ${deploy.id}`);

  const status = await waitForDeploy(serviceId, deploy.id);
  if (status !== 'live') {
    fail(`Deployment finished with status "${status}". Check the Render logs for details.`);
  }

  const service = await api('GET', `/services/${serviceId}`);
  const url = service.serviceDetails?.url || service.url || '';
  console.log(`\n✅ Live${url ? ` at ${url}` : ''}`);
  console.log('');
  console.log('Remaining manual steps:');
  console.log(`  1. Share your Google Sheet with ${clientEmail} as Editor.`);
  console.log(`  2. Point a free pinger (cron-job.org) at ${url || 'the service URL'} every 5-10 minutes;`);
  console.log('     the free tier kills a service after 15 minutes without inbound traffic.');
  console.log('  3. Send /start to the bot in Telegram to confirm it replies.');
}

main().catch((error) => fail(error.message));
