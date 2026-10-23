import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FolderOpen, Loader2, Plug, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import type { McpClientId, McpClientTarget, McpSetupResult } from '../../shared/mcpSetup'
import './McpSetupPanel.scss'

function ClientSetup({ client, label }: { client: McpClientId; label: string }) {
  const [configDir, setConfigDir] = useState('')
  const [cliPath, setCliPath] = useState('')
  const [result, setResult] = useState<McpSetupResult>()
  const [busy, setBusy] = useState('')
  const sequence = useRef(0)
  const target = (): McpClientTarget => ({ client, configDir: configDir.trim() || undefined, cliPath: cliPath.trim() || undefined })
  const run = async (operation: 'inspect' | 'install' | 'check' | 'remove', name?: string, selectedTarget = target()) => {
    const current = ++sequence.current
    setBusy(operation)
    try {
      const api = window.electronAPI.mcpSetup
      const reply = operation === 'check' || operation === 'remove'
        ? await api[operation](selectedTarget, name!) : await api[operation](selectedTarget)
      if (current === sequence.current) setResult(reply)
    } catch {
      if (current === sequence.current) setResult({ success: false, error: '接入操作未完成，请重试。' })
    } finally { if (current === sequence.current) setBusy('') }
  }
  useEffect(() => {
    void run('inspect')
    return () => { sequence.current++ }
  }, [])
  const edit = (setter: (value: string) => void, value: string) => {
    setter(value)
    sequence.current++
    setResult(undefined)
    setBusy('')
  }
  const browse = async (kind: 'config' | 'cli') => {
    const picked = kind === 'config'
      ? await window.electronAPI.dialog.openDirectory({ title: `选择 ${label} 配置目录` })
      : await window.electronAPI.dialog.openFile({ title: `选择 ${label} 原生程序`, filters: [{ name: '客户端程序', extensions: ['exe'] }] })
    if (picked.canceled || !picked.filePaths[0]) return
    const value = picked.filePaths[0]
    if (kind === 'config') setConfigDir(value)
    else setCliPath(value)
    await run('inspect', undefined, { ...target(), ...(kind === 'config' ? { configDir: value } : { cliPath: value }) })
  }
  const inspection = result?.inspection
  return (
    <section className="mcp-client" aria-label={`${label} MCP 接入`}>
      <div className="mcp-client__heading">
        <div className="mcp-client__identity"><span className="mcp-client__icon"><Terminal size={21} /></span><div><h3>{label}</h3><span>本机 MCP 接入</span></div></div>
        <button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void run('install')}>
          {busy === 'install' ? <Loader2 size={15} className="mcp-spinning" /> : <Plug size={15} />}
          {busy === 'install' ? '接入并验证中…' : inspection?.registrations.some(item => item.managed) ? '修复 / 重新接入' : '一键接入'}
        </button>
      </div>
      {busy === 'inspect' && <p className="mcp-muted" role="status">正在检查客户端与当前账号…</p>}
      {inspection && <dl className="mcp-client__details">
        <div><dt>微信账号</dt><dd>{inspection.account || '已准备账号'} · {inspection.mode === 'live' ? '实时读取' : '离线快照'}</dd></div>
        <div><dt>WeFlow 配置</dt><dd title={inspection.profile}>{inspection.profile}</dd></div>
        <div><dt>客户端配置</dt><dd title={inspection.configFile}>{inspection.configFile}</dd></div>
      </dl>}
      {result && (result.check || result.error || result.changed) && <div className={`mcp-result ${result.success ? 'mcp-result--ok' : 'mcp-result--error'}`} role="status" aria-live="polite">
        <strong>{result.success ? result.check ? 'MCP 数据读取验证通过' : '接入配置已移除' : result.name ? '配置已保存，读取验证尚未通过' : '接入尚未完成'}</strong>
        {result.error && <p>{result.error}</p>}
        {result.action && <p>{result.action}</p>}
        {result.check && <div className="mcp-checks">
          <span>{result.check.checks.transport_connected ? '✓' : '○'} 服务握手</span>
          <span>{result.check.checks.tools_listed ? '✓' : '○'} 工具可用</span>
          <span>{result.check.checks.data_readable ? '✓' : '○'} 账号可读</span>
        </div>}
        {result.reloadRequired && <p>请在 {label} 中重新加载 MCP 或新开会话，确认服务已加载。</p>}
        {result.notices?.filter(note => !note.startsWith('独立连接')).map(note => <p key={note}>{note}</p>)}
        {result.backup && <small>修改前的配置已在本机备份。</small>}
      </div>}
      {inspection?.registrations.map(item => <div className="mcp-registration" key={item.name}>
        <div><CheckCircle2 size={15} /><code>{item.name}</code><span>{item.managed ? item.enabled ? '已配置' : '客户端已禁用' : '已有配置，保留'}{item.current ? ' · 当前账号与模式' : ''}</span></div>
        {item.managed && <div className="mcp-registration__actions">
          <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void run('check', item.name)}><RefreshCw size={13} />验证</button>
          <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void run('remove', item.name)}><Trash2 size={13} />移除接入</button>
        </div>}
      </div>)}
      <details className="mcp-advanced">
        <summary>高级设置</summary>
        <label>客户端配置目录<span className="mcp-muted">留空时自动识别。Claude Code 默认文件为用户目录下的 .claude.json。</span>
          <div className="mcp-path-input"><input className="field-input" value={configDir} disabled={Boolean(busy)} onChange={event => edit(setConfigDir, event.target.value)} placeholder="自动识别配置目录" /><button className="btn btn-secondary" disabled={Boolean(busy)} aria-label={`选择 ${label} 配置目录`} onClick={() => void browse('config')}><FolderOpen size={16} /></button></div>
        </label>
        {client === 'codex' && <label>客户端原生程序<span className="mcp-muted">优先使用检测到的程序编辑配置副本；没有 CLI 时按客户端格式写入。</span>
          <div className="mcp-path-input"><input className="field-input" value={cliPath} disabled={Boolean(busy)} onChange={event => edit(setCliPath, event.target.value)} placeholder={inspection?.cliPath || '自动识别 Codex 程序'} /><button className="btn btn-secondary" disabled={Boolean(busy)} aria-label="选择 Codex 程序" onClick={() => void browse('cli')}><FolderOpen size={16} /></button></div>
        </label>}
        <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void run('inspect')}><RefreshCw size={14} />重新检测</button>
      </details>
    </section>
  )
}

export default function McpSetupPanel() {
  return <div className="settings-section mcp-setup">
    <div className="mcp-setup__intro"><span className="mcp-setup__eyebrow">WEFLOW × MCP</span><h2>把微信记录接入你的 AI</h2><p>选择本机客户端，自动配置并验证聊天记录读取。使用当前 WeFlow 的账号和读取模式。</p></div>
    <ClientSetup client="codex" label="Codex" />
    <ClientSetup client="claude" label="Claude Code" />
    <p className="mcp-muted mcp-setup__footnote">适用于 Windows 本机客户端。WSL、远程主机和自定义启动器需要在实际运行客户端的环境中单独配置。</p>
  </div>
}
