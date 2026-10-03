# 在线读取完整接入方案

状态：阶段一至三已落到代码；阶段四已接入冻结依赖和包内资源验证流程，完整交互安装及真实重启验收仍待执行。架构见 [live-architecture](live-architecture.md)，接口和验收见 [live-spec](live-spec.md)，实测结果见 [热加载验证](live-validation.md)。本文件保留实现清单与交付要求。

## 1. 文件改动清单

| 位置 | 当前情况与接入动作 |
| --- | --- |
| `python/wxtext/keyscan.py`、`windows.py`、`state.py` | 复用扫描、逐库认证与 DPAPI；select 保留 database_modes 和未知字段 |
| `python/wxtext/cipher.py`、`snapshot.py`、`wal.py` | 保留离线路径，不删除 ensure_stopped，不对源库使用 immutable |
| 新 `python/weflow_backend/live.py` | 将实验能力收敛为连接、短事务、能力探测、版本检测小模块 |
| `python/weflow_backend/backend.py` | open / testConnection 分模式；移除 live 对快照的依赖；增加状态、keyset、缓存失效和恢复 |
| `python/weflow_backend/__main__.py` | stdin 入队、主线程定时调度；支持事件与 sqlcipher3 异常 |
| `python/weflow_backend/cli.py` | --mode、live prepare / verify、freshness、新错误码；最终仍输出一个 JSON |
| `electron/services/preparedLaunch.ts` | live 使用 connectionConfig；验证配置成功后保存模式 |
| `electron/services/localBackendClient.ts` | change / connection-status 订阅分流，无 id 事件不匹配 pending |
| `electron/localWcdbWorker.ts` | live setMonitor 与事件转发；继续拒绝无关 cloud 操作 |
| `electron/services/wcdbService.ts` | 状态和模式切换；复用连接队列、monitorListener；外部 DLL 行为保留 |
| `electron/services/chatService.ts` | 失效会话、联系人、表结构、消息页、计数、统计和游标，再广播 |
| `src/components/GlobalSessionMonitor.tsx`、`src/stores/chatStore.ts`、聊天页 | 按连接识别更新；同秒、修改、删除、锚点刷新；旧结果丢弃 |
| Welcome / Settings、`electron/preload.ts`、`src/types/electron.d.ts` | 原入口增加内置模式、状态和对应 IPC 类型 |
| integratedExport、现有导出 Worker、后端 exportRaw | 独立在线捕获到 spool，释放事务后复用原转换 |
| `python/requirements.txt`、`scripts/launch.ps1`、`scripts/package-backend.cjs` | 正式安装 wheel、冻结扩展和运行库、打包自检 |

模式只存 StateStore，不向 ConfigService 添加重复的持久化模式；GUI RPC 和 CLI 使用同一规范化账号目录。

## 2. 阶段一：正式 CLI 在线查询

1. 引入验证过的 sqlcipher3 正式依赖，不从实验 vendor 加载。
2. 实现 live 连接、缓存密钥认证、必需库覆盖和实际基础查询验证。
3. Backend 分离 mode 与快照元数据，live open / testConnection / connection / close 完整闭环。
4. live 有界 SQL 和 keyset 分页，所有异常分支结束 SQL 游标 / 事务；不保存跨 RPC SELECT 生成器。
5. CLI 按模式编排，live 不等待退出，保持 snapshot 的 decrypt / prepare 行为。
6. connectionConfig 和配置桥接按 mode 验证，成功后保存，失败不改变原选择。

完成标志：微信运行时正式 prepare --mode live、会话 / 消息 / 搜索可用，下一命令读到新提交；原 snapshot 回归通过。此阶段不标为 GUI 热加载完成。

## 3. 阶段二：持久监控和界面

1. 改造 serve，空闲时照样检测，SQL 主线程串行，stdout 完整 JSON。
2. 增加 connectionId、revision、状态事件和重连基线。
3. Python 缓存先失效，再经 Client / Worker / WcdbService 转发。
4. ChatService 失效完整派生状态，不能只失效统计。
5. 前端根据 live 事件刷新列表和当前页，不依赖最后时间增长；合并新增、重取修改 / 删除、保留锚点。
6. 原 Welcome / 设置中加入内置模式选择，原状态区域展示来源和恢复。

完成标志：两边持续运行时普通 / 同秒消息可见，已显示消息更新 / 删除正确，历史补入可读，无重复、串账号或滚动跳动；无 RPC 时仍发事件，延迟按规格实测。

首版 account scope 可重新生成会话列表，但不能全量预加载全部聊天和统计；有实测性能需求后再细化 session scope。

## 4. 阶段三：恢复、长任务和导出

1. 实现 busy 短等待 / 退避、文件替换、微信退出 / 重启和账号切换恢复。
2. 新必需分库缺密钥明确不完整，通过原密钥入口补齐并刷新 schema。
3. 搜索 / 统计加期限、取消与 revision 缓存；cancel 标志通过输入线程和 SQL progress handler 生效，不能被普通请求队列堵在长任务后面。
4. 现有独立导出后端按分库固定事务捕获请求行到 spool，5 秒期限，结束源事务后转换。
5. 导出记录捕获时间与 per_database 一致性，保留原格式和跨库冲突处理；超时取消不发布部分文件。
6. profile 锁、原协议与外部组件选择保持既有语义，mode 切换通过连接队列。

完成标志：重启可恢复，缺密钥清楚可操作；GUI 与导出使用独立连接并行，导出不堵 GUI；大范围超时可取消，snapshot 固定副本导出仍可显式选择。

## 5. 阶段四：安装包交付

1. requirements / 环境准备纳入验证过的 Windows x64 wheel，记录引擎和 SQLite 版本。
2. PyInstaller 显式收集 sqlcipher3 扩展及运行库；不能假设动态 import 自动收集，原离线依赖保留。
3. 冻结后端先跑合成加密连接、提交可见性和事件，再做真实账号最小查询。
4. 不提供 .venv、vendor 或系统 Python 的资源环境运行 live prepare / launch，验证 GUI 自动更新。
5. 完成一次实际安装 / 启动验收，win-unpacked 成功不能代替 NSIS 交互安装验收。
6. 检查按需连接后的内存、VirtualLock 告警、日志及退出资源释放，不改变认证来消除错误。

完成标志：安装版独立运行和热加载，退出无遗留后端、Worker 或事务；使用文档按实际实现更新。

## 6. 必要验证

| 层次 | 必要内容 |
| --- | --- |
| 合成加密库 | raw key、未提交 / 已提交、短事务、WAL checkpoint / reset、只读拒写 |
| Backend | 两种模式、同秒分页、旧游标失效、新分库缺密钥、连接关闭和现有 schema |
| RPC / Worker | 空闲事件、响应分流、EOF 清理、旧 connectionId 丢弃 |
| GUI | 新增 / 修改 / 删除、历史补入、锚点、模式切换及恢复 |
| 导出 | 捕获一致性、超时取消、无部分发布、原转换及跨库冲突 |
| 真实 / 安装 | 一次消息端到端和延迟验证、一次重启恢复、一次安装启动 |

沿用 npm run test:backend、类型检查、应用构建和桌面验证，只增加覆盖新行为的必要测试。合成数据承担边界，不反复扫描真实聊天数据。

## 7. 范围和文档更新

依次交付 CLI 数据路径、GUI 自动更新、恢复 / 导出、安装包。每阶段保留可运行 snapshot；实验脚本是诊断工具，不成为正式依赖。

首版不增加活动 WAL 自实现同步器、hook / DLL 注入、强制结束微信、云消息服务、完整媒体或防撤回写回。正常在线使用不需要结束 / 启动微信；真实恢复实验中的进程操作按用户授权次数记录。

CLI / Agent 指南、GUI / README 已更新。包内资源的独立运行与完整交互安装分别记录；只有执行过的场景才标为已验证。
