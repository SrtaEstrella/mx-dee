import clsx from 'clsx'
import { useEffect, useState, type RefObject } from 'react'
import { useTranslate } from '../../i18n/index.js'
import styles from './TurnRuler.module.css'

/** 导航条目：一条提问对应的消息、标题，以及分支位置 */
export type Turn = {
  messageId: string
  text: string
  /** 分支序号（从 1 开始）与总数；只有多分支时才展示 */
  version?: { index: number; total: number }
}

/** 判定「当前项」时，消息顶部越过容器顶部多少算进入视野 */
const ACTIVE_OFFSET = 80

/**
 * 会话轮次导航：贴右边缘的半透明竖条，悬停展开标题，点击跳到对应提问。
 *
 * 与官方 ScrollNav 一致：标题默认隐藏、悬停显示；只有多分支的轮次才显示 n/m；
 * 滚到顶端 / 底端 / 内容不足一屏时指示条渐隐；侧栏收起时移到左侧。
 */
export const TurnRuler = ({
  turns,
  scrollRef,
  siderCollapsed,
}: {
  turns: Turn[]
  scrollRef: RefObject<HTMLDivElement | null>
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)

  /** 按 data-message-id 找元素；消息 id 是纯数字，逐条比对避免选择器转义问题 */
  const findNode = (id: string): HTMLElement | undefined => {
    const container = scrollRef.current
    if (!container) return undefined
    return [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (el) => el.dataset.messageId === id
    )
  }

  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    const update = () => {
      const top = container.getBoundingClientRect().top + ACTIVE_OFFSET
      let current = 0
      turns.forEach((turn, index) => {
        const node = findNode(turn.messageId)
        if (node && node.getBoundingClientRect().top <= top) current = index
      })
      setActive(current)
    }

    update()
    container.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => {
      container.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef, turns])

  if (turns.length === 0) return null

  const jump = (turn: Turn) => {
    const container = scrollRef.current
    const node = findNode(turn.messageId)
    if (!container || !node) return
    const delta = node.getBoundingClientRect().top - container.getBoundingClientRect().top
    container.scrollTo({ top: container.scrollTop + delta - 16, behavior: 'smooth' })
  }

  return (
    <div
      className={clsx(styles.nav, siderCollapsed && styles.navLeft)}
      aria-label={t('turnRulerLabel')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div className={styles.bg} />
      <div className={clsx(styles.wrapper, open && styles.wrapperOpen)}>
        <div className={styles.page}>
          {turns.map((turn, index) => (
            <div
              key={turn.messageId}
              className={clsx(styles.item, index === active && styles.itemActive)}
              onClick={() => jump(turn)}
              title={turn.text}
            >
              {turn.version ? (
                <span className={clsx(styles.branch, open && styles.branchShow)}>
                  {turn.version.index}
                  <span aria-hidden="true">/</span>
                  {turn.version.total}
                </span>
              ) : null}
              <div className={clsx(styles.title, open && styles.titleShow)}>{turn.text}</div>
              <div className={styles.indicator}>
                <div className={styles.line} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
