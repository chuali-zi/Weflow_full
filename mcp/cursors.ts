import { randomBytes } from 'node:crypto'

type Entry<S> = { queryId: string; version: string; state: S; touched: number }
type Query = { tokens: Set<string>; pageTokens: Set<string>; touched: number; bytes: number }

/** Short-lived, opaque continuation state. A consumed token replays its original page. */
export class CursorStore {
  private readonly entries = new Map<string, Entry<unknown>>()
  private readonly pages = new Map<string, { value: unknown; next: string | null; queryId: string; version: string; touched: number }>()
  private readonly queries = new Map<string, Query>()
  private readonly staleTokens = new Map<string, number>()
  constructor(private readonly ttlMs = 10 * 60_000, private readonly maxTokens = 128, private readonly maxQueries = 32, private readonly maxBytes = 16 * 1024 * 1024) {}

  start<S>(state: S, version: string): string {
    this.prune()
    while (this.queries.size >= this.maxQueries) this.evictOldest()
    const bytes = sizeOf(state)
    if (bytes > this.maxBytes) throw cursorError('RESOURCE_LIMIT', '此查询的待处理内容超过 16 MiB，请缩小范围。')
    this.ensureBytes(bytes)
    return this.add(state, version, randomBytes(18).toString('base64url'))
  }

  async advance<S, R>(token: string, version: string, work: (state: S) => Promise<{ value: R; state: S; hasMore: boolean }>): Promise<{ value: R; next: string | null }> {
    this.prune()
    if (this.staleTokens.has(token)) throw cursorError('CURSOR_STALE', '数据版本已变化，请重读原范围。')
    const replay = this.pages.get(token)
    if (replay) {
      if (replay.touched + this.ttlMs <= Date.now()) throw cursorError('CURSOR_EXPIRED', '查询游标已过期。')
      if (replay.version !== version) throw cursorError('CURSOR_STALE', '数据版本已变化，请重读原范围。')
      replay.touched = Date.now()
      return { value: replay.value as R, next: replay.next }
    }
    const entry = this.entries.get(token) as Entry<S> | undefined
    if (!entry) throw cursorError('CURSOR_EXPIRED', '查询游标不存在或已过期。')
    if (entry.version !== version) { this.dropQuery(entry.queryId); throw cursorError('CURSOR_STALE', '数据版本已变化，请重读原范围。') }
    const now = Date.now(); entry.touched = now
    const result = await work(structuredClone(entry.state))
    this.ensurePageBytes(entry, result.state, result.value)
    const query = this.queries.get(entry.queryId)
    if (!query) throw cursorError('CURSOR_EXPIRED', '查询游标已回收。')
    query.touched = now
    let next: string | null = null
    if (result.hasMore) {
      while (this.entries.size + this.pages.size >= this.maxTokens) {
        const victim = [...this.queries.entries()].filter(([id]) => id !== entry.queryId).sort((a, b) => a[1].touched - b[1].touched)[0]
        if (victim) { this.dropQuery(victim[0]); continue }
        this.dropQuery(entry.queryId)
        throw cursorError('CURSOR_LIMIT', '此查询游标已达到内存页数上限，请缩小范围后重开。')
      }
      next = randomBytes(18).toString('base64url')
      this.add(result.state, version, next, entry.queryId)
    }
    const value = result.value
    this.pages.set(token, { value, next, queryId: entry.queryId, version, touched: now })
    this.queries.get(entry.queryId)?.pageTokens.add(token)
    this.entries.delete(token); query.tokens.delete(token)
    return { value, next }
  }

  setState<S>(token: string, state: S): void {
    const entry = this.entries.get(token)
    if (entry) entry.state = state
  }

  clear(): void { this.entries.clear(); this.pages.clear(); this.queries.clear(); this.staleTokens.clear() }
  invalidate(): void {
    const now = Date.now()
    for (const token of [...this.entries.keys(), ...this.pages.keys()]) this.staleTokens.set(token, now)
    while (this.staleTokens.size > this.maxTokens) this.staleTokens.delete(this.staleTokens.keys().next().value!)
    this.entries.clear(); this.pages.clear(); this.queries.clear()
  }

  private add<S>(state: S, version: string, token: string, queryId?: string): string {
    while (this.entries.size + this.pages.size >= this.maxTokens) this.evictOldest()
    const id = queryId ?? randomBytes(12).toString('base64url')
    let q = this.queries.get(id)
    if (!q) { q = { tokens: new Set(), pageTokens: new Set(), touched: Date.now(), bytes: 0 }; this.queries.set(id, q) }
    q.tokens.add(token); q.touched = Date.now()
    this.entries.set(token, { queryId: id, version, state: structuredClone(state), touched: Date.now() })
    return token
  }
  private prune(): void {
    const cutoff = Date.now() - this.ttlMs
    for (const [token, touched] of this.staleTokens) if (touched < cutoff) this.staleTokens.delete(token)
    for (const [id, q] of this.queries) if (q.touched < cutoff) this.dropQuery(id)
    for (const [token, page] of this.pages) if (page.touched < cutoff) { this.pages.delete(token); this.queries.get(page.queryId)?.pageTokens.delete(token) }
  }
  private evictOldest(): void {
    const oldest = [...this.queries.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
    if (oldest) this.dropQuery(oldest[0])
  }
  private dropQuery(id: string): void {
    const q = this.queries.get(id); if (!q) return
    for (const token of q.tokens) this.entries.delete(token)
    for (const token of q.pageTokens) this.pages.delete(token)
    this.queries.delete(id)
  }
  private totalBytes(): number {
    let total = 0
    for (const entry of this.entries.values()) total += sizeOf(entry.state)
    for (const page of this.pages.values()) total += sizeOf(page.value)
    return total
  }
  private ensureBytes(additional: number): void {
    while (this.totalBytes() + additional > this.maxBytes) {
      if (!this.queries.size) throw cursorError('RESOURCE_LIMIT', '查询游标缓存超过 16 MiB。')
      this.evictOldest()
    }
  }
  private ensurePageBytes<S, R>(entry: Entry<S>, state: S, value: R): void {
    const current = sizeOf(entry.state)
    const projected = () => this.totalBytes() - current + sizeOf(state) + sizeOf(value)
    while (projected() > this.maxBytes) {
      const victim = [...this.queries.entries()].filter(([id]) => id !== entry.queryId).sort((a, b) => a[1].touched - b[1].touched)[0]
      if (!victim) { this.dropQuery(entry.queryId); throw cursorError('RESOURCE_LIMIT', '此查询的缓存超过 16 MiB，请缩小范围。') }
      this.dropQuery(victim[0])
    }
  }
}

function sizeOf(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return Number.MAX_SAFE_INTEGER }
}

function cursorError(code: string, message: string): Error & { code: string; retryable: boolean; action: string } {
  return Object.assign(new Error(message), { code, retryable: code !== 'CURSOR_STALE', action: '重新打开原查询范围。' })
}
