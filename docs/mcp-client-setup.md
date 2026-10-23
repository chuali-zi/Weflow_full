# 图形化 MCP 接入

打开 WeFlow 的 **设置 → MCP 接入**，在 Codex 或 Claude Code 下点击 **一键接入**。程序使用当前 profile 中已准备的微信账号和读取模式。账号未准备、应用锁开启或数据不可读时，会先报告原因，不写入客户端配置。

接入完成后，在目标客户端重新加载 MCP 或新开会话，并实际调用 `get_status`。界面的“服务握手、工具可用、账号可读”来自一次独立连接验证，不代表目标客户端的已有会话已经加载。

## 配置识别与操作

- Codex 默认使用 `~/.codex/config.toml`；尊重 `CODEX_HOME`，高级设置可选择实际配置目录。
- Claude Code 默认使用用户目录下的 `.claude.json`；尊重 `CLAUDE_CONFIG_DIR`，自定义目录内使用 `.claude.json`。写入用户级 `mcpServers`，不随当前工作目录注册到某个项目。
- Codex 优先使用检测到的原生 CLI 编辑临时配置副本，核对解析结果后才替换正式文件。没有 CLI 时按 TOML 格式写入；此时以及移除配置时可能规范化格式和注释，原文件保存在本机备份中，其他设置的语义保持不变。
- Claude Code 使用 JSON 解析、合并与原子替换，保留其他服务和设置。
- 高级设置中的配置目录适用于用户自己使用的配置环境；WSL、远程客户端及包装脚本的自定义环境不会自动继承 Windows 用户配置。

已有同一连接会复用；名称被其他安装占用时，自动选择 `weflow-local`、`weflow-local-2` 等未占用名称。重复接入不会不断新增相同条目。已经保存的客户端禁用状态和工具筛选设置会保留并提示；客户端的项目级覆盖、企业策略和权限仍以实际客户端为准。

**验证**和**移除接入**只操作当前 WeFlow 接入记录中、且内容未被外部修改的条目。外部修改的条目会保留，重新接入时生成独立名称。移除不删除 WeFlow 程序、微信数据、profile 或密钥缓存。

## 运行环境与恢复

GUI 与 `weflow-mcp.cmd --print-config` 共享启动配置生成器。安装版使用包内 Electron 和冻结后端；源码版固定项目 Python。配置内固定绝对路径、profile、账号数据目录和读取模式，清除影响启动的 Node/Python 环境覆盖。独立检查使用精简 PATH 和非项目工作目录。

客户端配置在写入前备份到当前 profile 的 `mcp-client-setup/backups/`；这些备份可能包含客户端原有的私密设置，应留在本机。`registrations.json` 记录本功能管理的条目。修改使用同目录临时文件和原子替换，并在替换前检查原文件是否被其他进程修改。配置目录链接会解析到真实目标，保留原链接。

文件锁防止多个接入操作同时写同一配置。进程中断后，下一次操作可以回收已退出进程留下的锁；存活进程的锁会报告忙碌。配置或接入记录损坏时保留原文件，不自动重置。

如果配置已保存、随后数据检查失败，界面会明确区分这两步，保留有效注册以便重试。升级或移动安装后，可以在新的 WeFlow 中点击“修复 / 重新接入”更新本功能管理的旧路径。

## 验证

```powershell
npm run test:mcp
npm run check:mcp-setup
npm run build:app
npm run check:mcp-setup-ui
```

`test:mcp` 包含接入回归；真实客户端验收由 `check:mcp-setup` 单独开启，需要本机有 Codex 和 Claude Code 原生 CLI。它只使用临时客户端配置目录、合成微信账号，验证 Codex 回读、Claude Code 连接、配置保留、重复接入、修复和移除，不修改日常客户端配置。

`check:mcp-setup-ui` 通过真实 Electron 主进程、preload 和设置页执行接入、验证与移除，截图保存在 `.runtime/mu/<fixture>/`。若要检查已有完整安装目录的冻结后端：

```powershell
$env:WEFLOW_SETUP_PACKAGE = '完整路径\win-unpacked'
npm run check:mcp-setup
```

当前自动覆盖特殊字符／中文／空格路径、超过 260 字符的客户端配置路径、配置目录 junction、自定义配置目录、UTF-8 BOM、同名冲突、无 CLI、损坏配置、只读配置、外部修改、重复点击、失效进程锁、损坏接入记录，以及被污染的 Node/Python 父进程环境。

这不等于所有 Windows 机器均已验收。干净虚拟机、不同 Windows 用户、企业策略、杀毒软件干预、系统重启和完整交互安装仍需实机验收。现有 Python snapshot 准备流程在某些深层路径上仍可能触及 Windows 长路径限制；客户端配置长路径通过不代表 snapshot 路径同样不受限制。

客户端格式参考：[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)。
