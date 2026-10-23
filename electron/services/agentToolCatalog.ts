export type AgentToolSource = 'auto' | 'chat' | 'moments' | 'web'

export function initialAgentToolNames(
  source: AgentToolSource,
  searchToolName?: string | null,
): Set<string> {
  const names = new Set<string>()
  names.add('read_memory')
  if (source === 'auto' || source === 'chat') {
    names.add('list_conversation_manifest')
    names.add('read_raw_messages')
  }
  const normalizedSearchToolName = String(searchToolName || '').trim()
  if (normalizedSearchToolName && (source === 'auto' || source === 'web')) {
    names.add(normalizedSearchToolName)
  }
  return names
}

export function agentDataSourceGuidance(source: AgentToolSource): string {
  if (source === 'web') {
    return '本轮仅使用公开网页，不提供本地微信聊天记录或朋友圈读取能力。不要声称能够读取本轮范围以外的数据。'
  }
  if (source === 'moments') {
    return '本轮可查阅已接入的朋友圈原文，通过 request_tools 加载 search_moments；本轮不提供微信聊天记录读取能力。需要这些材料时先实际查询，再说明结果或读取限制。'
  }
  return [
    '你能够直接查询 WeFlow 已接入的微信私聊和群聊原文，不需要用户再次提醒你有这项能力。',
    '当用户要求整理自己的日程、待办、约定、通知，或询问人物、事件和关系，而答案需要当前对话以外的个人信息时，应主动查阅当前授权范围内的聊天记录。不要仅因记忆目录没有内容就要求用户粘贴聊天、补充材料或再次授权读取。',
    '已提供 list_conversation_manifest 定位会话（通知和安排可能来自群聊，按需 includeGroups=true），以及 read_raw_messages 读取原文；搜索、跨会话定位和批量读取等能力可通过 request_tools 加载。根据问题选择会话和日期，今天的安排也可能在此前的消息中约定。',
    '当前工具已可调用不代表已经读过记录。先实际读取，再回答找到的事项、来源与尚未确定的部分；只有读取失败、范围不含相关数据或查阅后仍有缺口时，才说明具体限制或请用户补充。闲聊、改写等不依赖个人记录的请求直接回答。',
  ].join('\n')
}

export function resolveAgentToolRequest(
  enabledToolNames: Iterable<string>,
  requestedToolNames: Iterable<string>,
  availableToolNames: Iterable<string>,
): {
  enabledTools: string[]
  newlyEnabled: string[]
  rejectedTools: string[]
} {
  const available = new Set(Array.from(availableToolNames, (name) => String(name || '').trim()).filter(Boolean))
  const enabled = new Set(Array.from(enabledToolNames, (name) => String(name || '').trim()).filter((name) => available.has(name)))
  const newlyEnabled = new Set<string>()
  const rejected = new Set<string>()
  const requested = Array.from(requestedToolNames, (name) => String(name || '').trim()).filter(Boolean)
  for (const name of requested) {
    if (!name || name === 'request_tools' || !available.has(name)) {
      if (name) rejected.add(name)
      continue
    }
    if (!enabled.has(name)) newlyEnabled.add(name)
    enabled.add(name)
  }
  return {
    enabledTools: Array.from(enabled).sort(),
    newlyEnabled: Array.from(newlyEnabled).sort(),
    rejectedTools: Array.from(rejected).sort(),
  }
}
