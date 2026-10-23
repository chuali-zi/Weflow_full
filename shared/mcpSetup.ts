export type McpClientId = 'codex' | 'claude'
export type McpClientTarget = { client: McpClientId; configDir?: string; cliPath?: string }
export type McpLaunchConfig = { command: string; args: string[]; env: Record<string, string> }
export type McpConnectionCheck = {
  success: boolean
  checks: { transport_connected: boolean; tools_listed: boolean; data_readable: boolean }
  error?: { code: string; message: string; action?: string }
}
export type McpRegistration = { name: string; managed: boolean; enabled: boolean; current: boolean }
export type McpSetupInspection = {
  client: McpClientId
  configFile: string
  cliPath?: string
  profile: string
  mode: 'live' | 'snapshot'
  account: string
  registrations: McpRegistration[]
}
export type McpSetupResult = {
  success: boolean
  code?: string
  error?: string
  action?: string
  inspection?: McpSetupInspection
  name?: string
  changed?: boolean
  backup?: string
  check?: McpConnectionCheck
  reloadRequired?: boolean
  notices?: string[]
}
