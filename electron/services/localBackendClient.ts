import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { createInterface } from 'readline'

export type LocalBackendEvent = {
  type: 'change' | 'connection-status' | string
  payload?: unknown
}

/** The bundled Python backend. Every worker uses this same small transport. */
export class LocalBackendClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private sequence = 0
  private pending = new Map<number, {
    resolve: (value: any) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
    progress?: (message: string) => void
  }>()
  private eventListeners = new Set<(event: LocalBackendEvent) => void>()
  constructor(private stateDir: string, private resourcesPath = '') {}

  onEvent(listener: (event: LocalBackendEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }
  private start(): void {
    if (this.child) return
    const resources = this.resourcesPath || (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || ''
    const candidates = [process.env.WEFLOW_BACKEND_ROOT, join(resources, 'python'),
      resolve(__dirname, '../python'), resolve(__dirname, '../../python'), join(process.cwd(), 'python')]
    const backendRoot = candidates.find((candidate) => candidate && existsSync(join(candidate, 'weflow_backend', '__main__.py')))
    // Upstream callers pass resources/resources; our backend is resources/backend.
    const bundled = [join(resources, 'backend', 'weflow-backend.exe'),
      join(resources, '../backend', 'weflow-backend.exe'),
      join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || resources, 'backend', 'weflow-backend.exe')]
      .find((candidate) => existsSync(candidate))
    const frozen = Boolean(bundled)
    const pythonCandidates = [process.env.WEFLOW_PYTHON,
      backendRoot && join(backendRoot, '../.venv/Scripts/python.exe'),
      backendRoot && join(backendRoot, '../.runtime/python/python.exe'),
      backendRoot && join(backendRoot, '../.venv/bin/python')]
    const interpreter = pythonCandidates.find((candidate) => candidate && existsSync(candidate))
    if (!frozen && (!backendRoot || !interpreter)) {
      throw new Error('内置后端尚未安装。请使用项目根目录的“启动 WeFlow.cmd”启动。')
    }
    const child = spawn(frozen ? bundled! : interpreter!, frozen
      ? ['--state-dir', this.stateDir]
      : ['-u', '-m', 'weflow_backend', '--state-dir', this.stateDir], {
      cwd: backendRoot || resources,
      env: { ...process.env, PYTHONPATH: backendRoot, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let event: any
      try { event = JSON.parse(line) } catch { return }
      if (event && event.type !== 'progress' && typeof event.type === 'string' && event.id === undefined) {
        for (const listener of this.eventListeners) {
          try { listener(event) } catch { /* event consumers must not break transport */ }
        }
        return
      }
      if (event.type === 'progress') {
        for (const entry of this.pending.values()) entry.progress?.(String(event.message || ''))
        return
      }
      const entry = this.pending.get(event.id)
      if (!entry) return
      this.pending.delete(event.id)
      clearTimeout(entry.timer)
      entry.resolve(event.result)
    })
    child.stderr.resume()
    const fail = (error: Error) => {
      if (this.child !== child) { lines.close(); return }
      this.child = null
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(error)
      }
      this.pending.clear()
      lines.close()
    }
    child.on('error', fail)
    child.on('exit', (code) => fail(new Error(`内置后端已退出（${code ?? '中断'}），请重新打开记录。`)))
    child.stdin.on('error', () => {})
  }
  call<T = any>(method: string, payload: Record<string, any> = {}, progress?: (message: string) => void, requestId?: number): Promise<T> {
    try { this.start() } catch (error) { return Promise.reject(error) }
    return new Promise<T>((resolvePromise, reject) => {
      const id = requestId ?? ++this.sequence
      if (id > this.sequence) this.sequence = id
      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.reject(new Error('记录处理超时，请重新尝试。'))
        this.dispose()
      }, 30 * 60_000)
      this.pending.set(id, { resolve: resolvePromise, reject, timer, progress })
      this.child!.stdin.write(`${JSON.stringify({ id, method, payload })}\n`)
    })
  }

  /** Cancellation is deliberately written directly to stdin so it can interrupt a long RPC. */
  cancel(requestId: number | string): boolean {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false
    try {
      stdin.write(`${JSON.stringify({ id: null, method: 'cancel', payload: { requestId } })}\n`)
      return true
    } catch {
      return false
    }
  }
  dispose(): void {
    const child = this.child
    this.child = null
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('记录处理已停止。'))
    }
    this.pending.clear()
    if (child) {
      child.stdin.end()
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill() }, 2000)
      timer.unref()
    }
  }

  /** End the JSON-RPC stream and wait for the backend to exit without killing it. */
  async closeGracefully(): Promise<void> {
    const child = this.child
    if (!child) return
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) return

    await new Promise<void>((resolvePromise) => {
      const done = () => resolvePromise()
      child.once('exit', done)
      child.once('close', done)
      // Cover exit between the initial state check and listener registration.
      if (child.exitCode !== null || child.signalCode !== null) done()
    })
  }
}
