import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { useMessageWindow } from './messageWindow.js'
import { TurnRuler, type Turn } from './TurnRuler.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
/** 首次渲染的消息条数与每次「加载更早」的步长（一条提问 + 一条回答算两条） */
const PAGE_SIZE = 40
/** 滚到距顶部小于该值时继续向上加载 */
const LOAD_EARLIER_THRESHOLD = 120

export const MessageList = ({
  session,
  streaming,
  footer,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = getVisibleMessages(session)
  // 长会话只渲染末尾一段：DOM 节点数是卡顿的主因（367 轮约 21 万个节点）
  const [windowStart, setWindowStart] = useState(() => Math.max(0, messages.length - PAGE_SIZE))
  /** 向上加载前记录「距底部的高度」，渲染后据此还原滚动位置 */
  const prependAnchorRef = useRef<number | null>(null)
  const revealId = useMessageWindow((state) => state.revealId)
  const clearReveal = useMessageWindow((state) => state.clear)
  /** 滚动回调是常驻监听，用 ref 读最新的窗口起点 */
  const windowStartRef = useRef(windowStart)
  windowStartRef.current = windowStart
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 切换会话时回到「只渲染末尾一段」
  useLayoutEffect(() => {
    const total = getVisibleMessages(session).length
    setWindowStart(Math.max(0, total - PAGE_SIZE))
    prependAnchorRef.current = null
  }, [session.id])

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current
    // 一次手势只补一页：位置还原会再触发 scroll，等到下一帧才允许继续
    if (!el || prependAnchorRef.current !== null) {
      return
    }
    prependAnchorRef.current = el.scrollHeight - el.scrollTop
    setWindowStart((start) => Math.max(0, start - PAGE_SIZE))
  }, [])

  // 补渲染更早的消息后把视口留在原处，避免内容跳动
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const el = scrollRef.current
    if (anchor === null || !el) {
      return
    }
    el.scrollTop = el.scrollHeight - anchor
    scrollTopRef.current = el.scrollTop
    prependAnchorRef.current = null
  }, [windowStart])

  // 搜索或标尺要求跳到窗口之外的消息：先把它纳入窗口，再滚过去
  useLayoutEffect(() => {
    if (!revealId) {
      return
    }
    const index = messages.findIndex((message) => message.id === revealId)
    if (index < 0) {
      // 会话还没加载完，等消息到齐后再处理，别把请求丢掉
      return
    }
    if (index < windowStart) {
      setWindowStart(index)
      return
    }
    const el = scrollRef.current
    const node = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(revealId)}"]`)
    if (node && el) {
      stickyRef.current = false
      const delta = node.getBoundingClientRect().top - el.getBoundingClientRect().top
      el.scrollTo({ top: el.scrollTop + delta - 16 })
      scrollTopRef.current = el.scrollTop
    }
    clearReveal()
  }, [revealId, windowStart, messages, clearReveal])

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      // 滚到接近顶部时继续向上补渲染
      if (el.scrollTop < LOAD_EARLIER_THRESHOLD && windowStartRef.current > 0) {
        loadEarlier()
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)

  // 每一轮提问配一个标尺条目；版本号取该轮回答的版本信息
  const turns: Turn[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user') continue
    const reply = messages[index + 1]
    const replyVersions = reply ? versions.get(reply.id) : undefined
    turns.push({
      messageId: message.id,
      text: message.content.replace(/\s+/g, ' ').trim() || t('untitledChat'),
      ...(replyVersions && replyVersions.ids.length > 1
        ? { version: { index: replyVersions.index + 1, total: replyVersions.ids.length } }
        : {}),
    })
  }

  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div className={styles.wrapper}>
        <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
          <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
            <div ref={contentRef} className={styles.column}>
              {messages.slice(windowStart).map((message, offset) => {
                const index = windowStart + offset
                return message.role === 'user' ? (
                  <UserMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    retryUploadId={uploadRetryId}
                    isFirst={index === 0}
                    isLast={index === lastIndex || index === lastIndex - 1}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                )
              })}
            </div>
          </div>
          {footer}
        </div>
        <TurnRuler turns={turns} scrollRef={scrollRef} siderCollapsed={siderCollapsed} />
      </div>
    </ScrollToBottomContext.Provider>
  )
}
