import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { searchSessions, type SessionSearchHit } from '../../services/chat/search.js'
import { selectMessageVersion, selectSession } from '../../services/chat/store.js'
import { IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { useMessageWindow } from '../messages/messageWindow.js'
import { closeMobileSider } from './mobileSiderState.js'
import { closeSessionSearch } from './sessionSearchState.js'
import styles from './SessionSearch.module.css'

/** 输入变化后等待多久再发起查询 */
const DEBOUNCE_MS = 200
/** 等待会话渲染出目标消息的最长时间 */
const JUMP_TIMEOUT_MS = 1500

const DAY = 86_400_000

/** 快捷键标签：Mac 用 ⌘ K，其余平台用 Ctrl K */
export const searchShortcutLabel = () =>
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? '⌘ K' : 'Ctrl K'

/** 按 data-message-id 查找消息锚点 */
const findAnchor = (messageId: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[data-message-id]')].find(
    (el) => el.dataset.messageId === messageId
  )

/** 滚动到命中消息；消息不在当前分支时先切换一次分支，仍找不到则提示 */
const jumpToMessage = (sessionId: string, messageId: string | undefined) => {
  if (!messageId) return
  // 目标可能落在渲染窗口之外，先请消息列表把它纳入
  useMessageWindow.getState().reveal(messageId)
  const startedAt = Date.now()
  let switched = false
  const attempt = () => {
    const el = findAnchor(messageId)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }
    // 首次渲染完成后再切换分支
    if (!switched && Date.now() - startedAt > 120) {
      switched = true
      selectMessageVersion(sessionId, messageId)
    }
    if (Date.now() - startedAt < JUMP_TIMEOUT_MS) {
      requestAnimationFrame(attempt)
      return
    }
    showToast({ key: 'sessionSearchNoMessageFound', type: 'error' })
  }
  requestAnimationFrame(attempt)
}

/** 渲染命中区间 */
const Highlighted = ({ hit }: { hit: SessionSearchHit }) => {
  const { snippet, matchStart, matchEnd } = hit
  return (
    <>
      {snippet.slice(0, matchStart)}
      <span className={styles.mark}>{snippet.slice(matchStart, matchEnd)}</span>
      {snippet.slice(matchEnd)}
    </>
  )
}

/**
 * 会话搜索弹层：按关键词搜索全部会话的标题与消息正文。
 *
 * Ctrl/⌘ + K 唤起，↑↓ 选择、Enter 打开、Esc 关闭；
 * 结果日期显示今天 / 昨天 / 月日（跨年补年份），点击跳到命中消息。
 */
export const SessionSearch = ({ open, scope = null }: { open: boolean; scope?: string | null }) => {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [reloadToken, setReloadToken] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const composingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  // 打开时清空并聚焦；关闭时中断在途查询
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      return
    }
    setQuery('')
    setHits([])
    setFailed(false)
    setActiveIndex(-1)
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  // 防抖查询，输入变化时中断上一次
  useEffect(() => {
    if (!open) return
    const keyword = query.trim()
    if (!keyword) {
      setHits([])
      setSearching(false)
      setFailed(false)
      setActiveIndex(-1)
      return
    }
    setSearching(true)
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    const timer = setTimeout(() => {
      searchSessions(keyword, { signal: controller.signal, ...(scope ? { sessionId: scope } : {}) })
        .then((result) => {
          if (controller.signal.aborted) return
          setHits(result)
          setFailed(false)
          setActiveIndex(-1)
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setHits([])
          setFailed(true)
        })
        .finally(() => {
          if (controller.signal.aborted) return
          setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open, query, reloadToken, scope])

  // ↑↓ 选中项变化时让它留在可视区
  useEffect(() => {
    if (activeIndex < 0) return
    const rows = listRef.current?.querySelectorAll('button')
    rows?.[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) return null

  const now = Date.now()
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const dayLabel = (time: number) => {
    const diff = Math.floor((startOfToday - new Date(time).setHours(0, 0, 0, 0)) / DAY)
    if (diff <= 0) return t('sessionHistoryTimelineLabelToday')
    if (diff === 1) return t('sessionHistoryTimelineLabelYesterday')
    const d = new Date(time)
    const parts = { month: d.getMonth() + 1, day: d.getDate(), year: d.getFullYear() }
    return parts.year === new Date(now).getFullYear()
      ? t('sessionSearchDateMD', parts)
      : t('sessionSearchDateYMD', parts)
  }

  const openHit = (hit: SessionSearchHit) => {
    if (!scope) {
      selectSession(hit.sessionId)
      closeMobileSider()
    }
    closeSessionSearch()
    jumpToMessage(hit.sessionId, hit.messageId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法组合期间交由输入法处理
    if (composingRef.current || event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (hits.length === 0) return
      setActiveIndex((current) => (current < 0 ? 0 : (current + 1) % hits.length))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (hits.length === 0) return
      setActiveIndex((current) => (current <= 0 ? hits.length - 1 : current - 1))
      return
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      openHit(hits[activeIndex])
    }
  }

  const keyword = query.trim()

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(event) => event.target === event.currentTarget && closeSessionSearch()}
    >
      <div className={styles.panel} role="dialog" aria-modal="true">
        <div className={styles.searchRow}>
          <span className={styles.searchIcon}>
            <IconSearchOutline16 />
          </span>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            placeholder={scope ? t('conversationSearchPlaceholder') : t('sessionSearchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => (composingRef.current = true)}
            onCompositionEnd={() => (composingRef.current = false)}
            aria-label={scope ? t('conversationSearchPlaceholder') : t('sessionSearchPlaceholder')}
          />
          <IconButton
            icon={<IconCloseOutline16 />}
            aria-label={t('close')}
            onClick={closeSessionSearch}
          />
        </div>
        <div className={styles.list} ref={listRef} aria-label={t('sessionSearchListLabel')}>
          {!keyword ? null : failed ? (
            <div className={styles.state}>
              {t('sessionSearchFailed')}
              <button
                type="button"
                className={styles.retry}
                onClick={() => setReloadToken((token) => token + 1)}
              >
                {t('sessionSearchRetry')}
              </button>
            </div>
          ) : hits.length === 0 ? (
            <div className={styles.state}>
              {searching ? t('sessionSearchSearching') : t('sessionSearchNoResult')}
            </div>
          ) : (
            hits.map((hit, index) => (
              <button
                key={`${hit.sessionId}:${hit.messageId ?? 'title'}`}
                type="button"
                className={index === activeIndex ? `${styles.item} ${styles.itemActive}` : styles.item}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => openHit(hit)}
              >
                <span className={styles.itemIcon}>
                  <IconSearchOutline16 />
                </span>
                <span className={styles.itemMain}>
                  {scope ? null : (
                    <span className={styles.itemTitle}>
                      {hit.titleHit ? <Highlighted hit={hit} /> : hit.sessionTitle || t('untitledChat')}
                    </span>
                  )}
                  {hit.titleHit ? null : (
                    <span className={styles.snippet}>
                      <Highlighted hit={hit} />
                    </span>
                  )}
                </span>
                <span className={styles.itemMeta}>{dayLabel(hit.updatedAt)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
