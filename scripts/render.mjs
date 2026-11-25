/**
 * 把 deploy/k8s 的 REPLACE_ 欄位以環境變數渲染到 checkout 外的目錄（deploy workflow 使用）。
 *
 * 輸入（全部必填，格式不符即失敗）：
 * - `SIGNER_IMAGE`：映像參照，必須是 digest 形式 `<registry>/<path>@sha256:<64 hex>`；不接受標籤（含 latest）。
 * - `SIGNER_NODE_NAME`：放置金鑰檔的節點名稱（kubernetes.io/hostname）。
 * - `SIGNER_PROFILE`：`private-playtest` 或 `public`；development 只限本機開發（開發金鑰是公開的）。
 * - `SIGNER_BOOTSTRAP`：逗號分隔的 bootstrap multiaddr，每個都要含 `/p2p/`。
 *
 * 本腳本與 deploy workflow 都不接觸治理金鑰；金鑰由操作者離線放到節點的 hostPath。
 *
 * 用法：`node scripts/render.mjs --out <目錄>`。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 部署 manifest 目錄（相對 repo 根）。 */
export const K8S_DIR = 'deploy/k8s';

/** 佔位字串與對應的環境變數。 */
export const PLACEHOLDERS = Object.freeze({
  REPLACE_IMAGE: 'SIGNER_IMAGE',
  REPLACE_NODE_NAME: 'SIGNER_NODE_NAME',
  REPLACE_PROFILE: 'SIGNER_PROFILE',
  REPLACE_BOOTSTRAP: 'SIGNER_BOOTSTRAP',
});

const IMAGE_PATTERN =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/u;
const NODE_NAME_PATTERN =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/u;
const PROFILES = new Set(['private-playtest', 'public']);
const MULTIADDR_PATTERN = /^\/[A-Za-z0-9._~:/-]+\/p2p\/[1-9A-HJ-NP-Za-km-z]{32,64}$/u;

/**
 * 驗證並取出渲染值。
 *
 * @param {Record<string, string | undefined>} env 環境變數。
 * @returns {{ ok: true; values: Record<string, string> } | { ok: false; errors: string[] }} 結果。
 */
export function renderValues(env) {
  const errors = [];
  const read = (name) => (env[name] ?? '').trim();
  const image = read('SIGNER_IMAGE');
  if (!IMAGE_PATTERN.test(image)) errors.push('SIGNER_IMAGE must be a digest reference');
  const node = read('SIGNER_NODE_NAME');
  if (!NODE_NAME_PATTERN.test(node)) errors.push('SIGNER_NODE_NAME is invalid');
  const profile = read('SIGNER_PROFILE');
  if (!PROFILES.has(profile)) errors.push('SIGNER_PROFILE must be private-playtest or public');
  const bootstrap = read('SIGNER_BOOTSTRAP');
  const addresses = bootstrap === '' ? [] : bootstrap.split(',').map((item) => item.trim());
  if (addresses.length === 0 || addresses.some((address) => !MULTIADDR_PATTERN.test(address)))
    errors.push('SIGNER_BOOTSTRAP must list multiaddrs with /p2p/<PeerId>');
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    values: {
      REPLACE_IMAGE: image,
      REPLACE_NODE_NAME: node,
      REPLACE_PROFILE: profile,
      REPLACE_BOOTSTRAP: addresses.join(','),
    },
  };
}

/**
 * 取代一份 manifest 的佔位字串；渲染後仍有 REPLACE_ 即失敗。
 *
 * @param {string} text manifest 文字。
 * @param {Record<string, string>} values 渲染值。
 * @returns {string} 渲染後文字。
 * @throws {Error} 有未渲染的佔位字串時。
 */
export function renderText(text, values) {
  let output = text;
  for (const [placeholder, value] of Object.entries(values))
    output = output.replaceAll(placeholder, value);
  if (/REPLACE_[A-Z_]+/u.test(output)) throw new Error('unrendered placeholder remains');
  return output;
}

/**
 * 渲染 deploy/k8s 的全部 manifest 到輸出目錄（admin-job.yaml 也一併渲染，供操作者手動使用）。
 *
 * @param {{ root?: string; out: string; env: Record<string, string | undefined> }} options 輸入。
 * @returns {string[]} 寫出的檔名。
 * @throws {Error} 輸入不合法或渲染失敗時。
 */
export function renderManifests({ root = ROOT, out, env }) {
  const result = renderValues(env);
  if (!result.ok) throw new Error(result.errors.join('; '));
  const source = join(root, K8S_DIR);
  mkdirSync(out, { recursive: true });
  const files = readdirSync(source)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
  for (const name of files)
    writeFileSync(
      join(out, name),
      renderText(readFileSync(join(source, name), 'utf8'), result.values),
    );
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (values.out === undefined) {
    process.stderr.write('usage: node scripts/render.mjs --out <dir>\n');
    process.exitCode = 2;
  } else {
    try {
      const files = renderManifests({ out: resolve(values.out), env: process.env });
      process.stdout.write(`rendered ${files.length} manifests\n`);
    } catch (cause) {
      process.stderr.write(`render failed: ${cause instanceof Error ? cause.message : cause}\n`);
      process.exitCode = 1;
    }
  }
}
