# 本地整合版接入说明

本目录基于 WeFlow 5.0.0（上游提交 `837697b`）加入原 wxtext 工具。主界面和聊天解析、导出格式沿用 WeFlow，数据库解密和查询由仓库内的 Python 后端提供。

## 调用路径

```text
准备页面 → Electron IPC → Python 后端 → 当前用户微信进程中的密钥
                                       → 复制、WAL 合并、逐页认证、解密
聊天界面 → 原 wcdbService → 新 wcdbWorker → 只读 SQLite 副本
导出界面 → 原 exportWorker → 内置原始 JSONL 导出 → 原格式转换器
```

`LocalBackendClient` 通过子进程标准输入输出传输 JSON，无需安装服务或开放端口。源码模式调用项目内 Python；安装包调用 `resources/backend/weflow-backend.exe`，无需用户安装 Python。

## 当前接入范围

- Windows x64、微信 4.x 和 wxtext 已支持的 SQLCipher 4 / 4096 字节页格式。
- 按数据库分别验证密钥，Windows DPAPI 缓存。
- 联系人、会话重建、消息分库合并、发送者映射、Zstandard 内容、分页、搜索。
- 总数、类型、日期、发送接收统计及群聊发言统计。
- 内置导出后端输出原始 JSONL，交给 WeFlow 的 TXT / HTML / CSV / JSON 等转换器。
- 获取到有效密钥的其他数据库也可进入副本；存在副本的数据库可通过只读 SQL 查询。

本次整合并不等于所有原生 DLL 接口已经复刻：图片 AES 密钥自动获取、完整群成员名单、朋友圈专用查询、部分高级报表、实时监听和数据库写操作尚未完整接入。原有图片解码回退和手动图片密钥设置保留，但媒体附件恢复需要另外验证。

## 文件与状态

- `python/wxtext/`：原工具的密钥扫描、认证解密、WAL、快照、DPAPI 模块。
- `python/weflow_backend/`：WeFlow 查询与导出适配。
- `electron/localWcdbWorker.ts`：保留上游 Worker 消息协议，替换缺失的原生 DLL。
- `electron/services/integratedService.ts`：准备流程和账号配置。
- `scripts/launch.ps1`：首次安装环境、缓存构建、启动。

运行状态独立保存在 `%APPDATA%\WeFlow-full\backend`。密钥缓存由 DPAPI 保护；聊天副本是明文 SQLite，保存在当前用户的应用数据目录。新副本全部认证完成后才切换 `active.json`；准备失败保留旧副本。当前会保留旧副本目录，频繁更新大账号时应留意磁盘空间。

## 验证

`npm run test:backend` 使用合成数据库验证分库、分页、发送者、长文本、搜索、只读查询、导出，以及加密准备和失败恢复。加密测试使用独立 AES/HMAC 编码生成的配置样本，不代表已完成真实微信版本兼容性验证。

`npm run check:desktop` 启动隐藏 Electron 窗口，验证实际 IPC、数据库 Worker 和 TXT / HTML / CSV / JSON 导出。
打包后可运行 `npm run check:desktop -- --packaged`，从安装包的 `app.asar` 加载应用并使用包内独立后端，关闭源码 Python 路径，检查安装包资源接入。

发布前仍需在目标 Windows / 微信版本上走一次真实账号准备与导出流程。不要根据合成测试宣称所有微信版本、媒体附件和上游高级功能均已通过验证。
