# 以 systemd 執行治理簽署工具

適用於不使用 Kubernetes 的單機部署。程式是主 repo `open-4wd` 打包出的 `dist/governance-signer/`
（`main.mjs`、`node_modules/`、`build-info.json`、授權檔），主機需要 Node.js 24。

## 取得打包產物

優先從已發布的映像取出，與容器部署跑的是同一份產物（以 digest 引用）：

```sh
cid="$(docker create ghcr.io/<owner>/open-4wd-governance-signer@sha256:<digest>)"
docker cp "$cid:/app/." ./open4wd-signer-dist/
docker rm "$cid"
```

或在主 repo 的指定 commit 執行 `pnpm build:signer`。兩種方式都要核對 `build-info.json` 的
`commit`、`mainSha256` 與 `ruleEpochs`。`node_modules/classic-level/prebuilds/` 內含 linux-x64 glibc 與
musl、linux-arm64 等 prebuild，不需要在主機上編譯。

## 安裝

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin open4wd-signer
sudo install -d -o root -g root -m 0755 /opt/open4wd-signer
sudo cp -R ./open4wd-signer-dist/. /opt/open4wd-signer/
sudo install -d -o root -g open4wd-signer -m 0750 /etc/open4wd-signer
sudo install -o root -g open4wd-signer -m 0640 signer.env.example /etc/open4wd-signer/signer.env
# 金鑰檔：在離線機器以 `governance-signer keygen --out` 產生後搬來；擁有者須是服務帳號、權限 0400，
# 群組或其他人可讀時工具拒絕啟動。
sudo install -o open4wd-signer -g open4wd-signer -m 0400 governance.key /etc/open4wd-signer/governance.key
sudo install -m 0644 open4wd-governance-signer.service /etc/systemd/system/
sudo systemctl daemon-reload
```

編輯 `/etc/open4wd-signer/signer.env`（`OPEN4WD_PROFILE`、`SIGNER_BOOTSTRAP`）後，先做離線檢查再啟動：

```sh
sudo -u open4wd-signer sh -c 'set -a; . /etc/open4wd-signer/signer.env; set +a; exec node /opt/open4wd-signer/main.mjs check --storage-self-test'
sudo systemctl enable --now open4wd-governance-signer
curl -s http://127.0.0.1:9475/status
```

## 管理指令

`clear-halt`、`release-lock`、`config-export`、`config-update` 與 `run` 共用資料目錄與 `instance.lock`，
必須先 `sudo systemctl stop open4wd-governance-signer`，以服務帳號與同一份環境變數執行（同上面 check 的 sh -c 寫法），完成後再
`start`。`release-lock` 與 `config-update` 之後一定要重新啟動 `run`。細節與殘餘風險見 repo 根的 README。

## 單元檔的取捨

- `RestartPreventExitStatus=2 3 5`：用法、設定錯誤或前置條件不符（例如另一實例持有鎖）重啟也不會好。
- halt 不會讓行程結束（健康端點持續回報 `halted:<reason>`），因此 systemd 不會把 halt 當成失敗重啟；
  要以 `/readyz` 或 `/status` 監控。
- 沒有 `ListenStream`、沒有開放埠：工具只外連，健康端點只綁 127.0.0.1。
