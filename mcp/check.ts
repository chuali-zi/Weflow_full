import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/** A short-lived, real stdio connection. No chat contents are printed. */
export async function checkServer(serverPath: string, args: string[]): Promise<Record<string, unknown>> {
  const client = new Client({ name: 'weflow-health-check', version: '1' })
  const transport = new StdioClientTransport({
    command: process.execPath, args: [serverPath, ...args],
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})
  const checks = { transport_connected: false, tools_listed: false, data_readable: false }
  const options = { timeout: 15000, signal: AbortSignal.timeout(45000) }
  const scope = '本次独立 stdio 检查；不代表其他 Agent 已有连接正常，也不会留下后台服务。'
  try {
    await client.connect(transport, options)
    checks.transport_connected = true
    const listed = await client.listTools({}, options)
    checks.tools_listed = listed.tools.some(tool => tool.name === 'get_status') && listed.tools.some(tool => tool.name === 'find_chats')
    if (!checks.tools_listed) throw new Error('required tools missing')
    for (const name of ['get_status', 'find_chats']) {
      const reply = await client.callTool({ name, arguments: name === 'find_chats' ? { limit: 1 } : {} }, undefined, options)
      const data = reply.structuredContent as Record<string, any> | undefined
      if (reply.isError || data?.success !== true) {
        return { success: false, checks, scope, error: data?.error || { code: 'CHECK_FAILED', action: '检查构建与客户端配置后重试。' } }
      }
    }
    checks.data_readable = true
    return { success: true, checks, scope, action: '在实际 MCP 客户端调用 get_status 确认其连接；连接已断开时，用客户端的重新连接功能恢复。' }
  } catch {
    return { success: false, checks, scope, error: {
      code: 'MCP_CONNECTION_FAILED',
      message: 'MCP 握手或检查请求失败、超时。',
      action: '检查运行环境与 build:mcp 输出，用 --print-config 更新客户端配置，再由客户端重新连接；不要在终端另开 MCP 进程代替重新连接。',
    } }
  } finally { await client.close() }
}
