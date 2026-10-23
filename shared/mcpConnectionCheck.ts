import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { dirname, join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import type { McpConnectionCheck, McpLaunchConfig } from './mcpSetup'

export async function checkMcpConnection(config: McpLaunchConfig, cwd = tmpdir()): Promise<McpConnectionCheck> {
  const client = new Client({ name: 'weflow-setup-check', version: '1' })
  // Deliberately exclude the development terminal's Python, Node and WeFlow overrides.
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME']) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  env.PATH = process.platform === 'win32'
    ? [dirname(config.command), join(process.env.SystemRoot || 'C:\\Windows', 'System32'), process.env.SystemRoot || 'C:\\Windows'].join(delimiter)
    : '/usr/bin:/bin'
  Object.assign(env, config.env)
  const transport = new StdioClientTransport({ ...config, env, cwd, stderr: 'pipe' })
  transport.stderr?.on('data', () => {})
  const checks = { transport_connected: false, tools_listed: false, data_readable: false }
  const options = { timeout: 15000, signal: AbortSignal.timeout(45000) }
  try {
    await client.connect(transport, options)
    checks.transport_connected = true
    const listed = await client.listTools({}, options)
    checks.tools_listed = ['get_status', 'find_chats', 'read_conversation'].every(name => listed.tools.some(tool => tool.name === name))
    if (!checks.tools_listed) throw new Error('required tools missing')
    for (const name of ['get_status', 'find_chats']) {
      const reply = await client.callTool({ name, arguments: name === 'find_chats' ? { limit: 1 } : {} }, undefined, options)
      const data = reply.structuredContent as Record<string, any> | undefined
      if (reply.isError || data?.success !== true) {
        const error = data?.error || {}
        return { success: false, checks, error: {
          code: String(error.code || 'DATA_UNAVAILABLE'),
          message: String(error.message || '已连接 MCP，但账号数据暂不可读。').replace(/[a-f\d]{64}/gi, '[已隐藏]'),
          action: typeof error.action === 'string' ? error.action.replace(/[a-f\d]{64}/gi, '[已隐藏]') : undefined,
        } }
      }
    }
    checks.data_readable = true
    return { success: true, checks }
  } catch {
    return { success: false, checks, error: { code: 'MCP_CONNECTION_FAILED',
      message: 'MCP 启动、握手或请求失败／超时。', action: '检查运行资源和所选配置，再重试验证。' } }
  } finally {
    await client.close().catch(() => {})
    await transport.close().catch(() => {})
  }
}
