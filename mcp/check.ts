import { checkMcpConnection } from '../shared/mcpConnectionCheck'
import type { McpLaunchConfig } from '../shared/mcpSetup'

/** A short-lived, real stdio connection. No chat contents are printed. */
export async function checkServer(config: McpLaunchConfig): Promise<Record<string, unknown>> {
  const result = await checkMcpConnection(config)
  return { ...result,
    scope: '本次独立 stdio 检查；不代表其他 Agent 已有连接正常，也不会留下后台服务。',
    ...(result.success ? { action: '在实际 MCP 客户端调用 get_status 确认其连接；连接已断开时，用客户端的重新连接功能恢复。' } : {}) }
}
