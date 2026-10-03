# 微信运行中的数据库读取实验

2026-10-03，在 Windows 微信 4.1.13.65 上完成。实验入口为 `scripts/probe-live-db.py`，尚未改变 WeFlow 正式后端的离线副本模式。

本实验已落实为 [新架构](live-architecture.md)、[接入规格](live-spec.md) 和 [完整实施方案](live-integration-plan.md)。下面仅记录实验事实；新增正式接口仍以规格的待实现状态为准。

## 结果

- 微信始终运行；结束微信 0 次，启动微信 0 次。
- 复用现有 DPAPI 缓存中已认证的逐库密钥，没有重新扫描内存。
- SQLCipher 4.12.0 community / SQLite 3.51.1 通过 `mode=ro` 打开全部 21 个源数据库，并查询其 schema；全部报告 WAL 模式。
- 同一组连接持续观测 180 秒，完成 68 次采样、检测到 20 次消息分库变化，查询错误为 0。
- 两个消息分库中 `Msg_<32位十六进制摘要>` 表的总行数由 295,322 增至 295,330，增加 8 行。这是原始表行数，不是去重后或按消息类型筛选后的消息总数。
- 将在线 SQLCipher 连接注入现有 `Backend` 的实验对象后，现有会话查询返回 411 个会话，消息查询成功解析 5 条记录。没有把聊天正文或密钥写入实验日志。
- 合成加密 WAL 库验证通过：未提交记录不可见；提交后同一只读连接可见；读事务内视图稳定，下一事务可见新提交；WAL checkpoint 和复用后继续可读；只读连接拒绝写入。

真实实验确认了在线读取和新提交可见性。它没有验证全部媒体、FTS、所有微信版本、微信重启恢复、新分库发现或 GUI 自动刷新。读取不同数据库的事务也不构成跨库全局原子快照。

## 关键区别

实验使用兼容的数据库引擎直接读取加密源库，每个连接设置逐库 raw key 和数据库盐，启用 SQLCipher 4 参数、只读打开和 `query_only`。查询时由引擎解析、认证、解密所需数据库页，并处理 WAL 与 SQLite 读事务。

原有路径则先在微信退出后复制加密文件、离线重放 WAL、整库解密，再通过普通 SQLite 查询固定副本。两种路径复用密钥与消息解析能力，但获得一致数据视图的方式不同。

实验没有在源库上执行数据写入、rekey、VACUUM 或 checkpoint。普通在线读连接会参加 SQLite 的锁/WAL 协调，不能将它描述为不接触共享内存状态的普通文件读取。合成库中的 checkpoint 仅作用于实验临时数据库。

## 重复实验

依赖独立安装在 Git 忽略的 `.runtime/hotload/vendor`，没有修改正式运行依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install --only-binary=:all: --target .runtime/hotload/vendor sqlcipher3==0.6.2
.\.venv\Scripts\python.exe scripts/probe-live-db.py --data-dir "D:\你的微信目录\账号目录\db_storage" --watch 180 --interval 2 --backend-check
```

默认使用 `%APPDATA%\WeFlow-full\backend` 中已有密钥；其他配置目录使用 `--state-dir` 指定。没有缓存时，先通过现有 `weflow.cmd keys` 获取密钥。观测阶段只输出库名、状态、数量和耗时，不输出消息正文。

本次本地日志：`.runtime/hotload/live-watch.jsonl`、`.runtime/hotload/backend-check.jsonl`。引擎在查询期间出现过 Windows `VirtualLock` 配额告警；解密和查询成功，正式接入时应评估连接数量、资源占用与日志输出。

## GUI 接入所需工作

1. 为正式后端加入在线连接模式，复用已验证的逐库密钥和现有消息适配。
2. 通过 `PRAGMA data_version` 或文件通知触发重新查询；避免持续全表计数。数据版本变化仅表明数据库提交发生变化，具体会话和消息变化仍需查询确认。
3. 在变化后失效相应会话、统计和游标缓存，并向现有 `wcdb-change` 通知链路发布界面可识别的事件。
4. 检查同秒消息、旧记录更新、撤回、新分库和微信重启等行为；当前前端只依赖最后消息时间增长的部分逻辑需要补齐。

参考：[sqlcipher3](https://github.com/coleifer/sqlcipher3)、[SQLCipher API](https://www.zetetic.net/sqlcipher/sqlcipher-api/)、[SQLite WAL](https://www.sqlite.org/wal.html)。
