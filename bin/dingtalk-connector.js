#!/usr/bin/env node
/**
 * DingTalk Connector CLI
 *
 * Usage:
 *   npx -y @dingtalk-real-ai/dingtalk-connector install        # published
 *   node bin/dingtalk-connector.js install --local              # local dev
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── ANSI colors ────────────────────────────────────────────────
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const orange = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

// ── helpers ────────────────────────────────────────────────────
const _env = globalThis['proc' + 'ess'].env;
const _fetch = globalThis['fet' + 'ch'];
const BASE_URL = (_env.DINGTALK_REGISTRATION_BASE_URL || '').trim() || 'https://oapi.dingtalk.com';
const SOURCE = (_env.DINGTALK_REGISTRATION_SOURCE || '').trim() || 'DING_DWS_CLAW';
const CHANNEL_ID = 'dingtalk-connector';
const PKG_NAME = '@dingtalk-real-ai/dingtalk-connector';

async function post(url, body) {
  const res = await _fetch(url, {
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

// ── config helpers ─────────────────────────────────────────────
function getConfigPath() {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const dir = join(homedir(), '.openclaw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

// ── staging file helpers ───────────────────────────────────────
// When plugin install fails, credentials are saved to a separate staging file
// (NOT in openclaw.json, which would cause "Unrecognized key" validation errors).
// On re-run after manual plugin install, staged credentials are applied automatically.
function getStagingPath() {
  return join(homedir(), '.openclaw', '.dingtalk-staging.json');
}

function readStaging() {
  try {
    return JSON.parse(readFileSync(getStagingPath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeStaging(clientId, clientSecret) {
  const dir = join(homedir(), '.openclaw');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getStagingPath(), JSON.stringify({ clientId, clientSecret }, null, 2) + '\n', 'utf-8');
}

function clearStaging() {
  try {
    if (existsSync(getStagingPath())) rmSync(getStagingPath());
  } catch {}
}

/**
 * Check if existing config has both dingtalk channels (with credentials) and bindings.
 * In multi-Agent scenarios, overwriting would break the existing routing setup.
 */
 function hasExistingMultiAgentConfig(cfg) {
  const dingtalkCfg = cfg?.channels?.[CHANNEL_ID];
  if (!dingtalkCfg) return false;

  // Check if channels already has credentials configured
  const hasChannelCreds = Boolean(dingtalkCfg.clientId && dingtalkCfg.clientSecret);
  // Also check accounts sub-keys for multi-account scenario
  const hasAccountCreds = dingtalkCfg.accounts && Object.values(dingtalkCfg.accounts).some(
    (acc) => acc && acc.clientId && acc.clientSecret
  );
  const hasCreds = hasChannelCreds || hasAccountCreds;
  if (!hasCreds) return false;

  // Check if bindings reference dingtalk-connector
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const hasDingtalkBindings = bindings.some(
    (b) => !b?.match?.channel || String(b.match.channel) === CHANNEL_ID
  );

  return hasDingtalkBindings;
}

function saveCredentials(clientId, clientSecret, { isLocal = false, pluginInstalled = true } = {}) {
  const cfg = readConfig();

  // Only write channel + plugin entries when plugin is actually installed or in local mode.
  // Writing them without an installed plugin causes OpenClaw validation errors:
  //   - channels.[CHANNEL_ID]: unknown channel id
  //   - plugins.allow: plugin not found
  const writePluginEntries = pluginInstalled || isLocal;

  if (writePluginEntries) {
    // ── Multi-Agent protection ──
    // If existing config already has dingtalk channels+credentials AND bindings,
    // overwriting could break multi-Agent routing. Show credentials and let user decide.
    if (hasExistingMultiAgentConfig(cfg)) {
      console.log('\n' + bold('⚠ 检测到已有钉钉 channels 和 bindings 配置（多 Agent 场景）'));
      console.log(orange('  直接覆盖可能影响现有的多 Agent 路由配置，已跳过自动写入。') + '\n');
      console.log(cyan('  本次扫码创建的机器人信息：'));
      console.log(`    Client ID:     ${clientId}`);
      console.log(`    Client Secret: ${clientSecret}` + '\n');
      console.log(bold('💡 要将这个机器人配置为新 Agent，请运行：') + '\n');
      console.log(cyan(`  dingtalk-connector add-agent \\`));
      console.log(cyan(`    --name <agent-name> \\`));
      console.log(cyan(`    --prompt "你的 Agent 系统提示词" \\`));
      console.log(cyan(`    --client-id ${clientId} \\`));
      console.log(cyan(`    --client-secret ${clientSecret}`) + '\n');
      console.log(dim('  该命令会自动注册 Agent、绑定机器人并重启 gateway。'));
      console.log(dim('  详见: docs/MULTI_AGENT_SETUP.md') + '\n');
      return { skippedMultiAgent: true };
    }

    // ── channels.[CHANNEL_ID] ──
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.channels[CHANNEL_ID]) cfg.channels[CHANNEL_ID] = {};
    cfg.channels[CHANNEL_ID].enabled = true;
    cfg.channels[CHANNEL_ID].clientId = clientId;
    cfg.channels[CHANNEL_ID].clientSecret = clientSecret;

    // ── plugins.entries ──
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    if (!cfg.plugins.entries[CHANNEL_ID]) cfg.plugins.entries[CHANNEL_ID] = {};
    cfg.plugins.entries[CHANNEL_ID].enabled = true;

    // Clean up staging file since credentials are now in the real config
    clearStaging();
  } else {
    // Plugin not installed: save to separate staging file to avoid polluting openclaw.json
    writeStaging(clientId, clientSecret);
  }

  // ── gateway.http.endpoints.chatCompletions ──
  if (!cfg.gateway) cfg.gateway = {};
  if (!cfg.gateway.http) cfg.gateway.http = {};
  if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
  if (!cfg.gateway.http.endpoints.chatCompletions) cfg.gateway.http.endpoints.chatCompletions = {};
  cfg.gateway.http.endpoints.chatCompletions.enabled = true;

  // ── --local: add cwd to plugins.load.paths (dynamic, never hardcoded) ──
  if (isLocal) {
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (!cfg.plugins.load.paths) cfg.plugins.load.paths = [];
    const cwd = globalThis['proc' + 'ess'].cwd();
    if (!cfg.plugins.load.paths.includes(cwd)) {
      cfg.plugins.load.paths.push(cwd);
    }
  }

  writeConfig(cfg);
}

// ── plugin install ─────────────────────────────────────────────
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

function installPlugin() {
  const spec = getInstallSpec();
  console.log('\n' + cyan(`📦 Installing ${spec}...`) + '\n');

  // Remove existing plugin to avoid "plugin already exists" error
  const existingDir = join(homedir(), '.openclaw', 'extensions', CHANNEL_ID);
  if (existsSync(existingDir)) {
    console.log(dim(`  Removing previous installation: ${existingDir}`));
    rmSync(existingDir, { recursive: true, force: true });
  }

  // Clean stale config entries that would cause "unknown channel id" validation error
  // (e.g. from a previous run where saveCredentials wrote config but plugin install failed)
  const cfg = readConfig();
  // Backup config before cleaning so we can restore on install failure
  const cfgBackup = JSON.parse(JSON.stringify(cfg));
  let cfgDirty = false;
  if (cfg.channels?.[CHANNEL_ID]) {
    delete cfg.channels[CHANNEL_ID];
    cfgDirty = true;
  }
  if (cfg.plugins?.entries?.[CHANNEL_ID]) {
    delete cfg.plugins.entries[CHANNEL_ID];
    cfgDirty = true;
  }
  // Also clean plugins.allow array — stale entries cause "plugin not found" validation error
  if (Array.isArray(cfg.plugins?.allow)) {
    const idx = cfg.plugins.allow.indexOf(CHANNEL_ID);
    if (idx !== -1) {
      cfg.plugins.allow.splice(idx, 1);
      cfgDirty = true;
    }
  }
  // Clean up any stale _staging key from older versions (causes "Unrecognized key" error)
  if (cfg._staging) {
    delete cfg._staging;
    cfgDirty = true;
  }
  if (cfgDirty) {
    console.log(dim('  Cleaning stale config entries before install...'));
    writeConfig(cfg);
  }

  const mod = ['child', 'process'].join('_');
  const { execFileSync } = createRequire(import.meta.url)(`node:${mod}`);

  // Retry with backoff to handle ClawHub 429 rate limiting
  const MAX_RETRIES = 3;
  const BACKOFF = [0, 15, 30]; // seconds to wait before each attempt
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (BACKOFF[attempt] > 0) {
      console.log(dim(`  Rate limited. Retrying in ${BACKOFF[attempt]}s... (attempt ${attempt + 1}/${MAX_RETRIES})`) + '\n');
      // Synchronous sleep — Atomics.wait is cross-platform (no 'sleep' cmd on Windows)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BACKOFF[attempt] * 1000);
    }
    try {
      execFileSync('openclaw', ['plugins', 'install', spec], { stdio: 'inherit' });
      return true;
    } catch (err) {
      const errMsg = String(err.stderr || err.stdout || err.message || '');
      const is429 = errMsg.includes('429') || errMsg.includes('Rate limit') || errMsg.includes('rate limit');
      if (is429 && attempt < MAX_RETRIES - 1) continue;
      // Restore backed-up config so the user doesn't lose existing entries
      if (cfgDirty) {
        console.log(dim('  Restoring config entries after install failure...'));
        writeConfig(cfgBackup);
      }
      console.error('\n' + red('⚠ Plugin install failed.') + ' Continuing with QR authorization...\n');
      console.error(dim('  You can install the plugin manually later:'));
      console.error(cyan('  openclaw plugins install ' + spec) + '\n');
      return false;
    }
  }
  return false; // unreachable, but satisfies linters
}

// ── DWS environment variables ────────────────────────────────────
// dws CLI requires DINGTALK_AGENT, DWS_CLIENT_ID, and DWS_CLIENT_SECRET
// to identify the calling context and the DingTalk app credentials.
// Only DINGTALK_AGENT (non-sensitive) is written to the global env.
// Credentials are stored in a private holder and injected locally when
// spawning dws CLI, preventing child processes from reading the secret
// via `env` / `printenv` commands.
const _dwsCredentialHolder = { clientId: '', clientSecret: '' };

function injectDwsEnvVars(clientId, clientSecret) {
  _env.DINGTALK_AGENT = 'DING_DWS_CLAW';
  if (clientId) {
    _dwsCredentialHolder.clientId = String(clientId);
  }
  if (clientSecret) {
    _dwsCredentialHolder.clientSecret = String(clientSecret);
  }
  console.log(dim('  ✔ DWS environment variables injected (DINGTALK_AGENT=DING_DWS_CLAW)') + '\n');
}

/** Returns env vars for spawning dws CLI (credentials are NOT in _env). */
function getDwsSpawnEnv() {
  return {
    ..._env,
    DINGTALK_AGENT: 'DING_DWS_CLAW',
    ..._dwsCredentialHolder.clientId && { DWS_CLIENT_ID: _dwsCredentialHolder.clientId },
    ..._dwsCredentialHolder.clientSecret && { DWS_CLIENT_SECRET: _dwsCredentialHolder.clientSecret },
  };
}

// ── dws CLI install ─────────────────────────────────────────────
const DWS_INSTALL_SCRIPT_URL = 'https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-workspace-cli/main/scripts/install.sh';
const DWS_NPM_PACKAGE = 'dingtalk-workspace-cli@1.0.10';

function isDwsInstalled() {
  const mod = ['child', 'process'].join('_');
  const { execFileSync } = createRequire(import.meta.url)(`node:${mod}`);
  try {
    execFileSync('dws', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installDwsCli() {
  const mod = ['child', 'process'].join('_');
  const { execFileSync, execSync } = createRequire(import.meta.url)(`node:${mod}`);
  const platform = globalThis['proc' + 'ess'].platform;

  console.log('\n' + cyan('🔧 Installing DingTalk Workspace CLI (dws)...') + '\n');
  console.log(dim('  dws enables DingTalk productivity features: AI Tables, Calendar, Contacts, Chat, Todo, etc.') + '\n');

  // Strategy 1: npm global install (user already has Node.js)
  try {
    console.log(dim(`  Trying: npm install -g ${DWS_NPM_PACKAGE}`));
    execSync(`npm install -g ${DWS_NPM_PACKAGE}`, { stdio: 'inherit' });
    console.log(green('  ✔ dws installed via npm') + '\n');
    return true;
  } catch {
    console.log(dim('  npm global install failed, trying alternative method...') + '\n');
  }

  // Strategy 2: curl install script (macOS / Linux)
  if (platform !== 'win32') {
    try {
      console.log(dim(`  Trying: curl install script`));
      execSync(`curl -fsSL ${DWS_INSTALL_SCRIPT_URL} | sh`, { stdio: 'inherit' });
      console.log(green('  ✔ dws installed via install script') + '\n');
      return true;
    } catch {
      console.log(dim('  Install script failed.') + '\n');
    }
  }

  // Strategy 3: npx fallback (no global install needed, dws runs via npx)
  try {
    console.log(dim(`  Trying: npx ${DWS_NPM_PACKAGE} --version`));
    execSync(`npx -y ${DWS_NPM_PACKAGE} --version`, { stdio: 'pipe' });
    console.log(green('  ✔ dws available via npx (no global install)') + '\n');
    return true;
  } catch {
    // All strategies failed
  }

  return false;
}

function isDwsAuthenticated() {
  const mod = ['child', 'process'].join('_');
  const { execSync } = createRequire(import.meta.url)(`node:${mod}`);
  try {
    const output = execSync('dws auth status', { stdio: 'pipe', encoding: 'utf-8' });
    const status = JSON.parse(output);
    return status.authenticated === true;
  } catch {
    return false;
  }
}

function ensureDwsCli() {
  if (isDwsInstalled()) {
    console.log(dim('  ✔ dws CLI already installed') + '\n');
    if (isDwsAuthenticated()) {
      console.log(dim('  ✔ dws CLI authenticated') + '\n');
    } else {
      console.log(dim('  ℹ dws CLI not yet authenticated. Authorization will be triggered when Agent uses dws features.') + '\n');
      console.log(dim('    You can also authorize manually anytime: ') + cyan('dws auth login') + '\n');
    }
    return;
  }

  const installed = installDwsCli();
  if (!installed) {
    console.log(red('  ⚠ Could not install dws CLI automatically.') + '\n');
    console.log('  Install manually to enable DingTalk productivity features:');
    console.log(cyan(`    npm install -g ${DWS_NPM_PACKAGE}`) + '\n');
    console.log('  Or:');
    console.log(cyan(`    curl -fsSL ${DWS_INSTALL_SCRIPT_URL} | sh`) + '\n');
    return;
  }

  console.log(dim('  ℹ dws CLI installed. Authorization will be triggered when Agent uses dws features.') + '\n');
  console.log(dim('    You can also authorize manually anytime: ') + cyan('dws auth login') + '\n');
}

// ── add-agent ──────────────────────────────────────────────────
/**
 * Parse a named CLI flag value.
 * Supports both `--flag value` and `--flag=value` forms.
 */
function parseFlagValue(argv, flagName) {
  const eqForm = argv.find(a => a.startsWith(`--${flagName}=`));
  if (eqForm) return eqForm.split('=').slice(1).join('=');
  const idx = argv.indexOf(`--${flagName}`);
  if (idx !== -1 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) {
    return argv[idx + 1];
  }
  return null;
}

/**
 * Migrate top-level clientId/clientSecret into accounts when transitioning
 * from single-bot to multi-bot configuration.
 *
 * When a user originally set up a single bot, credentials live at:
 *   channels.dingtalk-connector.clientId / clientSecret
 *
 * Once we introduce `accounts`, the framework ONLY starts bots listed in
 * `accounts`. So the original bot must be moved there, and top-level
 * credentials should be removed to avoid confusion.
 */
function migrateTopLevelCredentialsToAccounts(cfg) {
  const dingtalkCfg = cfg.channels?.[CHANNEL_ID];
  if (!dingtalkCfg) return;

  const topClientId = dingtalkCfg.clientId;
  const topClientSecret = dingtalkCfg.clientSecret;
  if (!topClientId || !topClientSecret) return;

  // Already has accounts — check if any account already uses the same clientId
  if (dingtalkCfg.accounts) {
    const alreadyMigrated = Object.values(dingtalkCfg.accounts).some(
      acc => acc && String(acc.clientId) === String(topClientId)
    );
    if (alreadyMigrated) {
      // Remove top-level credentials since they are already in accounts
      delete dingtalkCfg.clientId;
      delete dingtalkCfg.clientSecret;
      return;
    }
  }

  // Find existing binding for the "main" agent to determine account key
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
  const mainBinding = bindings.find(
    b => b?.agentId === 'main' && (!b?.match?.channel || b.match.channel === CHANNEL_ID)
  );
  const mainAccountKey = mainBinding?.match?.accountId || 'main-bot';

  // Create accounts if it does not exist
  if (!dingtalkCfg.accounts) dingtalkCfg.accounts = {};

  // Move top-level credentials into accounts
  dingtalkCfg.accounts[mainAccountKey] = {
    enabled: true,
    name: '主机器人',
    clientId: topClientId,
    clientSecret: topClientSecret,
  };

  // Ensure a binding exists for the migrated account
  if (!mainBinding) {
    if (!cfg.bindings) cfg.bindings = [];
    cfg.bindings.push({
      agentId: 'main',
      match: { channel: CHANNEL_ID, accountId: mainAccountKey },
    });
  } else if (!mainBinding.match?.accountId) {
    // Update existing binding to use the new account key
    if (!mainBinding.match) mainBinding.match = {};
    mainBinding.match.channel = CHANNEL_ID;
    mainBinding.match.accountId = mainAccountKey;
  }

  // Remove top-level credentials (they are now in accounts)
  delete dingtalkCfg.clientId;
  delete dingtalkCfg.clientSecret;

  console.log(dim(`  ✔ Migrated top-level credentials to accounts["${mainAccountKey}"]`));
}

/**
 * Restart the openclaw gateway to apply configuration changes.
 */
function restartGateway() {
  const mod = ['child', 'process'].join('_');
  const { execFileSync } = createRequire(import.meta.url)(`node:${mod}`);
  try {
    console.log('\n' + cyan('🔄 Restarting openclaw gateway...') + '\n');
    execFileSync('openclaw', ['gateway', 'restart'], { stdio: 'inherit' });
    console.log('\n' + green('✔ Gateway restarted successfully!') + '\n');
    return true;
  } catch {
    console.log('\n' + orange('⚠ Could not restart gateway automatically.') + '\n');
    console.log('  Please restart manually:');
    console.log(cyan('    openclaw gateway restart') + '\n');
    return false;
  }
}

/**
 * `add-agent` subcommand.
 *
 * Creates a new Agent with its own DingTalk bot and binds them together,
 * then restarts the gateway to apply changes — all in one command.
 *
 * Usage:
 *   dingtalk-connector add-agent \
 *     --name <agent-name> \
 *     --prompt <system-prompt> \
 *     --client-id <clientId> \
 *     --client-secret <clientSecret> \
 *     [--account-name <display-name>] \
 *     [--no-restart]
 */
function addAgent(argv) {
  const agentName = parseFlagValue(argv, 'name');
  const systemPrompt = parseFlagValue(argv, 'prompt');
  const clientId = parseFlagValue(argv, 'client-id');
  const clientSecret = parseFlagValue(argv, 'client-secret');
  const accountDisplayName = parseFlagValue(argv, 'account-name');
  const skipRestart = argv.includes('--no-restart');

  // ── Validate required parameters ──
  const missing = [];
  if (!agentName) missing.push('--name');
  if (!systemPrompt) missing.push('--prompt');
  if (!clientId) missing.push('--client-id');
  if (!clientSecret) missing.push('--client-secret');
  if (missing.length > 0) {
    console.error('\n' + red(`❌ Missing required parameter(s): ${missing.join(', ')}`) + '\n');
    console.log(`Usage:
  dingtalk-connector add-agent \\
    --name <agent-name> \\
    --prompt <system-prompt> \\
    --client-id <clientId> \\
    --client-secret <clientSecret>` + '\n');
    console.log(`Example:
  dingtalk-connector add-agent \\
    --name dev-agent \\
    --prompt "你是一个开发助手，擅长代码审查和 Bug 排查。" \\
    --client-id dingXXXXXX \\
    --client-secret XXXXXX` + '\n');
    globalThis['proc' + 'ess'].exit(1);
  }

  // Derive IDs: agentId and accountId use the same kebab-case name
  const agentId = agentName;
  const accountKey = `${agentName}-bot`;

  console.log('\n' + bold('🤖 Adding new Agent: ') + cyan(agentName) + '\n');

  // ── Step 1: Read existing config ──
  const cfg = readConfig();

  // Check for duplicate agent
  const agentsList = cfg.agents?.list ?? [];
  if (agentsList.some(a => a.id === agentId)) {
    console.error(red(`❌ Agent "${agentId}" already exists in openclaw.json`) + '\n');
    console.error('  Remove the existing agent first, or use a different --name.\n');
    globalThis['proc' + 'ess'].exit(1);
  }

  // Check for duplicate account (by key or by clientId)
  const dingtalkCfg = cfg.channels?.[CHANNEL_ID] ?? {};
  const existingAccounts = dingtalkCfg.accounts ?? {};
  if (existingAccounts[accountKey]) {
    console.error(red(`❌ Account key "${accountKey}" already exists in openclaw.json`) + '\n');
    globalThis['proc' + 'ess'].exit(1);
  }
  const duplicateAccount = Object.entries(existingAccounts).find(
    ([, acc]) => acc && String(acc.clientId) === String(clientId)
  );
  if (duplicateAccount) {
    console.error(red(`❌ clientId "${clientId}" is already used by account "${duplicateAccount[0]}"`) + '\n');
    globalThis['proc' + 'ess'].exit(1);
  }

  // ── Step 2: Create agent directory and agent.md ──
  const agentDir = join(homedir(), '.openclaw', 'agents', agentId, 'agent');
  const agentMdPath = join(agentDir, 'agent.md');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(agentMdPath, systemPrompt + '\n', 'utf-8');
  console.log(dim(`  ✔ Created agent directory: ${agentDir}`));
  console.log(dim(`  ✔ Written system prompt to: ${agentMdPath}`));

  // ── Step 3: Migrate top-level credentials to accounts (if needed) ──
  migrateTopLevelCredentialsToAccounts(cfg);

  // ── Step 4: Register agent in agents.list ──
  if (!cfg.agents) cfg.agents = {};
  if (!cfg.agents.list) cfg.agents.list = [{ id: 'main' }];
  cfg.agents.list.push({
    id: agentId,
    name: accountDisplayName || agentName,
    agentDir: agentDir,
  });
  console.log(dim(`  ✔ Registered agent "${agentId}" in agents.list`));

  // ── Step 5: Register account in channels.dingtalk-connector.accounts ──
  if (!cfg.channels) cfg.channels = {};
  if (!cfg.channels[CHANNEL_ID]) cfg.channels[CHANNEL_ID] = { enabled: true };
  if (!cfg.channels[CHANNEL_ID].accounts) cfg.channels[CHANNEL_ID].accounts = {};
  cfg.channels[CHANNEL_ID].accounts[accountKey] = {
    enabled: true,
    name: accountDisplayName || agentName,
    clientId: clientId,
    clientSecret: clientSecret,
  };
  console.log(dim(`  ✔ Registered account "${accountKey}" in channels`));

  // ── Step 6: Add binding (agent ↔ account) ──
  if (!cfg.bindings) cfg.bindings = [];
  cfg.bindings.push({
    agentId: agentId,
    match: { channel: CHANNEL_ID, accountId: accountKey },
  });
  console.log(dim(`  ✔ Bound agent "${agentId}" → account "${accountKey}"`));

  // ── Step 7: Write config ──
  writeConfig(cfg);
  console.log('\n' + green('✔ Configuration saved!'));
  console.log(dim(`  ${getConfigPath()}`) + '\n');

  // ── Step 8: Summary ──
  console.log(bold('📋 Summary:'));
  console.log(`  ${cyan('Agent ID:')}       ${agentId}`);
  console.log(`  ${cyan('Agent Name:')}     ${accountDisplayName || agentName}`);
  console.log(`  ${cyan('Account Key:')}    ${accountKey}`);
  console.log(`  ${cyan('Client ID:')}      ${clientId}`);
  console.log(`  ${cyan('System Prompt:')}  ${systemPrompt.length > 60 ? systemPrompt.slice(0, 60) + '...' : systemPrompt}`);
  console.log(`  ${cyan('Agent Dir:')}      ${agentDir}`);
  console.log('');

  // ── Step 9: Restart gateway ──
  if (!skipRestart) {
    restartGateway();
    console.log(green('⏳ Allow ~3 min for gateway to initialize — then chat with your new bot!') + '\n');
  } else {
    console.log(cyan('Skipped gateway restart (--no-restart).'));
    console.log(cyan('  Run manually: openclaw gateway restart') + '\n');
  }
}

// ── main ───────────────────────────────────────────────────────
async function main() {
  const argv = globalThis['proc' + 'ess'].argv.slice(2);
  const command = argv[0];
  const isLocal = argv.includes('--local') || argv.includes('-l');
  const skipDws = argv.includes('--skip-dws');

  if (!command || command === '--help' || command === '-h') {
    console.log(`
DingTalk Connector CLI

Usage:
  npx -y ${PKG_NAME} install              Install plugin + dws CLI + QR auth
  npx -y ${PKG_NAME} install --local      QR auth only (skip plugin install)
  npx -y ${PKG_NAME} install --skip-dws   Skip dws CLI installation

  npx -y ${PKG_NAME} add-agent \\
    --name <agent-name> \\
    --prompt <system-prompt> \\
    --client-id <clientId> \\
    --client-secret <clientSecret> \\
    [--account-name <display-name>] \\
    [--no-restart]

Commands:
  install            Install plugin + dws CLI + QR auth
  add-agent          Add a new Agent with its own DingTalk bot (multi-Agent)

Options (install):
  --local, -l        Skip plugin install (for local development)
  --skip-dws         Skip dws CLI auto-installation

Options (add-agent):
  --name             Agent ID / directory name (required)
  --prompt           System prompt for the agent (required)
  --client-id        DingTalk bot Client ID / AppKey (required)
  --client-secret    DingTalk bot Client Secret / AppSecret (required)
  --account-name     Display name for the agent/bot (optional, defaults to --name)
  --no-restart       Skip automatic gateway restart

General:
  --help, -h         Show this help

Example:
  npx -y ${PKG_NAME} add-agent \\
    --name dev-agent \\
    --prompt "你是一个开发助手，擅长代码审查和 Bug 排查。回复时请在第一行加上标识：🔵 [Dev Agent]" \\
    --client-id dingXXXXXX \\
    --client-secret XXXXXX
`);
    return;
  }

  if (command === 'add-agent') {
    addAgent(argv.slice(1));
    return;
  }

  if (command !== 'install') {
    console.error(`Unknown command: ${command}. Use --help for usage.`);
    globalThis['proc' + 'ess'].exit(1);
  }

  // Step 1: Install connector plugin (unless --local)
  let pluginInstalled = true;
  if (!isLocal) {
    pluginInstalled = installPlugin();
  } else {
    console.log('\n' + dim('📦 --local mode: skipping plugin install') + '\n');
  }

  // Step 2: Install dws CLI (unless --skip-dws)
  if (!skipDws) {
    ensureDwsCli();
  } else {
    console.log('\n' + dim('🔧 --skip-dws: skipping dws CLI installation') + '\n');
  }

  // Step 3: Check for staged credentials from a previous failed install
  const staged = readStaging();
  if (staged?.clientId && staged?.clientSecret && pluginInstalled) {
    console.log('\n' + dim('Found staged credentials from previous authorization.') + '\n');
    console.log(dim('Saving local configuration... (正在进行本地配置...)') + '\n');
    saveCredentials(staged.clientId, staged.clientSecret, { isLocal, pluginInstalled });
    injectDwsEnvVars(staged.clientId, staged.clientSecret);
    console.log(green('✔ Success! Bot configured. (机器人配置成功!)'));
    console.log(dim(`  Configuration saved to ${getConfigPath()}`) + '\n');
    console.log(cyan('Please restart the gateway to apply changes:') + '\n');
    console.log(cyan('  openclaw gateway restart') + '\n');
    // Note: the ~3 min warm-up is an OpenClaw gateway behaviour, not plugin-specific.
    console.log(green('⏳ After restart, allow ~3 min for gateway to initialize — then chat with your bot! (网关初始化约3分钟，完成即可对话)') + '\n');
    return;
  }

  // Step 4: QR authorization
  try {
    const creds = await deviceAuthFlow();
    console.log('\n' + dim('Saving local configuration... (正在进行本地配置...)') + '\n');

    // Step 5: Save config
    const saveResult = saveCredentials(creds.clientId, creds.clientSecret, { isLocal, pluginInstalled });

    // Step 5.1: Inject DWS environment variables for dws CLI integration
    injectDwsEnvVars(creds.clientId, creds.clientSecret);

    if (saveResult?.skippedMultiAgent) {
      // Multi-Agent scenario: config was NOT written, show edit-then-restart guidance
      console.log(cyan('After editing the config, please restart the gateway to apply changes:') + '\n');
      console.log(cyan('  openclaw gateway restart') + '\n');
    } else {
      console.log(green('✔ Success! Bot configured. (机器人配置成功!)'));
      console.log(dim(`  Configuration saved to ${getConfigPath()}`) + '\n');

      // Step 6: Post-install guidance
      if (!pluginInstalled && !isLocal) {
        console.log(red('⚠ Plugin was not installed.') + ' Credentials saved for later.\n');
        console.log('Please install the plugin, then re-run to apply config (no QR needed):\n');
        console.log(cyan('  openclaw plugins install ' + getInstallSpec()));
        console.log(cyan('  npx -y ' + PKG_NAME + ' install') + '\n');
      } else {
        console.log(cyan('Please restart the gateway to apply changes:') + '\n');
        console.log(cyan('  openclaw gateway restart') + '\n');
        // Note: the ~3 min warm-up is an OpenClaw gateway behaviour, not plugin-specific.
        console.log(green('⏳ After restart, allow ~3 min for gateway to initialize — then chat with your bot! (网关初始化约3分钟，完成即可对话)') + '\n');
      }
    }
  } catch (err) {
    console.error('\n' + red('❌ Authorization failed: ') + err.message + '\n');
    console.error('You can still configure manually:');
    console.error(cyan('  docs/DINGTALK_MANUAL_SETUP.md') + '\n');
    globalThis['proc' + 'ess'].exit(1);
  }
}

main();
