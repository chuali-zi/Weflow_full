# 热加载实现与验证

当前实现已接入正式 CLI 和原 WeFlow GUI。验证平台为 Windows x64、微信 4.1.13.65，sqlcipher3 0.6.2 / SQLCipher 4.12.0 / SQLite 3.51.1。旧 profile 默认 snapshot；首次使用在线模式需要明确选择 live。

## 使用

保持微信登录，在仓库根目录运行：

```powershell
.\weflow.cmd prepare --mode live --launch
.\weflow.cmd verify --mode live
.\weflow.cmd sessions --mode live
.\weflow.cmd messages --mode live --session "wxid_example" --limit 50
.\weflow.cmd search --mode live --keyword "周末" --session "wxid_example"
.\weflow.cmd export --mode live --session "wxid_example" --output "D:\导出"
```

多个账号时加 `--data-dir`。prepare / configure / launch 成功后保存选择，后续命令和 GUI 共用；单次查询的 --mode 不改变保存模式。原 Welcome / 设置也可选择内置在线模式。显式配置了第三方 WCDB DLL 时，需先清空该路径才能使用内置模式；CLI 配置会切到内置后端。

live 直接只读查询加密源库，由 SQLCipher 处理页面认证和 WAL。后台每秒比较同连接 data_version，变化后先失效缓存，再刷新会话列表及当前消息窗口。不只根据最后消息时间判断，因此同秒消息、修改、删除和历史补入也能触发刷新。正常查看不生成整库明文副本。

需要固定副本时显式使用 `prepare --mode snapshot --wait-exit 180 --launch`；decrypt 始终创建 snapshot。在线大范围导出超过每库 5 秒捕获期限时，缩小范围或选择 snapshot。在线导出声明 per_database 一致性，不保证多个分库在同一全局时刻。

## 已执行验证

| 层次 | 结果 |
| --- | --- |
| Python 后端 / CLI | 33 项回归通过，保留原 snapshot 行为及 CLI 错误 / 配置检查，增加 V2 图片密钥验证和晚到附件索引测试。 |
| SQLCipher 读事务 | 未提交不可见、提交可见、checkpoint 后可读；只读拒写，各次读取结束后无遗留事务。 |
| 分页 | 相同时间、排序号和本地 ID 的跨库消息稳定分页；跨页 server_id 去重，零 ID 消息保留；提交使旧游标明确失效。 |
| 覆盖及恢复 | 新必需分库缺密钥时阻止部分结果冒充完整数据；补齐密钥后重连并生成新 connectionId。 |
| RPC | 无查询请求时仍发送提交事件；取消绕过长任务队列，结束查询后连接仍可使用。 |
| 在线导出 | 同一分库多个会话在固定事务中捕获；并发提交在下一次导出可见；超时回滚且不发布临时输出。 |
| 源码真实 Electron | 后端 → Worker → ChatService → 聊天页完整链路：20 条同秒新增、修改、删除、历史补入及滚动锚点通过，JSON 导出 25 条预期消息。 |
| 包内资源 Electron | 同一完整热加载与导出测试通过；应用配置的 Python / 源码路径不存在，实际使用冻结后端。扩展和驱动许可元数据已包含在后端内。 |
| snapshot 桌面回归 | 原会话 / 消息 / 搜索及 TXT、HTML、JSON、WeClone CSV 导出通过。 |
| 真实账号 | 微信继续运行时，源码 CLI live verify 约 2.2 秒完成；包内 weflow.cmd 同样返回 ready、complete=true、411 个实际聊天会话及 5 条抽样消息。包内 launch 已保存现有 profile 为 live 并启动 WeFlow。 |
| Windows 交付 | 最终 win-unpacked 与 WeFlow-Local-5.0.0-Setup.exe 已重新生成；完整 NSIS 交互安装尚未执行。 |

最终测试等待当前消息页完成刷新和布局后才进入下一场景。源码的新增、修改、删除、历史补入分别约 2.48、2.77、2.76、3.52 秒；包内资源分别约 3.49、2.74、2.75、3.49 秒。计时从启动合成写入进程开始，包含启动、测试主动查询及布局等待成本；这是四次场景测量，不是 20 次独立真实消息的 p95 验收。

测试明确将历史位置移到距底部超过 180 像素处，并以稳定消息 key 和 12 像素内的偏移误差检查锚点。只收到后端事件并不代表页面刷新完成，负向 DOM 断言也不能单凭虚拟列表中没有某条消息判断删除成功，因此脚本等待页面刷新事件及布局。

## 复现

```powershell
npm run test:backend
npm run build:app
npm run check:desktop
npm run check:live
node scripts/package-backend.cjs
node node_modules/electron-builder/cli.js --win --x64 --dir --publish never
npm run check:live -- --packaged
```

桌面热加载脚本生成合成加密账号，通过实际 DOM 消息气泡判断变化，并检查可见消息锚点；不会修改真实微信数据库或发送消息。包内资源测试故意给应用设置不存在的 Python / 源码路径，应用查询由冻结后端完成；外层 Python 仅负责生成和修改测试数据。日志及合成输出保留在忽略的 .runtime 目录。

## 尚未完成的验收

完整 NSIS 交互安装、其他微信版本、真实微信退出 / 重启全流程、跨账号 GUI 切换及真实消息至少 20 次的延迟统计仍需单独验收。本次没有结束或启动微信。视频 / 语音等其他媒体恢复、微信专用 FTS tokenizer、准确未读计数及所有高级报表不属于已验证范围。

## 图片补充验证（2026-10-03）

真实账号近期 200 个 DAT 文件均为 V2；当前微信主进程只读获取及实际图片验证约 0.51 秒。通过 GUI 的 ImageDecryptService 和 WCDB Worker 定位近期 20 张本地附件，源码和冻结后端均为 20 张全部解密成功、Sharp 完整解码成功，设置页使用的清洗账号 ID 路径也成功获取验证密钥。验证只输出计数，不输出密钥或展示聊天图片。图片密钥存储在 DPAPI 缓存及现有 ConfigService 的账号加密配置中。

`npm run check:live` 增加真实聊天页晚到图片测试：先提交图片消息且无 DAT，确认尚未显示图片，再只写合成 DAT（无额外消息数据库提交），源码约 3.33 秒、包内资源约 3.67 秒后自动解密并显示 1 像素 PNG。20 条同秒文字新增、修改、删除、历史补入、滚动锚点与 JSON 导出回归同时通过。这是合成场景的一次测量，不代表真实新图片的延迟分布。

真实账号服务验证可显式设置 `WEFLOW_IMAGE_ACCOUNT`（含 db_storage 的账号目录）、`WEFLOW_USER_DATA_PATH`（WeFlow profile）后运行 `node scripts/check-image-services.cjs`。它只读源数据库与附件，使用应用图片缓存和加密配置；不发送消息。设置 `WEFLOW_IMAGE_RESOURCES` 为 win-unpacked/resources 可验证冻结后端。

实现和契约见 [架构](live-architecture.md)、[规格](live-spec.md)、[接入方案](live-integration-plan.md)，历史实验依据见 [在线读取实验](online-read-experiment.md)。

## 启动聊天路由回归（2026-10-03）

使用现有真实 profile 复现启动后立即点击聊天：原版本从 `/chat` 跳到 `/`，随后自动连接完成跳到 `/home`，聊天页被卸载。原因是 RouteGuard 在异步启动连接完成前使用初始 `isDbConnected=false` 执行重定向。

AppStore 增加 `isDbInitializing`，App 自动连接在 `finally` 结束初始化状态。连接未完成时，受保护页面保持请求路由并显示连接提示，连接失败或缺少配置后才沿用未连接时的重定向。过期的启动连接结果不更新当前页面。

`npm run check:startup` 使用合成账号，`npm run check:startup -- --user-data <现有 profile>` 可只读复测已有账号；加 `--packaged` 验证打包资源。测试不手动连接、不清理缓存、不修复真实配置，直接点击侧栏聊天并逐帧检查路由保留，然后打开第一个会话。源码和打包资源的合成账号（3 个会话）、现有真实账号（416 个会话）均通过。

热加载回归在断言末尾消息前等待 Virtuoso 的实际底部位置稳定，避免新增消息后虚拟列表仍在测量高度时把屏外内容误判为更新失败。

## HEIC 原图失败修复（2026-10-03）

只读扫描真实账号 19,631 个本地 DAT 的格式、AES 前缀及严格 padding：14,349 个为 JPEG/PNG 等普通图片，5,273 个为 wxgf，9 个为 HEIC 原图。9 个 HEIC 的 AES 解密和 padding 均正确，但旧 JS fallback 未识别 `ftyp/heic`，因此丢弃解密结果并报告失败。已增加 HEIC 识别、独立 Worker 解码及完整分辨率 JPEG 预览缓存；后端密钥验证也接受 HEIC 前缀。

最近 500 张和按标识抽样 1,000 张的实际图片服务验证均完整解码通过（两组可能重叠，不能视作 1,500 张不同图片）。9 张 HEIC 专项在源码、冻结后端和实际 asar 转换 Worker 中均为定位 9、解密 9、完整像素解码 9、Electron 显示 9；显式跳过已有磁盘缓存，确保执行新增解码流程。另直接验证 8 个真实 wxgf 文件，解密、转换和完整像素解码全部通过。全目录扫描只验证格式和加密前缀，不代表全部文件都已完整解码。

Python 回归现为 34 项全部通过，新增 HEIC 兼容品牌密钥验证。源码热加载回归通过同秒新增、修改、删除、历史锚点、晚到图片和导出，晚到图片约 2.81 秒显示。真实文件、密钥和图片像素未提交到仓库。

包内热加载单独复测通过上述场景，晚到图片约 3.57 秒显示。与 NSIS 构建并行的首轮回归曾在末尾消息可见性断言超时：源查询和页面刷新均已包含新增消息，但虚拟列表停在中段；构建完成后的独立复测通过。本次未修改滚动逻辑，这一时序现象尚未作为独立问题稳定复现或修复。

`scripts/check-image-services.cjs` 可通过 `WEFLOW_IMAGE_LIMIT` 扩大样本（上限 1,000），`WEFLOW_IMAGE_SAMPLE=spread` 按标识抽样。`WEFLOW_IMAGE_FILES` 指向本机待验证 DAT 路径数组的 JSON 文件时只检查这些文件；`WEFLOW_IMAGE_FRESH=1` 跳过现有输出缓存，验证实际解密转换。设置 `WEFLOW_IMAGE_RESOURCES` 后，HEIC Worker 及其依赖从真实 asar 加载。
