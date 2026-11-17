import { loadSessionSummaries, scanSessions } from './db.js'
import type { AssistantMessage, Message } from './types.js'

/** 一条会话搜索命中：定位到会话，并带一段可高亮的上下文 */
export type SessionSearchHit = {
  sessionId: string
  sessionTitle: string
  /** 会话最后更新时间，用于排序与展示 */
  updatedAt: number
  /** 命中标题（true）还是消息正文（false） */
  titleHit: boolean
  /** 命中的消息 id；标题命中时为 undefined，用于点击后滚动定位 */
  messageId?: string
  /** 命中消息的角色；标题命中时为 undefined */
  role?: Message['role']
  /** 截取的上下文片段，已把换行压成空格以免撑开行高 */
  snippet: string
  /** snippet 内命中区间，供界面高亮 */
  matchStart: number
  matchEnd: number
}

/** 命中前后各保留多少字符 */
const CONTEXT_BEFORE = 28
const CONTEXT_AFTER = 56

/** 助手回复的可搜索文本；工具块与引用不参与搜索 */
const assistantText = (message: AssistantMessage): string =>
  message.blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.isTemplate ? '' : block.text
      }
      if (block.type === 'thinking') {
        return block.thinking
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

const messageText = (message: Message): string =>
  message.role === 'user' ? message.content : assistantText(message)

/**
 * 截取命中位置附近的上下文。
 * 换行逐个替换为空格，长度不变，匹配区间在片段内保持有效。
 */
const buildSnippet = (text: string, index: number, length: number) => {
  const start = Math.max(0, index - CONTEXT_BEFORE)
  const end = Math.min(text.length, index + length + CONTEXT_AFTER)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const raw = text.slice(start, end).replace(/\s/g, ' ')
  return {
    snippet: head + raw + tail,
    matchStart: head.length + (index - start),
    matchEnd: head.length + (index - start) + length,
  }
}

/**
 * 在全部会话里搜索关键词（大小写不敏感的子串匹配）。
 *
 * 标题取自摘要表，正文由游标逐条扫描。
 * 每个会话最多产出一条命中，结果按最后更新时间倒序。
 * signal 用于在输入变化时中断旧查询。
 */
export const searchSessions = async (
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<SessionSearchHit[]> => {
  const keyword = query.trim().toLowerCase()
  if (!keyword) {
    return []
  }
  const limit = options.limit ?? 50
  const hits: SessionSearchHit[] = []
  const seen = new Set<string>()

  const summaries = await loadSessionSummaries()
  if (options.signal?.aborted) {
    return []
  }

  // 标题命中优先展示
  for (const summary of summaries) {
    if (hits.length >= limit) break
    const index = summary.title.toLowerCase().indexOf(keyword)
    if (index < 0) continue
    seen.add(summary.id)
    hits.push({
      sessionId: summary.id,
      sessionTitle: summary.title,
      updatedAt: summary.updatedAt,
      titleHit: true,
      snippet: summary.title,
      matchStart: index,
      matchEnd: index + keyword.length,
    })
  }

  // 正文命中：游标逐条扫描，命中即止（每会话一条）
  if (hits.length < limit) {
    await scanSessions((session) => {
      if (options.signal?.aborted || hits.length >= limit) {
        return false
      }
      if (seen.has(session.id)) {
        return true
      }
      for (const message of session.messages) {
        const text = messageText(message)
        if (!text) continue
        const index = text.toLowerCase().indexOf(keyword)
        if (index < 0) continue
        seen.add(session.id)
        hits.push({
          sessionId: session.id,
          sessionTitle: session.title,
          updatedAt: session.updatedAt,
          titleHit: false,
          messageId: message.id,
          role: message.role,
          ...buildSnippet(text, index, keyword.length),
        })
        break
      }
      return true
    })
  }

  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}
