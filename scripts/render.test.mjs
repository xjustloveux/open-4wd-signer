// 部署 manifest 與 workflow 的不變式（只用 node 內建模組，以文字比對 YAML）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDERS, renderManifests, renderText, renderValues } from './render.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');

const DIGEST = `sha256:${'a'.repeat(64)}`;
const VALID_ENV = Object.freeze({
  SIGNER_IMAGE: `ghcr.io/example-owner/open-4wd-governance-signer@${DIGEST}`,
  SIGNER_NODE_NAME: 'signer-node-1',
  SIGNER_PROFILE: 'private-playtest',
  SIGNER_BOOTSTRAP:
    '/dns4/bootstrap.example.org/tcp/443/wss/p2p/12D3KooWAbcdefghijkmnopqrstuvwxyzABCDEFGHJKMNPQRSTUVW',
});

function repoFiles(dir = ROOT) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...repoFiles(path));
    else files.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

describe('k8s deployment', () => {
  const deployment = read('deploy/k8s/deployment.yaml');

  it('replicas 固定 1、策略 Recreate', () => {
    assert.deepEqual(deployment.match(/^ {2}replicas: .+$/gmu), ['  replicas: 1']);
    assert.match(deployment, /^ {2}strategy:\n {4}type: Recreate$/mu);
  });

  it('映像只用佔位字串（渲染時要求 digest），不出現 latest 或任何標籤', () => {
    assert.deepEqual(deployment.match(/^ +image: .+$/gmu), ['          image: REPLACE_IMAGE']);
    for (const file of repoFiles().filter((name) => /\.(?:ya?ml|service)$/u.test(name)))
      assert.doesNotMatch(read(file), /:latest\b/u, file);
  });

  it('非 root、唯讀根檔案系統、不可提權、丟棄所有能力、不掛 service account token', () => {
    assert.match(deployment, /runAsNonRoot: true/u);
    assert.match(deployment, /runAsUser: 10001/u);
    assert.match(deployment, /readOnlyRootFilesystem: true/u);
    assert.match(deployment, /allowPrivilegeEscalation: false/u);
    assert.match(deployment, /drop:\n\s+- ALL/u);
    assert.match(deployment, /automountServiceAccountToken: false/u);
    assert.doesNotMatch(deployment, /privileged: true|hostNetwork: true/u);
  });

  it('金鑰來自節點專屬的唯讀 hostPath 檔案，manifest 不含金鑰內容或 Secret', () => {
    assert.match(deployment, /kubernetes\.io\/hostname: REPLACE_NODE_NAME/u);
    assert.match(
      deployment,
      /- name: governance-key\n {14}mountPath: \/key\/governance\.key\n {14}readOnly: true/u,
    );
    assert.match(
      deployment,
      /- name: governance-key\n {10}hostPath:\n {12}path: \/etc\/open4wd-signer\/governance\.key\n {12}type: File/u,
    );
    assert.match(deployment, /- name: SIGNER_KEY_SOURCE\n {14}value: file/u);
    for (const file of repoFiles().filter((name) => name.startsWith('deploy/'))) {
      const text = read(file);
      assert.doesNotMatch(text, /kind: Secret|secretKeyRef|SIGNER_KEY:|name: SIGNER_KEY$/mu, file);
      assert.doesNotMatch(text, /-----BEGIN|\b[0-9a-f]{64}\b/u, file);
      // 12 個以上連續小寫英文字（助記詞形狀）
      assert.doesNotMatch(text, /(?:\b[a-z]{3,8}\b ){11,}\b[a-z]{3,8}\b/u, file);
    }
  });

  it('資料卷為 ReadWriteOnce', () => {
    assert.match(read('deploy/k8s/pvc.yaml'), /accessModes:\n {4}- ReadWriteOnce\n/u);
    assert.match(deployment, /claimName: open4wd-signer-data/u);
  });

  it('只外連：沒有監聽設定、沒有容器埠、沒有 Service；健康端點綁 127.0.0.1:9475 並以 exec 探針存取', () => {
    const instructions = deployment
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    assert.doesNotMatch(instructions, /SIGNER_LISTEN|containerPort|hostPort/u);
    assert.ok(!repoFiles().some((name) => /deploy\/k8s\/service/u.test(name)));
    assert.doesNotMatch(read('deploy/k8s/kustomization.yaml'), /service|ingress/iu);
    assert.match(deployment, /- name: SIGNER_HEALTH_HOST\n {14}value: 127\.0\.0\.1/u);
    assert.match(deployment, /- name: SIGNER_HEALTH_PORT\n {14}value: '9475'/u);
    assert.match(deployment, /livenessProbe:\n {12}exec:/u);
    assert.match(deployment, /http:\/\/127\.0\.0\.1:9475\/healthz/u);
    assert.doesNotMatch(deployment, /httpGet:/u);
  });
});

describe('k8s networkpolicy、kustomization、admin job', () => {
  it('networkpolicy 拒絕所有入站（policyTypes 含 Ingress、沒有 ingress 規則）', () => {
    const policy = read('deploy/k8s/networkpolicy.yaml');
    assert.match(policy, /policyTypes:\n {4}- Ingress\n {4}- Egress/u);
    assert.doesNotMatch(policy, /^ {2}ingress:/mu);
    assert.match(policy, /app\.kubernetes\.io\/part-of: open4wd-governance-signer/u);
    // 常駐 pod 與管理 Job 的 pod 都帶這個標籤，兩者都受拒絕入站涵蓋。
    for (const file of ['deploy/k8s/deployment.yaml', 'deploy/k8s/admin-job.yaml']) {
      const template = read(file).split(/^ {2}template:$/mu)[1] ?? '';
      assert.match(
        template,
        /^ {8}app\.kubernetes\.io\/part-of: open4wd-governance-signer$/mu,
        file,
      );
    }
  });

  it('namespace 不 enforce Pod Security（hostPath 金鑰），只以 restricted warn／audit；README 說明需放寬', () => {
    const namespace = read('deploy/k8s/namespace.yaml');
    assert.doesNotMatch(namespace, /pod-security\.kubernetes\.io\/enforce/u);
    assert.match(namespace, /pod-security\.kubernetes\.io\/warn: restricted/u);
    assert.match(namespace, /pod-security\.kubernetes\.io\/audit: restricted/u);
    const readme = read('README.md');
    assert.match(readme, /### Pod Security：此 namespace 需要放寬/u);
    assert.match(readme, /### 只設 liveness、不設 readiness/u);
    assert.doesNotMatch(read('deploy/k8s/deployment.yaml'), /readinessProbe:/u);
  });

  it('kustomization 不包含 admin-job，命名空間固定', () => {
    const kustomization = read('deploy/k8s/kustomization.yaml');
    const resources = [...kustomization.matchAll(/^ {2}- (.+)$/gmu)].map((match) => match[1]);
    assert.deepEqual(resources.sort(), [
      'deployment.yaml',
      'namespace.yaml',
      'networkpolicy.yaml',
      'pvc.yaml',
    ]);
    assert.match(kustomization, /^namespace: open4wd-signer$/mu);
  });

  it('admin job 與常駐實例使用同一資料卷、同一節點、非 root，且不重試', () => {
    const job = read('deploy/k8s/admin-job.yaml');
    assert.match(job, /kind: Job/u);
    assert.match(job, /backoffLimit: 0/u);
    assert.match(job, /restartPolicy: Never/u);
    assert.match(job, /claimName: open4wd-signer-data/u);
    assert.match(job, /kubernetes\.io\/hostname: REPLACE_NODE_NAME/u);
    assert.match(job, /runAsUser: 10001/u);
    assert.match(job, /readOnlyRootFilesystem: true/u);
    assert.match(job, /scale deployment\/open4wd-governance-signer --replicas=0/u);
  });
});

describe('render', () => {
  it('接受 digest 映像參照，拒絕標籤（含 latest）與缺 digest', () => {
    assert.equal(renderValues(VALID_ENV).ok, true);
    for (const image of [
      'ghcr.io/example-owner/open-4wd-governance-signer:latest',
      'ghcr.io/example-owner/open-4wd-governance-signer:sha-abc',
      'ghcr.io/example-owner/open-4wd-governance-signer',
      `ghcr.io/example-owner/open-4wd-governance-signer:latest@sha256:${'a'.repeat(63)}`,
    ]) {
      const result = renderValues({ ...VALID_ENV, SIGNER_IMAGE: image });
      assert.equal(result.ok, false, image);
    }
  });

  it('拒絕 development profile、缺 /p2p/ 的 bootstrap、不合法節點名稱', () => {
    assert.equal(renderValues({ ...VALID_ENV, SIGNER_PROFILE: 'development' }).ok, false);
    assert.equal(
      renderValues({ ...VALID_ENV, SIGNER_BOOTSTRAP: '/dns4/bootstrap.example.org/tcp/443/wss' })
        .ok,
      false,
    );
    assert.equal(renderValues({ ...VALID_ENV, SIGNER_BOOTSTRAP: '' }).ok, false);
    assert.equal(renderValues({ ...VALID_ENV, SIGNER_NODE_NAME: 'Bad Node' }).ok, false);
    assert.equal(renderValues({ ...VALID_ENV, SIGNER_PROFILE: 'public' }).ok, true);
  });

  it('渲染後沒有殘留佔位字串；未知佔位字串即失敗', () => {
    assert.throws(() => renderText('a: REPLACE_OTHER', {}), /unrendered/u);
    const out = mkdtempSync(join(tmpdir(), 'o4wd-signer-render-'));
    try {
      const files = renderManifests({ root: ROOT, out, env: VALID_ENV });
      assert.ok(files.includes('deployment.yaml') && files.includes('kustomization.yaml'));
      for (const file of files)
        assert.doesNotMatch(readFileSync(join(out, file), 'utf8'), /REPLACE_[A-Z]/u);
      const rendered = readFileSync(join(out, 'deployment.yaml'), 'utf8');
      assert.ok(rendered.includes(`image: ${VALID_ENV.SIGNER_IMAGE}`));
      assert.match(rendered, /kubernetes\.io\/hostname: signer-node-1/u);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    assert.deepEqual(Object.keys(PLACEHOLDERS).sort(), [
      'REPLACE_BOOTSTRAP',
      'REPLACE_IMAGE',
      'REPLACE_NODE_NAME',
      'REPLACE_PROFILE',
    ]);
  });
});

describe('deploy workflow', () => {
  const workflow = read('.github/workflows/deploy.yml');

  it('只手動觸發、變數閘、限預設分支、最小權限', () => {
    assert.match(workflow, /^on:\n {2}workflow_dispatch:\n\n/mu);
    assert.doesNotMatch(
      workflow,
      /^ {2}(push|pull_request|pull_request_target|schedule|workflow_run):/mu,
    );
    assert.match(workflow, /^ {4}if: vars\.SIGNER_DEPLOY_ENABLED == 'true'$/mu);
    assert.match(workflow, /test "\$\{REF\}" = "refs\/heads\/\$\{DEFAULT_BRANCH\}"/u);
    assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
    assert.doesNotMatch(workflow, /write$/mu);
  });

  it('永不接觸金鑰：secrets 只有 KUBE_CONFIG，不引用任何金鑰變數', () => {
    assert.deepEqual([...new Set(workflow.match(/secrets\.[A-Z_]+/gu))], ['secrets.KUBE_CONFIG']);
    assert.doesNotMatch(workflow, /SIGNER_KEY|MNEMONIC|governance\.key/iu);
    assert.match(workflow, /node --test 'scripts\/\*\.test\.mjs'/u);
    assert.match(workflow, /node scripts\/render\.mjs --out "\$RUNNER_TEMP\//u);
  });

  it('外部 action 一律鎖 40 位 commit SHA 並附版本註解', () => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/gmu)];
    assert.ok(uses.length > 0);
    for (const [, reference, comment] of uses) {
      assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/u);
      assert.match(comment ?? '', /^v\d+(?:\.\d+)*$/u);
    }
  });
});

describe('systemd 與 repo 衛生', () => {
  it('service 以非 root 帳號執行 run、不監聽、加固並避免設定錯誤時無限重啟', () => {
    const unit = read('deploy/systemd/open4wd-governance-signer.service');
    assert.match(unit, /^User=open4wd-signer$/mu);
    assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/open4wd-signer\/main\.mjs run$/mu);
    assert.match(unit, /^NoNewPrivileges=yes$/mu);
    assert.match(unit, /^ProtectSystem=strict$/mu);
    assert.match(unit, /^RestartPreventExitStatus=2 3 5$/mu);
    assert.doesNotMatch(unit, /SIGNER_LISTEN|ListenStream|User=root/u);
    const env = read('deploy/systemd/signer.env.example');
    assert.match(env, /^SIGNER_HEALTH_HOST=127\.0\.0\.1$/mu);
    assert.doesNotMatch(env, /^SIGNER_LISTEN=/mu);
    assert.doesNotMatch(env, /^SIGNER_KEY=|^OPEN4WD_PROFILE=development$/mu);
  });

  it('不含真實 IP、email 或本機路徑', () => {
    for (const file of repoFiles().filter((name) => name !== 'LICENSE')) {
      const text = read(file);
      const ips = (text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? []).filter(
        (ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0',
      );
      assert.deepEqual(ips, [], file);
      assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, file);
      assert.doesNotMatch(text, /[A-Z]:\\Users\\|\/home\/[a-z]|\/Users\/[a-z]/u, file);
    }
  });
});
