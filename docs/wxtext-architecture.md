# 架构与 Windows 适配边界

```text
cli → ExportService
          ├─ WindowsSource → KeyMatcher → StateStore (DPAPI)
           └─ snapshot → apply_wal (private encrypted copy) → PageCipher → WeChat4Adapter functions → MessageStore → publish
```

## 模块约定

| 模块 | 输入 / 输出及责任 |
| --- | --- |
| `windows.py` | Windows 进程、用户 SID、64 位进程内存读取；只接受当前会话/用户的微信进程 |
| `keyscan.py` | 可注入的 `reader.regions()/read()`；候选材料经首页 HMAC 验证后得到逐库 `DatabaseKey` |
| `cipher.py` | 原始密钥或主材料、库盐、加密页 → 经认证的 SQLite 快照 |
| `snapshot.py` | 已退出微信的 db_storage 及 WAL → 哈希一致的副本与来源清单；WAL 指纹嵌套于对应数据库的 `wal` 字段 |
| `wal.py` | 私有加密副本 → 经校验的已提交 WAL 事务重放；从不修改源文件 |
| `adapter.py` | 联系人与每个分库的真实 schema → 唯一私聊目标、规范化文字消息 |
| `exporter.py` | 目标消息流 → 磁盘排序、冲突检查、原子目录发布 |
| `state.py` | 账号路径绑定的 DPAPI 密钥缓存及非秘密设置 |
| `service.py` | 先验证覆盖范围，再处理目标；依赖可注入以在 WSL 测试 |

`DatabaseKey.secret` 是 32 字节已派生的 AES 密钥，`salt` 是 16 字节库盐。两者不进入 repr 或日志。不同数据库不能假定共用 raw key。主材料只在提取阶段进行 PBKDF2-HMAC-SHA512，256000 轮；raw key 不重复派生。缓存仅存通过验证的 raw key。

首版加密配置：4096 字节页，80 字节 reserve，AES-256-CBC，SHA512 HMAC。HMAC 覆盖密文、IV 和小端页号；首页跳过盐。每页先认证后解密，保留 SQLite reserve，最后检查完整性。明文头等其他格式未实现，不把显式盐误当作明文头模式。

## 内存适配

主路线分两次有界扫描：先找到 WCDB cipher 标识和直接存在的十六进制 raw-key 字面量，再找对标识的指针/长度引用，通过当前布局读取并解码配置缓冲区。指针、长度有界检查；每个候选均与所选账号的库页认证。跨 1 MiB 扫描块有重叠，避免漏掉边界特征。

`ConfigLayout` 集中保存配置节点偏移和混淆掩码。备用主密钥路线通过 DLL 指令地标取得混淆材料，再读取有限的配置布局候选，仅接受能派生出正确数据库页密钥的结果。不会写进程内存、注入 DLL、修改微信文件或暴力穷举密钥。

内存布局可能随微信更新变化。适配失败时拿 `doctor --json` 中的完整版本，结合本机程序结构调整 `ConfigLayout` / 主密钥策略；不能跳过 HMAC 让错误密钥进入后续流程。自动化合成内存测试只验证扫描算法，不证明当前安装版本使用相同布局。

## 数据一致性和消息语义

- 先正常退出微信；原始库从不由 SQLite 打开。非空 rollback journal 拒绝处理，存在的 WAL 随库复制；复制前后检查进程、分片及 WAL 清单、大小、mtime 和 SHA-256，源文件只读。
- `service.decrypted` 在私有加密副本上调用 `apply_wal`，验证 WAL 头部、滚动校验和、页号/提交大小及页 HMAC 后，仅重放到最后一次有效提交并按提交大小截断，再解密并检查 SQLite 完整性。同代未提交尾帧也必须认证，但不重放。
- 完整 WAL 帧头的盐与头部盐首次不匹配标记旧代边界，其后的旧代或预分配字节不解析、不认证、不重放，允许非整帧尾部。边界前的残缺数据和同代校验/认证失败均拒绝，不把活动代损坏误当作可忽略的未提交尾部。WAL 代际盐与 `DatabaseKey.salt` 的数据库加密盐不是同一概念。
- 首先验证所有需要的数据库密钥。联系人唯一匹配后，逐个消息分库检查 `Msg_<MD5(稳定 user_id)>`；不会只读第一个命中的分库。
- 每个分库单独关联 `real_sender_id → Name2Id.rowid → user_name`；不使用跨库 rowid，也不按 status 猜测发送方向。
- 自动自己 ID 仅从账号目录候选与联系人稳定 ID 的唯一匹配获得；不唯一时要求 `--self-id`。文字发送者必须属于自己或目标，否则停止。
- UTF-8 严格解码，压缩标记/帧识别后用 Zstandard 解压；没有截取“看起来像中文”的兜底。正文空格和换行保持原样。
- 有效 server ID 相同才跨来源去重；正文、发送者、时间或类型冲突时失败。没有 server ID 时按来源主键区分，重复发出的相同文字保留。
- 输出排序为时间、原始顺序、分库、local_id。JSON 消息 ID 用字符串保存，避免 JavaScript 64 位整数精度损失。仅目标消息进入临时排序库。
- 发布使用同文件系统内的新目录 rename。输出没有固定文件覆盖操作；相同导出复用前检查已有内容。失败后保留上次成功导出。

## 扩展原则

新版 schema 的变化在 adapter 中处理，内存布局变化在 keyscan 中处理，加密配置变化在 cipher 中处理。不要添加“认证失败仍解密”“只导出已解锁分片”“忽略无法解析的文字”等静默降级。

在线 WAL 合并、群聊、媒体、自动同步、手机数据库、其他 SQLCipher 格式均不属于本次实现。已实现的是停止客户端后的加密 WAL 私有副本重放，不代表广泛的微信实机兼容性。若要增加在线读取，需要另行实现一致性策略，不能以复制前后哈希检查代替在线事务快照，也不能简单按文件尾覆盖页面。

## 研发依据

以下资料仅用于理解格式和 Windows API；项目不安装或调用现有微信采集工具，也没有克隆其仓库：

- [SQLCipher 加密设计](https://www.zetetic.net/sqlcipher/design/)、[raw key API](https://www.zetetic.net/sqlcipher/sqlcipher-api/index.html)、[SQLCipher 原始源码](https://github.com/sqlcipher/sqlcipher/blob/master/src/sqlcipher.c)
- [Microsoft ReadProcessMemory](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-readprocessmemory)、[VirtualQueryEx](https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualqueryex)、[DPAPI](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [SQLite WAL 持久状态说明](https://www.sqlite.org/wal.html)
- [Windows 4.x WCDB 配置定位的公开参考实现](https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/db.py)
- [V4 消息模型的公开定义](https://pkg.go.dev/github.com/piperTang/chatlog_alpha@v0.0.0-20260225112352-82cbb0b5a807/internal/model)
- [Zstandard 帧格式](https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md)
