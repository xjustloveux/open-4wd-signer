# open-4wd-signer

Open4WD 常駐治理簽署工具（governance signer）的部署設定：Kubernetes manifest、systemd 單元檔與部署
workflow。工具本身的程式、打包與映像建置都在主 repo `open-4wd`
（`tools/governance-signer/`、`pnpm build:signer`、`.github/workflows/signer-image.yml`）；本 repo
不含程式碼，也不含任何金鑰。

治理簽署者持有一把治理金鑰，依帳本規則對檢查點提案、投票與定稿。每位簽署者各自跑一個實例。

## 與主 repo 的關係

| 項目                                                   | 位置                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| 程式、CLI、退出碼、健康端點                            | 主 repo `tools/governance-signer/`                                  |
| 信任根（ledger 位址、genesis 時戳、governanceSigners） | 打包時內嵌的主 repo 部署值，依 `OPEN4WD_PROFILE` 選用，執行期不可改 |
| 映像                                                   | 主 repo 的 `signer-image.yml`（手動觸發），推到 GHCR，輸出 digest   |
| 部署                                                   | 本 repo（`deploy/`、`.github/workflows/deploy.yml`）                |

映像一律以 digest 引用（`ghcr.io/<owner>/open-4wd-governance-signer@sha256:<digest>`），不使用 latest 或
可變標籤；`scripts/render.mjs` 會拒絕非 digest 的參照。映像內的 `/app/build-info.json` 記錄 commit、
`mainSha256`、規則版本（`ruleEpochs`）與三份部署值的 SHA-256（`deploymentValuesSha256`），部署前請核對。
執行中的實例在 `/status` 的 `deploymentValuesSha256` 回報使用中 profile 的部署值（信任根）指紋，應與
build-info.json 中同一 profile 的值相同。

版本號目前維持 `0.0.0`，實際以 commit（與映像 digest）識別；正式發版的版本號規則另議。

## 正式部署前置

- **001488（正式部署的前置）**：pinning 節點 vendored 的帳本必須先更新到接受檢查點控制事件的版本，否則會拒收
  簽署工具寫出的治理事件。完成前只能做本機與開發驗證，不要部署到 private-playtest 或 public。
- **001539（擴編的前置）**：`config-update` 目前只支援簽署者恰為一位。從 N=1 擴編到多位之後，任何治理
  設定調整都需要多人收簽，在 001539 實作前無法進行。擴編前先確認這個限制可以接受。
- 部署值的 `governanceSigners` 必須是正式金鑰的 PeerId。主 repo 公開的開發金鑰
  （`tools/governance-signer/dev/development-governance.key`）**絕不可用於 private-playtest 或 public**；
  部署值檢查與工具都會以 `governance-signer-development-key` 拒絕。

## 金鑰

- 正式金鑰在離線機器以 `node main.mjs keygen --out governance.key` 產生（24 詞助記詞；`keygen` 是唯一會
  輸出助記詞的指令），另以紙本等方式離線備份。
- 每位簽署者只在**一個節點**放金鑰檔：`/etc/open4wd-signer/governance.key`，擁有者 uid 10001
  （systemd 為服務帳號）、權限 0400；群組或其他人可讀時工具拒絕啟動。
- 同一把金鑰絕不能同時在兩處執行。工具偵測到自己的票不是本行程投出的（foreign-instance）或重複簽署時
  會 halt。
- 本 repo、manifest 與 deploy workflow 都不接觸金鑰內容；workflow 唯一的 secret 是 `KUBE_CONFIG`。

## Kubernetes

`deploy/k8s/`：

| 檔案                 | 內容                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `namespace.yaml`     | `open4wd-signer`；Pod Security 只以 restricted 發出 warn／audit、不設 enforce（見下方「Pod Security」）            |
| `pvc.yaml`           | 資料目錄，ReadWriteOnce                                                                                            |
| `deployment.yaml`    | `replicas: 1`、`Recreate`、nodeSelector 指定金鑰節點、hostPath 唯讀金鑰檔、uid 10001、唯讀根檔案系統、丟棄所有能力 |
| `networkpolicy.yaml` | 拒絕所有入站，出站不限                                                                                             |
| `admin-job.yaml`     | 管理指令的 Job 範本（不在 kustomization 內）                                                                       |
| `kustomization.yaml` | 套用上面四份（不含 admin-job）                                                                                     |

工具只外連、不監聽、不當中繼，因此沒有 containerPort 與 Service。健康端點 `/healthz`、`/readyz`、
`/status` 只綁 `127.0.0.1:9475`，liveness 探針在容器內以 exec 存取 `/healthz`。

### 只設 liveness、不設 readiness

- **為何不設 readiness**：沒有 Service 依賴就緒狀態；而 `/readyz` 在同步閘未過（正式 profile 需要對等節點與
  120 秒靜默期）、非簽署者或 halted 時都回 503，設了 readiness 會讓 `kubectl rollout status` 與部署
  workflow 把正常的同步過程誤判為部署失敗。
- **halted 時 k8s 看不到**：halt（重複簽署、foreign-instance、conflict 等）時行程刻意不退出，持續提供健康端點，
  `/healthz` 仍回 200，所以 liveness 不會重啟它，pod 在 k8s 看起來一切正常。營運者必須另外監看
  `/status`（`phase`、`haltReason`）或記錄中的 halt 事件，例如定期執行
  `kubectl -n open4wd-signer exec deployment/open4wd-governance-signer -- node /app/main.mjs status`，
  或收集 stdout 的 JSON lines 記錄並對 `level: error` 告警。halt 不會自行解除，見下方「halt」。

### Pod Security：此 namespace 需要放寬

金鑰以節點專屬的 hostPath 檔案掛入，而 Pod Security 的 baseline 與 restricted 都禁止 hostPath，
**若叢集或此 namespace enforce baseline／restricted，pod 會被拒絕建立**。這是刻意的取捨：金鑰只存在單一節點、
不進入任何 Kubernetes 物件（Secret 等），配合 `replicas: 1`、`Recreate`、ReadWriteOnce 資料卷與 nodeSelector，
構成「同一把金鑰只會在一處執行」的單一實例防線；改用 Secret 會讓金鑰可被排程到任何節點、也會進入 etcd。

`namespace.yaml` 因此不設 `enforce`，只以 restricted 發出 `warn` 與 `audit`，讓 hostPath 以外的偏離
（root、特權提升、能力）仍會被看見。若叢集預設 enforce baseline，需由叢集管理者對這個 namespace 明確放寬
（例如加上 `pod-security.kubernetes.io/enforce: privileged`），並以其他手段（准入政策、稽核）限制此
namespace 只能有這一個工作負載。

### 部署 workflow

`.github/workflows/deploy.yml` 只手動觸發，且只在 repository 變數 `SIGNER_DEPLOY_ENABLED` 為 `true`、在預設
分支時執行。設定：

| 種類        | 名稱                    | 說明                                                   |
| ----------- | ----------------------- | ------------------------------------------------------ |
| 變數        | `SIGNER_DEPLOY_ENABLED` | `true` 才執行                                          |
| 變數        | `SIGNER_IMAGE`          | 映像 digest 參照                                       |
| 變數        | `SIGNER_NODE_NAME`      | 放金鑰檔的節點（`kubernetes.io/hostname`）             |
| 變數        | `SIGNER_PROFILE`        | `private-playtest` 或 `public`                         |
| 變數        | `SIGNER_BOOTSTRAP`      | 逗號分隔的 bootstrap multiaddr，每個含 `/p2p/<PeerId>` |
| secret      | `KUBE_CONFIG`           | 叢集連線設定                                           |
| environment | `production`            | 可在 GitHub 設定審核者                                 |

流程：`node --test 'scripts/*.test.mjs'`（manifest 不變式）→ `scripts/render.mjs` 在 checkout 外渲染
→ `kubectl apply -k` → 等 rollout。

本機驗證：`npm test`（或 `node --test 'scripts/*.test.mjs'`），只用 node 內建模組，沒有任何依賴。

## systemd

不用 Kubernetes 時見 `deploy/systemd/README.md`：直接以 node 執行從映像取出的打包產物。

## 管理指令

`clear-halt`、`release-lock`、`config-export`、`config-update` 與常駐的 `run` 共用資料目錄與
`instance.lock`。**執行前必須先停常駐實例**（k8s：`kubectl -n open4wd-signer scale
deployment/open4wd-governance-signer --replicas=0` 並等 pod 結束；systemd：`systemctl stop`），否則回退出碼 5。
`check` 不取實例鎖、不修改資料目錄，常駐實例運作中也可以執行。k8s 用 `admin-job.yaml` 範本，因為 Job 不是 TTY，需要確認字串的指令先以 `--dry-run` 取得確認字串，再以
`--confirm '<確認字串>'` 重跑。

退出碼：0 成功、2 用法錯誤、3 設定錯誤、4 執行錯誤、5 前置條件不符。

### release-lock 的殘餘風險（001545、001546）

`release-lock` 只在卡死滿 24 小時、本節點恰綁一個本體且這一錨尚未釋放過時可用。它本質上是受控的重複簽署，
每一錨每人只能釋放一次，執行前依下列程序人工確認：

- **001545（已知營運殘餘風險）**：帳本只看得到已公開的票。執行前逐一聯絡其他簽署者，確認各自只投過一個
  本體、沒有任何本體已達 quorum（包括尚未公開的票）；無法確認時不要釋放。非 TTY 執行時另須帶
  `--acknowledge-hidden-quorum-risk`，表示已完成這項確認。
- **001546（修補前的操作限制）**：改投前確認投票對象有誠實簽署者的第一票支撐；只有在這項確認成立時才
  釋放。

### release-lock、config-update 之後必須重新啟動 run

這兩個指令寫入的票或設定更新，靠 `run` 連線時的 heads 交換傳出；完成後要把常駐實例啟動回來（k8s：scale 回
1）。若仍未送達，主迴圈會在自己有票的本體逾時未定稿時自動重送 heads。

### halt

偵測到重複簽署、foreign-instance、conflict、投票鎖儲存不可用、未知規則版本（`rule-epoch-unknown`，代表需要
更新工具版本）或實例鎖遺失時，工具 halt 並寫入資料目錄的 `halt.json`；行程不會結束，`/readyz` 回
`halted:<原因>`。`halt.json` 無法解析時同樣維持 halted，原因回報為 `halt-record-corrupt`（原本的原因
已無從得知，要從記錄的 `halted` 事件查出，解除時確認字串為 `clear-halt corrupt`）。`halt.json` 存在但無法讀取（權限不足、
不是一般檔案）時原因回報為 `halt-record-unreadable`：先修正檔案權限或型別，`clear-halt` 在這種情況下不刪除該檔並回
退出碼 4。確認原因並處理後，停掉常駐實例再以 `clear-halt` 逐字確認解除。

## 單一實例與接手

- k8s：`replicas: 1`＋`Recreate`＋ReadWriteOnce＋節點專屬金鑰；systemd：單一主機。
- 工具另以資料目錄的 `instance.lock` 防止同時執行：同主機上持有者行程仍在就拒絕；容器在同一 Pod 內重啟、
  新行程拿到與舊行程相同的 pid 時，舊鎖視為過期鎖接手並記警告；鎖由**其他主機**持有時，
  心跳（每分鐘更新）超過 3 個間隔未更新才接手並記警告。**跨主機接手依賴兩台主機的時鐘**，時鐘偏差大時可能
  過早或過晚接手；搬移資料卷到另一主機前先確認舊實例已停、兩台主機都有校時。最終防線仍是節點專屬金鑰、
  RWO 資料卷與 foreign-instance 偵測。
- 缺心跳欄位的鎖檔視為無法解析而拒絕啟動；確認沒有實例在跑之後，**人工刪除資料目錄內的 `instance.lock`**。
- 同時接手同一份過期鎖時只有一個行程成功。接手途中行程被強制終止會留下 `instance.lock.takeover-*` 權杖檔，
  之後對同一份舊鎖的接手都會拒絕；確認沒有實例在跑之後人工刪除該權杖檔。
- 同主機的鎖判斷（pid 存活檢查與 pid 重用接手）假設主機名稱相同即共用同一 PID 命名空間：共用同一資料卷的實例不得設定
  相同主機名稱（不使用 `hostNetwork`、不共用宿主機 UTS 命名空間、不手動指定相同 hostname）。

## 已知限制

- 同步閘：過閘條件是 ledger topic 訂閱者數達到 `SIGNER_MIN_SYNC_PEERS` 且之後靜默 `SIGNER_SYNC_QUIET_MS`
  （正式預設 120000 ms），沒有逾時放行；與對等節點比對最新檢查點尚未實作。
- 內容區塊沒有 GC，資料卷會隨帳本成長（主 repo issue 001548）。

## 授權

MIT，見 `LICENSE`。映像內附 `LICENSE`、`THIRD_PARTY_NOTICES.md` 與 `THIRD_PARTY_LICENSES.txt`（打包進產物的
第三方套件授權）。
