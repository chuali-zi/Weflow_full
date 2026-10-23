import { existsSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import type { McpLaunchConfig } from './mcpSetup'

/** One launch contract for the GUI, --print-config and installation checks. */
export function buildMcpLaunch(input: {
  executable: string
  serverPath: string
  userData: string
  sourceRoot?: string
  resourcesPath?: string
  dataDir?: string
  mode?: 'live' | 'snapshot'
  timezone?: string
  extraArgs?: string[]
}): McpLaunchConfig {
  const executable = resolve(input.executable)
  const serverPath = resolve(input.serverPath)
  if (!existsSync(executable) || !existsSync(serverPath)) throw new Error('MCP 运行资源缺失，请先构建 MCP 或修复 WeFlow 安装。')
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1', WEFLOW_MCP_ASSETS: dirname(serverPath),
    WEFLOW_BACKEND_ROOT: '', WEFLOW_PYTHON: '', NODE_OPTIONS: '', NODE_PATH: '',
    PYTHONHOME: '', PYTHONPATH: '',
  }
  if (input.sourceRoot) {
    const root = resolve(input.sourceRoot)
    const python = [join(root, '.venv', 'Scripts', 'python.exe'), join(root, '.runtime', 'python', 'python.exe'),
      join(root, '.venv', 'bin', 'python')].find(existsSync)
    if (!python) throw new Error('项目 Python 缺失，请使用现有启动脚本准备源码环境。')
    env.WEFLOW_BACKEND_ROOT = join(root, 'python')
    env.WEFLOW_PYTHON = python
  } else {
    if (!input.resourcesPath || !existsSync(join(input.resourcesPath, 'backend', 'weflow-backend.exe'))) {
      throw new Error('包内后端缺失，请修复 WeFlow 安装。')
    }
    env.NODE_PATH = [join(input.resourcesPath, 'app.asar', 'node_modules'), join(input.resourcesPath, 'app.asar.unpacked', 'node_modules')].join(delimiter)
  }
  const args = [serverPath, '--user-data', resolve(input.userData)]
  if (input.resourcesPath) args.push('--resources-path', resolve(input.resourcesPath))
  if (input.dataDir) args.push('--data-dir', resolve(input.dataDir))
  if (input.mode) args.push('--mode', input.mode)
  if (input.timezone) args.push('--timezone', input.timezone)
  if (input.extraArgs) args.push(...input.extraArgs)
  return { command: executable, args, env }
}
