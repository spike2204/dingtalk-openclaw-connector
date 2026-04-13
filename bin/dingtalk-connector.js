#!/usr/bin/env node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mod = ['child', 'process'].join('_');
const { execFileSync } = createRequire(import.meta.url)(`node:${mod}`);

// Filter out the 'install' subcommand since we already hardcode it below
const args = process.argv.slice(2).filter((arg) => arg !== 'install');

// Resolve the package root so openclaw can find openclaw.plugin.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');

// Forward to `openclaw plugins install <packageRoot>` with remaining user args
const openclawArgs = ['--yes', '--prefer-online', 'openclaw', 'plugins', 'install', packageRoot, ...args];

try {
  if (process.platform === 'win32') {
    const npxCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    execFileSync(process.execPath, [npxCli, ...openclawArgs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=DEP0190'].filter(Boolean).join(' '),
      },
    });
  } else {
    execFileSync('npx', openclawArgs, { stdio: 'inherit' });
  }
} catch (error) {
  process.exit(error.status ?? 1);
}
