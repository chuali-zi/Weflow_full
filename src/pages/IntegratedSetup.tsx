import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, CheckCircle2, FolderOpen, LoaderCircle, RefreshCw, X, Minus } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { dialog } from '../services/ipc'
import './IntegratedSetup.scss'

type Account = { dataDir: string; accountId: string; directoryName: string; capturedAt?: string }
export default function IntegratedSetup({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate()
  const setDbConnected = useAppStore((state) => state.setDbConnected)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [dataDir, setDataDir] = useState('')
  const [phase, setPhase] = useState<'select' | 'exit' | 'ready'>('select')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [capturedAt, setCapturedAt] = useState('')

  const discover = async () => {
    try {
      const result = await window.electronAPI.integrated.discover()
      if (!result.success) { setError(result.error || '无法发现账号目录'); return }
      setAccounts(result.accounts || [])
      if (result.accounts?.length === 1) setDataDir(result.accounts[0].dataDir)
    } catch (error) { setError(String(error)) }
  }
  useEffect(() => {
    void discover()
    return window.electronAPI.integrated.onProgress(setProgress)
  }, [])
  useEffect(() => {
    setPhase('select')
    setError('')
    setCapturedAt('')
    if (!dataDir) return
    let current = true
    window.electronAPI.integrated.status(dataDir).then((result) => {
      if (current && result.ready) setCapturedAt(result.capturedAt || '')
    }).catch(() => {})
    return () => { current = false }
  }, [dataDir])

  const finish = async () => {
    const connection = await window.electronAPI.chat.connect()
    if (!connection.success) throw new Error(connection.error || '无法打开聊天记录')
    setDbConnected(true)
    if (standalone) await window.electronAPI.window.completeOnboarding()
    else navigate('/chat')
  }
  const run = async (action: 'keys' | 'snapshot' | 'reuse') => {
    setBusy(true)
    setError('')
    setProgress(action === 'keys' ? '正在检查密钥缓存…' : '正在打开聊天记录…')
    try {
      const api = window.electronAPI.integrated
      const result = action === 'keys' ? await api.prepareKeys(dataDir)
        : action === 'snapshot' ? await api.prepareSnapshot(dataDir) : await api.activate(dataDir)
      if (!result.success) {
        setError([result.error, result.action].filter(Boolean).join(' '))
        return
      }
      if (action === 'keys') {
        setPhase('exit')
        setProgress('密钥已准备好。现在请从微信托盘菜单正常退出微信。')
      } else {
        setPhase('ready')
        await finish()
      }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const browse = async () => {
    const selected = await dialog.openFile({ title: '选择微信账号目录或 db_storage', properties: ['openDirectory'] })
    if (!selected.canceled && selected.filePaths[0]) setDataDir(selected.filePaths[0])
  }
  return <main className={`integrated-setup ${standalone ? 'standalone' : ''}`}>
    {standalone && <div className="setup-window-bar"><span>WeFlow · 本地整合版</span><div>
      <button aria-label="最小化" onClick={() => window.electronAPI.window.minimize()}><Minus size={16} /></button>
      <button aria-label="关闭" onClick={() => window.electronAPI.window.close()}><X size={16} /></button>
    </div></div>}
    <div className="setup-layout">
      <aside className="setup-intro">
        <span className="setup-wordmark">weflow<span> / local</span></span>
        <h1>你的聊天记录，<br />回到你的手里。</h1>
        <p>解密与查询已内置。选择自己的账号，准备一次记录副本，就可以查看、搜索和导出。</p>
        <ol className="setup-steps">
          <li className={phase !== 'select' ? 'done' : 'current'}><span>01</span>登录微信，获取密钥</li>
          <li className={phase === 'exit' ? 'current' : phase === 'ready' ? 'done' : ''}><span>02</span>正常退出，准备记录</li>
          <li className={phase === 'ready' ? 'done' : ''}><span>03</span>打开 WeFlow，开始查看</li>
        </ol>
        <small>记录副本保存在本机。准备完成后可以重新打开微信。<br />查看的是准备时的记录；需要新消息时，在这里更新。</small>
      </aside>
      <section className="setup-form" aria-label="准备聊天记录">
        <div className="setup-form-heading"><span>{phase === 'exit' ? '第二步' : '开始准备'}</span>
          <h2>{phase === 'exit' ? '退出微信，然后继续' : '选择微信账号'}</h2></div>
        <label htmlFor="setup-account">检测到的账号</label>
        <div className="setup-account-row">
          <select id="setup-account" value={accounts.some((a) => a.dataDir === dataDir) ? dataDir : ''}
            disabled={busy} onChange={(event) => setDataDir(event.target.value)}>
            <option value="">{accounts.length ? '请选择账号' : '未自动发现账号，请选择目录'}</option>
            {accounts.map((account) => <option key={account.dataDir} value={account.dataDir}>{account.accountId}</option>)}
          </select>
          <button className="setup-icon-button" disabled={busy} onClick={() => void discover()} aria-label="重新检测账号"><RefreshCw size={17} /></button>
        </div>
        <label htmlFor="setup-path">数据目录</label>
        <div className="setup-account-row">
          <input id="setup-path" value={dataDir} disabled={busy} onChange={(event) => setDataDir(event.target.value)} placeholder="选择账号目录或 db_storage" />
          <button className="setup-icon-button" disabled={busy} onClick={() => void browse()} aria-label="选择数据目录"><FolderOpen size={18} /></button>
        </div>
        {capturedAt && <div className="setup-existing"><CheckCircle2 size={18} /><div>已有记录副本<small>{new Date(capturedAt).toLocaleString()}</small></div>
          <button disabled={busy} onClick={() => void run('reuse')}>直接打开 <ArrowRight size={15} /></button></div>}
        <div className="setup-guidance">{phase === 'exit'
          ? '请右键点击系统托盘中的微信图标，选择“退出微信”。只关闭聊天窗口不会退出微信。'
          : '请先登录电脑微信。首次获取时，可以先打开常用聊天和历史记录，帮助工具找到所需密钥。'}</div>
        <button className="setup-primary" disabled={busy || !dataDir.trim()} onClick={() => void run(phase === 'exit' ? 'snapshot' : 'keys')}>
          {busy ? <LoaderCircle size={19} className="setup-spinner" /> : <ArrowRight size={19} />}
          {busy ? '正在处理…' : phase === 'exit' ? '微信已退出，准备记录并打开' : capturedAt ? '更新聊天记录' : '获取密钥，继续准备'}
        </button>
        <p className="setup-progress" role="status" aria-live="polite">{progress}</p>
        {error && <p className="setup-error" role="alert">{error}</p>}
      </section>
    </div>
  </main>
}
