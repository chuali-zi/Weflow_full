# 在线聊天读取架构

状态：已接入正式 CLI 和 WeFlow GUI。依据为 [在线读取实验](online-read-experiment.md)。行为和接口见 [接入规格](live-spec.md)，实现阶段见 [完整接入方案](live-integration-plan.md)，已执行的验证及边界见 [热加载验证](live-validation.md)。

## 1. 目标与架构决策

微信和 WeFlow 同时运行时，新提交的聊天记录自动进入查询结果和当前聊天窗口，无需退出微信、重新复制数据库或重启 WeFlow。

采用 **SQLCipher 只读在线连接 + 现有 wxtext 密钥和消息适配 + WeFlow 变化通知**。由数据库引擎处理页面解密、认证、读事务和 WAL，不复制活动 WAL，不自行拼接变化中的数据库页。

保留 `snapshot` 离线模式。首次使用在线能力须显式选择 `live`；已有 profile 没有模式记录时继续使用 `snapshot`。选择成功后持久化，后续 CLI 和 GUI 共用。在线失败不得悄悄切回旧快照。

当前验证平台是 Windows x64、微信 4.1.13.65。真实账号已验证在线基础查询，合成加密库已通过真实 Electron 的新增、修改、删除、历史补入和滚动锚点测试。全部媒体、专用 FTS、其他微信版本及真实消息延迟的统计验收仍不在已验证范围内。

## 2. 数据流

```mermaid
flowchart LR
    WX[微信写入加密 DB / WAL] --> SQL[SQLCipher 只读连接]
    KEYS[wxtext 逐库认证] --> CACHE[DPAPI 密钥缓存]
    CACHE --> SQL
    SQL --> QUERY[现有联系人 / 消息适配]
    QUERY --> RPC[Python stdin / stdout RPC]
    RPC --> WORKER[localWcdbWorker]
    WORKER --> CHAT[WcdbService / ChatService]
    CHAT --> GUI[会话列表与聊天窗口]
    SQL --> CHANGE[data_version 检测]
    CHANGE --> INVALIDATE[缓存失效与变化事件]
    INVALIDATE --> RPC
```

响应和事件共用现有持久 Python 进程及 stdin/stdout，不新增 HTTP 服务或系统服务。

## 3. 两种数据源

| 项目 | snapshot | live |
| --- | --- | --- |
| 查询文件 | 已发布的明文副本 | 微信加密源库 |
| 引擎 | Python 普通 SQLite | Python SQLCipher |
| 一致视图 | 稳定文件与离线 WAL 重放 | 引擎读事务与 WAL 协调 |
| 解密时机 | 准备时整库解密 | 查询时按页解密 |
| 连接选项 | `mode=ro&immutable=1` | `mode=ro`，不能设置 immutable |
| 新数据 | 显式重建副本 | 下一短读事务读取新提交 |
| 退出要求 | 创建 / 更新副本时退出微信 | 不要求退出微信 |
| 明文整库副本 | 有 | 常规查看不产生 |

`wxtext/cipher.py`、`snapshot.py`、`wal.py` 保留离线责任。在线连接使用一个小模块，Backend 按模式选择；联系人映射、长文本解压、跨库合并和格式转换继续复用，无需建立通用插件框架。

live 不伪造 `active.json`，也不把加密源路径冒充已解密快照。当前会话明确保存模式、源路径、库清单和状态；读取副本元数据只发生在 snapshot 分支。

## 4. 连接、密钥与资源

连接顺序：规范化账号目录 → 枚举必需库 → 加载并认证逐库缓存 → 缺密钥时复用现有有界扫描 → SQLCipher 只读打开 → 实际 schema / 基础查询验证 → 发布可用会话。

连接设置 raw key 与库盐、SQLCipher 4 参数、`query_only=ON`、`trusted_schema=OFF`。未知 PRAGMA 可能被忽略，必须实际查询证明可读，不能因设置无报错就宣称兼容。

核心覆盖为联系人库和当前全部 `message_N.db`。会话、头像、媒体、FTS 等可选库按能力使用；打开过 schema 不代表专用查询已经支持。必需分库缺密钥不得报告完整账号。

有效密钥不随新消息重新扫描。缓存完整时微信未运行也可以 live 查询。目录变更、库重建、新分库和认证失败才触发重验 / 补取。

核心连接按需打开并保持，以比较同连接 data_version；可选库按需使用。所有 SQL 由 Python 主执行线程串行执行，不把一个连接交给计时线程和 RPC 线程并发使用。关闭账号、模式切换、EOF、进程退出均释放 SQL 游标、事务和连接。

异常边界同时处理 sqlite3 和 sqlcipher3 的异常。半成品连接及时关闭；raw key 不进入用户 JSON、事件、日志或异常详情。

源库不执行数据写入、rekey、VACUUM、journal_mode 切换或 checkpoint。在线连接会参与引擎锁和 WAL 共享内存协调，不能描述成完全不触及 sidecar 状态的普通文件读取。

## 5. 变化检测与执行循环

首版每 1 秒读取已连接核心库的 `PRAGMA data_version`，只比较同一连接的前后读数。它不是全局事务编号；重连后重建基线。每 10 秒轻量重新枚举库，并检查文件身份 / 首页盐，查询失败时立即复核。不得周期性整库摘要、整库解密或全部消息表 COUNT。

data_version 只能说明库发生提交，不能告诉我们哪个会话被修改。首版事件报告 changed databases，并以 account scope 触发查询；以后有实测需要再细化。WAL reset / checkpoint 由引擎处理。同路径文件替换必须关闭旧句柄、认证新库并重连。

`serve()` 已将 stdin 读取与 SQL 执行分开，空闲时也检测变化：

```text
输入线程：读取 stdin → 请求队列（不执行 SQL）
主线程：等待请求或下一检测时间
  → 串行处理 RPC
  → 到期检测变化 / 恢复
  → 输出响应或事件
EOF / shutdown → 关闭事务与连接
```

主线程独占 stdout，保持一行一个 JSON。长查询使用进度处理器和执行期限，不能长期堵住监控。检测提交后先更新基线、增加 revision、失效相关缓存和游标，再发事件；刷新过程中出现的新提交留给下一轮处理。

## 6. 查询、分页与一致性

普通 RPC 使用有界结果和短读事务，返回前结束 SQL 游标并提交 / 回滚。发送者映射与对应消息分库在同一事务内读。不同数据库的读事务不构成全局原子快照。

snapshot 保留原消息流；live 使用有界 SQL + keyset：游标只保存查询参数、位置、去重状态和 revision，不跨 RPC 持有源库事务，避免长期阻止 WAL 重用。

稳定排序使用 `create_time、sort_seq、local_id、相对分库路径`；跨库合并、非零 server_id 去重和字符串 ID 规则复用。相关库变化使旧分页游标明确失效，GUI 以可见消息为锚点重取页。跨 RPC 实时分页不承诺固定静态快照。

keyset 改造必须保留跨页去重：同一 server_id 的副本跨越页边界时也只显示一次，同秒分组尚未读取完时保留该组去重状态。server_id 为 0 时使用既有物理消息标识，不能按正文去重；相同正文的不同消息仍分别保留。

## 7. 缓存与界面

缓存按 profile、账号根目录、mode、connectionId、revision 区分，live 与 snapshot 不共用未标来源的磁盘统计。首版不知道变化会话时，使账号会话 / 统计缓存失效，重新生成会话列表；只刷新当前聊天可见页，禁止全量预载全部会话消息。

表结构 / 分库变化重新枚举 schema 和发送者映射。GUI 不能只比较最后消息时间增长，也不能只 append 去重：当前尾部合并新增，当前可见页重取处理更新、撤回、删除和历史插入；保留滚动锚点，其他历史页按需重新加载。

数据刷新与桌面通知分开。现有后端 unread_count 为 0，不能依赖它触发刷新，也不能将热加载成功扩展为准确未读计数或消息推送。

## 8. 导出

live 导出用独立只读连接，按分库在固定读事务中捕获请求范围到本机临时 spool。捕获后关闭源事务，再在 spool 上排序、去重、JSONL 输出和原格式转换。复用现有独立导出 Worker / 后端实例，不占 GUI 监控线程。

每分库捕获期限 5 秒，超时结束事务并清理本次临时输出，返回 LIVE_READ_TIMEOUT，提示缩小范围或显式 snapshot 导出。不同库不是同一原子时间点；结果声明 `consistency=per_database` 和捕获起止时间。冲突沿用现有明确报错，不能发布部分成功文件。

不以复制活动 DB/WAL 作为在线导出回退。整库在线备份是后续可选优化，需要另验加密源 / 目标格式兼容性，首版不依赖它。

## 9. 依赖与打包

正式依赖为 sqlcipher3 0.6.2，当前 Windows wheel 使用 SQLCipher 4.12.0 community / SQLite 3.51.1。已纳入 Python requirements 和 PyInstaller 显式收集，同时保留驱动的许可元数据；运行不依赖实验 vendor 或外置 DLL。

安装资源中的冻结后端必须实际完成解密查询和事件验证；安装版无需外置 Python / Node.js。按需连接后评估实验中的 VirtualLock 配额告警、内存和日志，不降低认证要求来消除错误。

## 10. 参考

- [SQLite data_version](https://www.sqlite.org/pragma.html#pragma_data_version)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite immutable](https://www.sqlite.org/uri.html)
- [SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/)
- [sqlcipher3](https://github.com/coleifer/sqlcipher3)
