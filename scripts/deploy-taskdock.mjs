#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/deploy-taskdock.mjs [--ref HEAD] [--fresh-build]\nDeploy a committed revision to homelab. Reuses the current runtime when dependencies match; builds Web when its inputs change. --fresh-build uses the repository Dockerfile.');
  process.exit(0);
}
let ref = 'HEAD';
let fresh = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref' && args[i + 1]) ref = args[++i];
  else if (args[i] === '--fresh-build') fresh = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
function capture(command, parameters, options = {}) {
  return execFileSync(command, parameters, { cwd: root, encoding: 'utf8', ...options }).trim();
}
function run(command, parameters) {
  execFileSync(command, parameters, { cwd: root, stdio: 'inherit' });
}
const host = 'homelab';
const remoteRoot = '/opt/data/appdata/taskdock';
const publicUrl = 'https://taskdock.thisaray.com';
const ssh = (command) => capture('ssh', ['-o', 'BatchMode=yes', host, command]);
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const revision = capture('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
const dirty = capture('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty) throw new Error('Commit tracked changes before deploying.');
const current = JSON.parse(ssh('docker inspect taskdock --format \'{"image":{{json .Config.Image}},"id":{{json .Image}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}\''));
if (!/^[a-f0-9]{40}$/.test(current.revision ?? '')) throw new Error('Current container has no valid revision label.');
capture('git', ['merge-base', '--is-ancestor', current.revision, revision]);
const changed = capture('git', ['diff', '--name-only', current.revision, revision]).split('\n').filter(Boolean);
const webChanged = changed.some((name) => name.startsWith('web/') || name.startsWith('shared/') || ['package.json', 'package-lock.json'].includes(name));
if (!fresh) {
  const lock = execFileSync('git', ['show', `${revision}:package-lock.json`], { cwd: root });
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(lock).digest('hex');
  const remoteDigest = ssh('docker exec taskdock sha256sum /app/package-lock.json').split(/\s+/)[0];
  if (digest !== remoteDigest) throw new Error('Dependency lock changed. Use --fresh-build to install the new runtime.');
  const targetPackage = JSON.parse(capture('git', ['show', `${revision}:package.json`]));
  const runningPackage = JSON.parse(ssh('docker exec taskdock cat /app/package.json'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'engines']) {
    if (JSON.stringify(targetPackage[field]) !== JSON.stringify(runningPackage[field])) throw new Error(`Package ${field} changed. Use --fresh-build.`);
  }
}
const stamp = new Date().toISOString().replace(/[-:.]/g, '');
const release = `${remoteRoot}/releases/${revision.slice(0, 12)}-${stamp}`;
const staging = mkdtempSync(path.join(tmpdir(), 'taskdock-deploy-'));
try {
  const archive = path.join(staging, 'source.tar');
  run('git', ['archive', '--format=tar', `--output=${archive}`, revision]);
  let dockerfile;
  if (!fresh) {
    dockerfile = webChanged ? `FROM ${current.id} AS web-build\nUSER root\nWORKDIR /build\nCOPY package.json package-lock.json ./\nRUN npm ci --include=dev\nCOPY web ./web\nCOPY shared ./shared\nRUN npm run build:web\n` : '';
    dockerfile += `FROM ${current.id}\nWORKDIR /app\nCOPY package.json package-lock.json ./\nCOPY server ./server\nCOPY shared ./shared\nCOPY skills ./skills\n`;
    if (webChanged) dockerfile += 'COPY --from=web-build /build/dist/web ./dist/web\n';
    dockerfile += 'USER node\n';
    writeFileSync(path.join(staging, 'Dockerfile.deploy'), dockerfile);
  }
  console.log(`Deploy ${revision}; current ${current.revision}; Web ${webChanged ? 'rebuild' : 'reuse'}; runtime ${fresh ? 'fresh' : 'reuse'}`);
  ssh(`mkdir -p ${quote(release)}`);
  run('scp', ['-q', archive, `${host}:${release}/source.tar`]);
  if (!fresh) run('scp', ['-q', path.join(staging, 'Dockerfile.deploy'), `${host}:${release}/Dockerfile.deploy`]);
  run('ssh', ['-o', 'BatchMode=yes', host, `tar -xf ${quote(release + '/source.tar')} -C ${quote(release)} && bash ${quote(release + '/scripts/deploy-taskdock-remote.sh')} ${quote(release)} ${quote(revision)} ${quote(current.id)} ${fresh ? 'Dockerfile' : 'Dockerfile.deploy'}`]);
  const response = await fetch(`${publicUrl}/health`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Public health check failed; inspect the remote deployment result.');
  const deployed = ssh('docker inspect taskdock --format \'{{index .Config.Labels "org.opencontainers.image.revision"}}\'');
  if (deployed !== revision) throw new Error('Deployed revision does not match requested revision.');
  console.log(`DEPLOYED ${revision}\nPUBLIC ${publicUrl}\nRELEASE ${release}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
