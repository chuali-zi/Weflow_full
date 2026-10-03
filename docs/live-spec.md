# 在线读取与热加载接入规格

状态：当前实现契约及验收要求。CLI 模式、RPC、事件和 GUI 热加载已接入；已验证范围与尚未执行的验收见 [热加载验证](live-validation.md)。实际命令见 [CLI](cli.md)，架构见 [在线架构](live-architecture.md)，实现清单见 [实施方案](live-integration-plan.md)。

## 1. 模式与持久化

支持 snapshot / live，仅控制内置后端。显式配置外部 WCDB DLL 时沿用现有组件选择；路径错误继续报错。GUI 模式选项作用于内置后端，使用外部 DLL 的用户需先在原组件设置中清空路径；CLI configure / prepare / launch 会明确配置为内置后端。

模式唯一存于 profile 的 `backend/settings.json.database_modes`，键为与密钥缓存一致的规范化绝对 db_storage 路径：

```json
{
  "data_dir": "D:\\微信数据\\账号目录\\db_storage",
  "self_id": null,
  "database_modes": {
    "D:\\微信数据\\账号目录\\db_storage": "live"
  }
}
```

StateStore.select 更新目录时保留新增及未知字段。ConfigService 不另存模式；GUI 通过内置后端 RPC 读取 / 写入，CLI 共用 StateStore。

解析优先级：显式 --mode / RPC mode → 对应目录保存值 → snapshot。单次查询覆盖不持久化；prepare、configure、launch 的显式模式和 GUI 模式切换验证成功后保存。失败保留原选择。

decrypt 始终创建 / 更新离线副本且不改变保存模式，显式 `decrypt --mode live` 参数错误。--wait-exit 只对 snapshot 有效，live 显式传入返回参数错误；live 不要求退出或结束微信。

## 2. CLI 契约

当前命令：

```powershell
.\weflow.cmd prepare --mode live --launch
.\weflow.cmd prepare --mode live --data-dir "D:\微信数据\账号目录\db_storage" --launch
.\weflow.cmd status
.\weflow.cmd messages --mode live --session "wxid_example" --limit 50
.\weflow.cmd search --mode live --keyword "周末" --session "wxid_example"
.\weflow.cmd export --mode live --session "wxid_example" --output "D:\导出"
.\weflow.cmd prepare --mode snapshot --wait-exit 180 --launch
```

| 命令 | live 行为 |
| --- | --- |
| doctor / accounts | 显示环境、可发现账号与已保存模式；引擎实际可用性通过 verify --mode live 校验，不暴露密钥 |
| keys | 保留现有逐库扫描 / 缓存语义，与读取模式独立 |
| prepare | 获取 / 复用密钥 → 只读连接核心库 → 基础查询验证 → 配置 GUI / 保存模式；不准备明文整库副本 |
| verify | 验证密钥、连接、覆盖与有界基础查询；不宣称全库页 / FTS 完整检查 |
| configure / launch | 按模式验证和配置原 GUI，保留现有 profile 占用、协议和应用锁行为 |
| status | 模式、状态、覆盖、引擎和能力范围；一次 CLI status 不代表持续监控 |
| sessions / messages / search | 当前源库短读事务查询，附加 freshness，不改保存模式 |
| export | 捕获请求记录到 spool，再生成输出；报告捕获时间与逐库一致性 |
| decrypt | 只准备 snapshot，仍要求微信正常退出 |

一次性 CLI 查询结束释放连接，持久 GUI 后端承担监控。实验 --watch 不是正式新命令，首版不新增 watch 服务。CLI 保持一个最终 stdout JSON，进度写 stderr；内部事件不能混入 CLI 最终结果。

完整有效缓存存在时 live prepare 不要求微信运行；缺缓存才要求登录。状态 / 查询增加字段示例：

```json
{
  "success": true,
  "mode": "live",
  "state": "ready",
  "complete": true,
  "missingDatabases": [],
  "freshness": {
    "connectionId": "opaque-session-id",
    "revision": 0,
    "queriedAt": "2026-10-03T00:00:00-04:00",
    "consistency": "per_database"
  }
}
```

queriedAt 是查询时间，不是最后消息时间。revision 仅在同一 connectionId 中比较，不跨 CLI 调用比较。原 GUI open 的 bool 和消息响应包装保持兼容，新状态通过专用 RPC 获取。

## 3. RPC 契约

| 方法 | 接入要求 |
| --- | --- |
| open / testConnection | 可选 mode；live 不调用 ensure_snapshot / createSnapshot；测试不能破坏另一活动账号 |
| getConnectionStatus | 返回 mode、state、complete、missingDatabases、connectionId、revision、引擎和能力 |
| connectionConfig | 按模式提供已验证 GUI 配置；live 不依赖 snapshotConfig。兼容所需密钥仅在应用内部桥接，不进入 CLI 用户结果 |
| setReadMode | `{dataDir, mode}` 验证后经连接操作队列切换并保存；失败不持久化 |
| setMonitor | enabled 默认 true；live 支持检测开关，snapshot 明确返回不支持实时监控 |
| 查询方法 | 复用会话 / 消息 / 搜索响应；live 使用短事务 |
| 消息游标 | 只保存 keyset 参数与 revision；相关提交后 fetch 返回 CURSOR_STALE |
| cancel | `{requestId}` 取消本后端正在执行的长查询 / 捕获；不结束微信 |
| close / shutdown | 停止检测、结束事务、关闭连接；EOF 同样清理 |

每次 live RPC 使用缓存前先检查相关连接版本；定时检测负责空闲时通知。setMonitor(false) 暂停定时通知，不暂停源数据变化；重新启用时核对基线并触发一次刷新。pollLiveChanges 为内部调度方法，GUI 不轮询全部消息。

cancel 不能排在长任务结束后才生效。输入线程仅为目标 requestId 设置取消标志，SQL 主线程的 progress handler 检查标志并结束本次查询 / 回滚；响应仍由主线程输出。LocalBackendClient 的取消入口直接写入传输，不经过 Worker 普通请求的串行等待链。独立导出进程收到取消后清理 spool 和临时输出，源连接关闭。取消已结束请求是无副作用的成功结果。

## 4. 事件协议与顺序

请求响应保持 `{"id": n, "result": ...}`。变化事件无 id：

```json
{
  "type": "change",
  "payload": {
    "table": "Session",
    "reason": "database_commit",
    "mode": "live",
    "accountId": "wxid_example",
    "connectionId": "opaque-session-id",
    "revision": 7,
    "scope": "account",
    "databases": ["message/message_0.db"],
    "requiresReload": true
  }
}
```

table=Session 是兼容原刷新入口的逻辑分类，不声称知道真实 Session 表被改。首版使用 account scope；未知受影响会话时不编造 sessionIds。

```text
Python change
 → LocalBackendClient 专用事件订阅（绕过 pending id 匹配）
 → localWcdbWorker postMessage
   {type: 'monitor', payload: {type: 'update', json: JSON.stringify(payload)}}
 → WcdbService monitorListener
 → ChatService 缓存失效和 wcdb-change 广播
 → GlobalSessionMonitor 刷新会话与当前页
```

同会话 revision 单调递增；重连 / 切账号生成新 connectionId。前端重建订阅基线，丢弃旧事件和旧异步结果。缓存先失效再发事件。事件不含密钥、正文或源 SQL。

状态事件为 `{"type":"connection-status","payload":...}`，携带 connectionId、mode、state、code 和重试信息。Client / Worker 均须转发，GUI 更新原状态区域；只在状态改变时发送。

Worker 的状态消息同样无请求 id。WcdbService 显式分流 connection-status，ChatService 通过新增 `database-status` IPC 广播，preload 提供 `onDatabaseStatus` 订阅；不能让状态消息落入 pending 请求匹配后丢失。状态事件用于展示恢复，change 事件用于数据刷新。

## 5. GUI 契约

- 原 Welcome / 设置处增加内置“在线读取 / 离线副本”选择，保留原目录、获取密钥和连接入口；仅离线准备提示退出。
- 展示数据来源及 ready / reconnecting / needs_key 等状态，snapshot 展示捕获时间，不另建准备首页。
- live 事件刷新会话列表和当前可见页，不以最后时间增长或 unread_count 增长为唯一条件。
- 尾部新增按稳定 key 合并；修改、撤回和删除通过完整重取当前页处理，不能只 append 去重。
- 阅读历史时按可见消息锚点重取页，保持滚动位置；锚点被删则选邻近消息。其他旧页失效后按需重取。
- 只有完整重新取得某页才能据此删除旧页中缺失记录；不能用截断的增量结果推断删除。
- 刷新串行合并；异步结果和分页都校验账号 / connectionId。CURSOR_STALE 重取锚点页，不显示数据库损坏。
- 数据刷新与桌面通知分开；首版不承诺准确未读、HTTP 推送或防撤回写回，追补历史不批量弹通知。

## 6. 恢复、错误与覆盖

| 状态 | 含义 |
| --- | --- |
| ready | 核心库覆盖完整，可查询 |
| reconnecting | 临时忙碌、IO 或文件切换；保留已有界面并标明正在恢复 |
| needs_key | 新必需库 / 重建库缺密钥，complete=false，通过原密钥入口恢复 |
| degraded | 暂不完整或可选能力失败，明确说明范围，不伪装 ready |
| disconnected | 目录不存在、账号切走或持续读取失败，释放无效连接 |
| error | 引擎缺失、格式不支持、认证失败，不自动切快照 |

微信退出不等于 disconnected，缓存和源库可读就继续查询。微信重启检查文件身份、盐和清单，有效密钥复用；成功重连生成新 connectionId 并完整刷新。

BUSY / LOCKED 每次等候 ≤250 ms，1、2、5 秒退避；普通查询执行期限 2 秒，显式捕获 / 统计期限另行控制。禁止无限等待或把 busy 当成缺密钥。IO / 文件替换关闭句柄再重验。有界自动补取失败后停在可操作状态，不每秒扫描内存。

新必需分库缺密钥时保留已有显示，complete=false；新的全账号查询 / 导出返回 KEY_NOT_FOUND，不把缺库结果当成功完整数据。可选库失败只影响该能力。补齐后重建 schema / 映射并恢复。

| 新错误码 | CLI 退出码 | 含义 |
| --- | --- | --- |
| LIVE_ENGINE_UNAVAILABLE | 18 | 引擎或冻结依赖缺失 |
| LIVE_BUSY | 19 | 短重试后仍忙碌 |
| LIVE_READ_TIMEOUT | 20 | 查询或捕获超期 |
| SOURCE_REPLACED | 21 | 源库替换，需要重验连接 |
| CURSOR_STALE | 22 | 相关提交使分页失效 |
| CANCELLED | 23 | 用户取消当前查询或捕获 |

现有退出码保留。HMAC 失败仍是认证错误，禁止关闭认证继续读。live verify 的有限检查在结果中说明；完整整库检查继续使用显式 snapshot 验证。

## 7. 搜索、统计和导出

搜索使用现有可用适配，不依赖 MMFtsTokenizer。统计按账号、mode、revision 缓存，按需计算；长搜索 / 统计须有执行期限及取消，不能堵住 GUI 检测线程。live 用户 SQL 仍受只读连接限制，不开放源写入能力。

导出按分库固定读事务捕获到 spool，期限每库 5 秒；捕获结束释放源事务，再做原 JSONL / TXT / HTML / ChatLab JSON / WeClone CSV 转换。独立导出后端避免阻塞 GUI；超时清理临时文件，不发布部分结果。spool 保留既有发送者、解压和跨库冲突规则。

导出补充 mode、captureStartedAt、captureFinishedAt、consistency=per_database，不声称跨库全局原子快照。大范围捕获超时明确建议缩小范围或选 snapshot。snapshot 导出保持固定副本语义。

## 8. 验收标准

以下是完整验收要求；各项实际完成情况单独记录在 [热加载验证](live-validation.md)，不能把合成测试或打包资源验证扩展为所有真实场景均已通过：

| 场景 | 通过条件 |
| --- | --- |
| 普通新消息 | 微信、WeFlow 不退出，当前窗口出现且不重复 |
| 同秒 / 突发 | 至少 20 条，包含同秒时间戳，与源查询核对无漏项 / 重复 |
| 更新 / 撤回 / 删除 | 当前已显示页反映变化，不仅追加 |
| 历史补同步 | 最后时间不增长时历史重载仍能读到补入 |
| WAL 生命周期 | 真实收发及合成 checkpoint / reset / 未提交测试通过 |
| 空闲监控 | 无 RPC 请求仍自动发变化事件 |
| 模式切换 | 来源、标签、缓存一致；失败不改保存配置 |
| 重启 / 新分库 | 微信重启可恢复，缺密钥明确降级，补齐恢复 |
| 账号切换 | 旧事件与异步结果不污染新账号 |
| 查询 / 导出 | 基础格式可用，捕获一致性与时间可解释 |
| 安装包 | 无外置 Python / Node / vendor 仍可准备、查看、自动刷新 |

参考实验规模，普通消息提交到渲染目标 p95 ≤3 秒、最长 ≤5 秒，至少测 20 次。以独立源读取首次可见提交作为测量起点，同时记录事件和渲染时间；不能用轮询参数推算延迟。长任务期间另测刷新，日常检测不得全表 COUNT / 整库复制 / 整库解密。

真实账号进行一次完整端到端验证；事务、分页、恢复和事件竞态主要用少量合成数据。只保留覆盖行为的必要回归，不扩展成证据包体系。

## 图片附件热加载补充（2026-10-03）

数据库提交和附件下载不是同一事务。图片消息通过原消息热加载进入页面；V2 DAT 通过账号独立图片密钥解密。数据库密钥和 XML 中的 CDN aeskey 不能替代本地 DAT 密钥。

内置 `getImageKeys` 用所选账号近期本地图片验证候选 AES 密钥的完整加密前缀和 PKCS#7 padding，并检查 JPEG 尾部；结果按账号目录保存在 DPAPI 缓存。优先只读获取 global_config 中的 cfgDword 并派生图片密钥，失败后限时扫描候选；版本相关布局只有经过实际图片验证才接受。GUI 将密钥通过现有 ConfigService 保存到当前账号配置，首次 V2 解密缺密钥时自动获取，并合并同账号并发请求。

`resolveImageHardlink` / `resolveImageHardlinkBatch` 从当前连接的 hardlink.db 读取 md5、目录 ID 和文件名；只返回所选账号内实际存在的附件，优先原图、普通图、缩略图。查不到时不得永久缓存失败。在线模式中可见且未解析成功的图片每 3 秒重试，成功或离开可见范围后停止；手动点击仍可强制重试。

本次范围是已在本机落盘的 V2 聊天图片，既有 wxgf 转换流程继续使用。微信尚未下载的图片不会凭空恢复，不执行 CDN 下载或微信 UI 自动点击。其他媒体类型继续按原能力范围说明。

V2 解密后的内容也可能是 HEIC 原图。按 `ftyp` 的主品牌及兼容品牌识别 HEIC，使用独立 Worker 中的 heic-decode/libheif-js 解码，再由 Sharp 生成 JPEG 预览缓存；保留完整宽高，源 DAT 不改动。HEIC 标识也纳入图片密钥验证的合法格式，不能将已正确解密的 HEIC 归为密钥错误。转换失败返回 `decrypt_failed`，聊天页沿用既有重试流程。

技术参考：[wechatauto-replica 图片格式与派生流程](https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/media.py)、[global_config 布局](https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/db.py)；实现复用本仓库现有 Windows 只读访问、密钥缓存和 JS 解密服务。
