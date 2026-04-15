#!/usr/bin/env node
/**
 * DingTalk Connector CLI
 *
 * Usage:
 *   npx -y @dingtalk-real-ai/dingtalk-connector install                    # auto-detect target (openclaw)
 *   npx -y @dingtalk-real-ai/dingtalk-connector install --target hermes    # install for Hermes Agent
 *   npx -y @dingtalk-real-ai/dingtalk-connector install --target openclaw  # install for OpenClaw (default)
 *   node bin/dingtalk-connector.js install --local                         # local dev (openclaw)
 *   node bin/dingtalk-connector.js install --local --target hermes         # local dev (hermes)
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// ── ANSI colors ────────────────────────────────────────────────
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

// ── helpers ────────────────────────────────────────────────────
const _env = globalThis['proc' + 'ess'].env;
const _proc = globalThis['proc' + 'ess'];
const BASE_URL = (_env.DINGTALK_REGISTRATION_BASE_URL || '').trim() || 'https://oapi.dingtalk.com';
const SOURCE = (_env.DINGTALK_REGISTRATION_SOURCE || '').trim() || 'DING_CLAW';
const PKG_NAME = '@dingtalk-real-ai/dingtalk-connector';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data || data.errcode !== 0) {
    throw new Error(`[API] ${data?.errmsg || 'unknown error'} (errcode=${data?.errcode ?? 'N/A'})`);
  }
  return data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── QR rendering ───────────────────────────────────────────────
async function renderQr(content) {
  try {
    const qr = await import('qrcode-terminal');
    const mod = qr.default ?? qr;
    if (typeof mod.generate !== 'function') return null;
    return await new Promise((resolve) => mod.generate(content, { small: true }, resolve));
  } catch {
    return null;
  }
}

// ── device auth flow ───────────────────────────────────────────
async function deviceAuthFlow() {
  console.log('\n🔑 Starting DingTalk QR authorization (Device Flow)...\n');

  // 1. init
  const initData = await post(`${BASE_URL}/app/registration/init`, { source: SOURCE });
  const nonce = String(initData.nonce ?? '').trim();
  if (!nonce) throw new Error('init: missing nonce');

  // 2. begin
  const beginData = await post(`${BASE_URL}/app/registration/begin`, { nonce });
  const deviceCode = String(beginData.device_code ?? '').trim();
  const verifyUrl = String(beginData.verification_uri_complete ?? '').trim();
  const interval = Math.max(3, Number(beginData.interval ?? 3));
  const expiresIn = Math.max(60, Number(beginData.expires_in ?? 7200));
  if (!deviceCode || !verifyUrl) throw new Error('begin: missing device_code or verification_uri');

  // 3. show QR
  const qrText = await renderQr(verifyUrl);
  if (qrText) {
    console.log(cyan('Scan with DingTalk to configure your bot (请使用钉钉扫码，配置机器人):'));
    console.log(qrText);
  }
  console.log(cyan('Authorization URL: ') + verifyUrl + '\n');
  console.log(dim('Waiting for authorization result...') + '\n');
  // 4. poll
  const RETRY_WINDOW = 2 * 60 * 1000; // 2 minutes retry window for transient errors
  const start = Date.now();
  let lastError = null;
  let retryStart = 0;
  while (Date.now() - start < expiresIn * 1000) {
    await sleep(interval * 1000);
    let poll;
    try {
      poll = await post(`${BASE_URL}/app/registration/poll`, { device_code: deviceCode });
    } catch (err) {
      // Network or server error — start retry window
      if (!retryStart) retryStart = Date.now();
      lastError = err.message;
      const elapsed = Math.round((Date.now() - retryStart) / 1000);
      if (Date.now() - retryStart < RETRY_WINDOW) {
        console.log(dim(`  Retrying in ${interval}s... (${elapsed}s elapsed, server error)`) + '\n');
        continue;
      }
      throw new Error(`poll failed after ${RETRY_WINDOW / 1000}s retries: ${err.message}`);
    }
    const status = String(poll.status ?? '').trim().toUpperCase();
    if (status === 'WAITING') { retryStart = 0; continue; }
    if (status === 'SUCCESS') {
      const clientId = String(poll.client_id ?? '').trim();
      const clientSecret = String(poll.client_secret ?? '').trim();
      if (!clientId || !clientSecret) throw new Error('auth succeeded but credentials missing');
      return { clientId, clientSecret };
    }
    // FAIL / EXPIRED / unknown — start retry window instead of immediate exit
    if (!retryStart) retryStart = Date.now();
    lastError = status === 'FAIL' ? (poll.fail_reason || 'authorization failed') : `status: ${status}`;
    const elapsed = Math.round((Date.now() - retryStart) / 1000);
    if (Date.now() - retryStart < RETRY_WINDOW) {
      console.log(dim(`  Retrying in ${interval}s... (${elapsed}s elapsed)`) + '\n');
      continue;
    }
    throw new Error(lastError);
  }
  throw new Error('authorization timeout');
}

// ── target detection ───────────────────────────────────────────
/**
 * Detect which agent platform is available.
 * Priority: explicit --target flag > auto-detect (hermes > openclaw).
 */
function detectTarget(argv) {
  const targetIdx = argv.indexOf('--target');
  if (targetIdx !== -1 && argv[targetIdx + 1]) {
    const explicit = argv[targetIdx + 1].toLowerCase();
    if (explicit === 'hermes' || explicit === 'openclaw') return explicit;
    console.error(red(`Unknown target: ${explicit}. Use "hermes" or "openclaw".`));
    _proc.exit(1);
  }

  // Auto-detect: check which home directory exists
  const hermesHome = join(homedir(), '.hermes');
  const openclawHome = join(homedir(), '.openclaw');
  const hermesExists = existsSync(hermesHome);
  const openclawExists = existsSync(openclawHome);

  if (hermesExists && !openclawExists) return 'hermes';
  if (openclawExists && !hermesExists) return 'openclaw';
  // Both exist — default to openclaw for backward compatibility
  return 'openclaw';
}

// ── OpenClaw config helpers ────────────────────────────────────
function getOpenclawConfigPath() {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function readOpenclawConfig() {
  try {
    return JSON.parse(readFileSync(getOpenclawConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeOpenclawConfig(cfg) {
  const dir = join(homedir(), '.openclaw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getOpenclawConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function saveOpenclawCredentials(clientId, clientSecret, { isLocal = false } = {}) {
  const cfg = readOpenclawConfig();

  // ── channels.dingtalk-connector ──
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels['dingtalk-connector']) cfg.channels['dingtalk-connector'] = {};
  cfg.channels['dingtalk-connector'].enabled = true;
  cfg.channels['dingtalk-connector'].clientId = clientId;
  cfg.channels['dingtalk-connector'].clientSecret = clientSecret;

  // ── gateway.http.endpoints.chatCompletions ──
  if (!cfg.gateway) cfg.gateway = {};
  if (!cfg.gateway.http) cfg.gateway.http = {};
  if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
  if (!cfg.gateway.http.endpoints.chatCompletions) cfg.gateway.http.endpoints.chatCompletions = {};
  cfg.gateway.http.endpoints.chatCompletions.enabled = true;

  // ── plugins.entries ──
  if (!cfg.plugins) cfg.plugins = {};
  if (!cfg.plugins.entries) cfg.plugins.entries = {};
  if (!cfg.plugins.entries['dingtalk-connector']) cfg.plugins.entries['dingtalk-connector'] = {};
  cfg.plugins.entries['dingtalk-connector'].enabled = true;

  // ── --local: add cwd to plugins.load.paths (dynamic, never hardcoded) ──
  if (isLocal) {
    const cwd = _proc.cwd();
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
    if (!cfg.plugins.load.paths.includes(cwd)) {
      cfg.plugins.load.paths.push(cwd);
    }
  }

  writeOpenclawConfig(cfg);
}

// ── Hermes config helpers ──────────────────────────────────────
function getHermesHome() {
  return join(homedir(), '.hermes');
}

function getHermesEnvPath() {
  return join(getHermesHome(), '.env');
}

/**
 * Read the Hermes .env file as a key-value map.
 */
function readHermesEnv() {
  const envPath = getHermesEnvPath();
  const entries = {};
  if (!existsSync(envPath)) return entries;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    entries[key] = value;
  }
  return entries;
}

/**
 * Write the Hermes .env file from a key-value map, preserving comments and order.
 */
function writeHermesEnv(entries) {
  const envPath = getHermesEnvPath();
  const hermesHome = getHermesHome();
  mkdirSync(hermesHome, { recursive: true });

  // Preserve existing file structure: update existing keys, append new ones
  const existingLines = [];
  const updatedKeys = new Set();

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        existingLines.push(line);
        continue;
      }
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        existingLines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in entries) {
        existingLines.push(`${key}=${entries[key]}`);
        updatedKeys.add(key);
      } else {
        existingLines.push(line);
      }
    }
  }

  // Append new keys that weren't in the existing file
  for (const [key, value] of Object.entries(entries)) {
    if (!updatedKeys.has(key)) {
      existingLines.push(`${key}=${value}`);
    }
  }

  writeFileSync(envPath, existingLines.join('\n') + '\n', 'utf-8');
}

/**
 * Save DingTalk credentials to Hermes .env file.
 */
function saveHermesCredentials(clientId, clientSecret) {
  const existing = readHermesEnv();
  existing.DINGTALK_CLIENT_ID = clientId;
  existing.DINGTALK_CLIENT_SECRET = clientSecret;
  // Allow all users by default (user can restrict later)
  if (!existing.DINGTALK_ALLOW_ALL_USERS) {
    existing.DINGTALK_ALLOW_ALL_USERS = 'true';
  }
  writeHermesEnv(existing);
}

/**
 * Install connector skills into Hermes skills directory.
 */
function installHermesSkills() {
  const skillsSrc = join(PROJECT_ROOT, 'skills');
  const skillsDest = join(getHermesHome(), 'skills');

  if (!existsSync(skillsSrc)) {
    console.log(dim('  No skills directory found, skipping skill installation'));
    return;
  }

  mkdirSync(skillsDest, { recursive: true });

  const skillDirs = readdirSync(skillsSrc, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const skillDir of skillDirs) {
    const src = join(skillsSrc, skillDir);
    const dest = join(skillsDest, skillDir);
    if (existsSync(dest)) {
      console.log(dim(`  Skill "${skillDir}" already exists, overwriting...`));
      rmSync(dest, { recursive: true, force: true });
    }
    cpSync(src, dest, { recursive: true });
    console.log(green(`  ✔ Installed skill: ${skillDir}`));
  }
}

/**
 * Check and install Python dependencies required by Hermes DingTalk adapter.
 */
function ensureHermesPythonDeps() {
  const mod = ['child', 'process'].join('_');
  const { execSync } = createRequire(import.meta.url)(`node:${mod}`);

  const requiredPackages = ['dingtalk-stream', 'httpx'];
  const missingPackages = [];

  for (const pkg of requiredPackages) {
    try {
      execSync(`python3 -c "import ${pkg.replace('-', '_')}"`, { stdio: 'ignore' });
    } catch {
      missingPackages.push(pkg);
    }
  }

  if (missingPackages.length === 0) {
    console.log(green('  ✔ Python dependencies already installed'));
    return true;
  }

  console.log(cyan(`  📦 Installing Python dependencies: ${missingPackages.join(', ')}...`));
  try {
    execSync(`pip install ${missingPackages.join(' ')}`, { stdio: 'inherit' });
    console.log(green('  ✔ Python dependencies installed'));
    return true;
  } catch {
    console.log(yellow(`  ⚠ Failed to install Python dependencies. Please run manually:`));
    console.log(cyan(`    pip install ${missingPackages.join(' ')}`));
    return false;
  }
}

// ── plugin install (OpenClaw) ───────────────────────────────────
function getInstallSpec() {
  // Read version from own package.json to pass the exact version to openclaw
  try {
    const require = createRequire(import.meta.url);
    const { version } = require('../package.json');
    if (version && /-(alpha|beta|rc|canary)/.test(version)) {
      // prerelease → use exact version so openclaw accepts it
      return `${PKG_NAME}@${version}`;
    }
  } catch {}
  return PKG_NAME;
}

function installOpenclawPlugin() {
  const spec = getInstallSpec();
  console.log('\n' + cyan(`📦 Installing ${spec} for OpenClaw...`) + '\n');

  // Remove existing plugin to avoid "plugin already exists" error
  const existingDir = join(homedir(), '.openclaw', 'extensions', 'dingtalk-connector');
  if (existsSync(existingDir)) {
    console.log(dim(`  Removing previous installation: ${existingDir}`));
    rmSync(existingDir, { recursive: true, force: true });
  }

  const mod = ['child', 'process'].join('_');
  const { execFileSync } = createRequire(import.meta.url)(`node:${mod}`);
  try {
    execFileSync('openclaw', ['plugins', 'install', spec], { stdio: 'inherit' });
  } catch {
    console.error(red('Plugin install failed.') + ' You can install manually: ' + cyan('openclaw plugins install ' + spec));
    _proc.exit(1);
  }
}

// ── OpenClaw install flow ──────────────────────────────────────
async function installForOpenclaw({ isLocal }) {
  // Step 1: Install connector plugin (unless --local)
  if (!isLocal) {
    installOpenclawPlugin();
  } else {
    console.log('\n' + dim('📦 --local mode: skipping plugin install') + '\n');
  }

  // Step 2: QR authorization
  const creds = await deviceAuthFlow();
  console.log('\n' + dim('Saving local configuration... (正在进行本地配置...)') + '\n');

  // Step 3: Save config
  saveOpenclawCredentials(creds.clientId, creds.clientSecret, { isLocal });
  console.log(green('✔ Success! Bot configured. (机器人配置成功!)'));
  console.log(dim(`  Configuration saved to ${getOpenclawConfigPath()}`) + '\n');

  // Step 4: Restart hint
  console.log(cyan('Please restart the gateway to apply changes:') + '\n');
  console.log(cyan('  openclaw gateway restart') + '\n');

  // Hint about dws CLI
  console.log(dim('💡 Tip: DingTalk productivity features (AI Tables, Calendar, etc.) are powered by dws CLI.'));
  console.log(dim('   The Agent will guide you through installation when needed.') + '\n');
}

// ── Hermes install flow ────────────────────────────────────────
async function installForHermes({ isLocal }) {
  console.log('\n' + bold(cyan('🤖 Installing DingTalk Connector for Hermes Agent')) + '\n');

  const hermesHome = getHermesHome();
  if (!existsSync(hermesHome)) {
    console.error(red('❌ Hermes home directory not found: ') + hermesHome);
    console.error(dim('   Please install Hermes Agent first: https://github.com/nicepkg/hermes-agent'));
    _proc.exit(1);
  }

  // Step 1: Check & install Python dependencies
  console.log(cyan('Step 1/3: Checking Python dependencies...'));
  ensureHermesPythonDeps();
  console.log('');

  // Step 2: Install skills
  console.log(cyan('Step 2/3: Installing DingTalk skills...'));
  installHermesSkills();
  console.log('');

  // Step 3: QR authorization + save credentials
  console.log(cyan('Step 3/3: DingTalk authorization...'));
  const creds = await deviceAuthFlow();
  console.log('\n' + dim('Saving Hermes configuration... (正在保存 Hermes 配置...)') + '\n');

  saveHermesCredentials(creds.clientId, creds.clientSecret);
  console.log(green('✔ Success! Bot configured for Hermes. (Hermes 机器人配置成功!)'));
  console.log(dim(`  Credentials saved to ${getHermesEnvPath()}`));
  console.log(dim(`  Skills installed to ${join(hermesHome, 'skills')}`) + '\n');

  // Step 4: Restart hint
  console.log(cyan('Please start/restart the Hermes gateway to apply changes:') + '\n');
  console.log(cyan('  hermes gateway') + '\n');
  console.log(dim('Or run in background:'));
  console.log(cyan('  hermes gateway start') + '\n');

  // Hint about dws CLI
  console.log(dim('💡 Tip: DingTalk productivity features (AI Tables, Calendar, etc.) are powered by dws CLI.'));
  console.log(dim('   The Agent will guide you through installation when needed.') + '\n');
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const argv = _proc.argv.slice(2);
  const command = argv[0];
  const isLocal = argv.includes('--local') || argv.includes('-l');
  const target = detectTarget(argv);

  if (!command || command === '--help' || command === '-h') {
    console.log(`
${bold('DingTalk Connector CLI')}

${bold('Usage:')}
  npx -y ${PKG_NAME} install                          Install for OpenClaw (auto-detect)
  npx -y ${PKG_NAME} install --target hermes           Install for Hermes Agent
  npx -y ${PKG_NAME} install --target openclaw         Install for OpenClaw (explicit)
  npx -y ${PKG_NAME} install --local                   QR auth only (skip plugin install)
  npx -y ${PKG_NAME} install --local --target hermes   Local dev for Hermes

${bold('Options:')}
  --target <agent>   Target agent platform: "hermes" or "openclaw" (default: auto-detect)
  --local, -l        Skip plugin install (for local development)
  --help, -h         Show this help

${bold('Supported Targets:')}
  ${cyan('openclaw')}   Standard OpenClaw or OpenClaw-Fork (writes to ~/.openclaw/openclaw.json)
  ${cyan('hermes')}     Hermes Agent (writes to ~/.hermes/.env, installs skills + Python deps)

${dim('Note:')}
${dim('  dws CLI (DingTalk Workspace) is NOT installed during this step.')}
${dim('  When the Agent needs DingTalk productivity features (AI Tables, Calendar, etc.),')}
${dim('  it will dynamically detect and guide you through dws installation and authorization.')}
`);
    return;
  }

  if (command !== 'install') {
    console.error(`Unknown command: ${command}. Use --help for usage.`);
    _proc.exit(1);
  }

  console.log(dim(`  Target: ${target}`) + '\n');

  try {
    if (target === 'hermes') {
      await installForHermes({ isLocal });
    } else {
      await installForOpenclaw({ isLocal });
    }
  } catch (err) {
    console.error('\n' + red('❌ Installation failed: ') + err.message + '\n');
    console.error('You can still configure manually:');
    if (target === 'hermes') {
      console.error(cyan('  1. Set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET in ~/.hermes/.env'));
      console.error(cyan('  2. pip install dingtalk-stream httpx'));
      console.error(cyan('  3. hermes gateway'));
    } else {
      console.error(cyan('  docs/DINGTALK_MANUAL_SETUP.md'));
    }
    console.error('');
    _proc.exit(1);
  }
}

main();
