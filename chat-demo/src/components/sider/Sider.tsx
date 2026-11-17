import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconMultiSelectOutline16,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  IconUnpinOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setPinnedCollapsed, setSiderCollapsed, useSettings } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, setSessionPinned, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Tooltip } from '../base/Tooltip.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { openSessionSearch } from './sessionSearchState.js'
import { SessionItem } from './SessionItem.js'
import { searchShortcutLabel } from './SessionSearch.js'
import { useBatchSelect } from './batchState.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
const PINNED_FOLD_THRESHOLD = 10

export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const pinnedCollapsed = useSettings((state) => state.pinnedCollapsed)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const listRef = useRef<HTMLDivElement>(null)
  /** 当前贴在列表顶端的那个分组标题；多选入口跟着它走 */
  const [topGroupKey, setTopGroupKey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const batch = useBatchSelect()
  const shortcut = useMemo(searchShortcutLabel, [])
  // 选中项是否全部已置顶：决定批量条显示「置顶」还是「取消置顶」
  const allPinned = useMemo(() => {
    if (batch.selected.length === 0) {
      return false
    }
    const pinned = new Set(sessions.filter((item) => item.pinned).map((item) => item.id))
    return batch.selected.every((id) => pinned.has(id))
  }, [batch.selected, sessions])

  // 滚动时判断哪个分组标题正贴在顶部，多选入口只挂在它上面
  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const update = () => {
      const listTop = list.getBoundingClientRect().top
      const sections = [...list.querySelectorAll<HTMLElement>('[data-group]')]
      let active: string | null = sections[0]?.dataset.group ?? null
      for (const section of sections) {
        const header = section.querySelector<HTMLElement>('[class*="sectionHeader"]')
        if (!header) {
          continue
        }
        // 标题行贴住顶部（留 8px 容差，section 自身有 padding-top）
        if (header.getBoundingClientRect().top - listTop <= 8) {
          active = section.dataset.group ?? null
        } else {
          break
        }
      }
      setTopGroupKey(active)
    }
    update()
    list.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(list)
    return () => {
      list.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [groups])

  /** 批量置顶/取消置顶：逐条写入，全部完成后再提示数量 */
  const applyBatchPin = async (pinned: boolean) => {
    const ids = batch.selected
    if (ids.length === 0) {
      return
    }
    for (const id of ids) {
      setSessionPinned(id, pinned)
    }
    batch.stop()
    showToast({
      key: pinned ? 'sessionBatchPinSuccessToast' : 'sessionBatchUnpinSuccessToast',
      params: { count: ids.length },
    })
  }

  const confirmBatchDelete = async () => {
    const ids = batch.selected
    if (ids.length === 0 || deletePending) {
      return
    }
    setDeletePending(true)
    try {
      let removed = 0
      for (const id of ids) {
        if (await removeSession(id)) {
          removed += 1
        }
      }
      setBatchDeleting(false)
      batch.stop()
      showToast(
        removed === ids.length
          ? { key: 'sessionBatchDeleteSuccessToast', params: { count: removed } }
          : { key: 'sessionDeleteFailed', type: 'error' }
      )
    } finally {
      setDeletePending(false)
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <div className={styles.topActions}>
          <IconButton
            size="m"
            icon={<IconSearchOutline16 />}
            tooltip={`${t('sessionSearchTip')} ${shortcut}`}
            tooltipPlacement="bottom"
            onClick={openSessionSearch}
          />
          <IconButton
            size="m"
            icon={<IconPanelLeftOutline16 />}
            tooltip={t('collapseSiderbarButton')}
            tooltipPlacement="bottom"
            onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
          />
        </div>
      </div>
      {batch.active ? (
        <div className={styles.batchHeader}>
          <span className={styles.batchTitle}>
            {batch.selected.length === 0
              ? t('sessionBatchSelectChatTitle')
              : t('sessionBatchSelectedCount', { count: batch.selected.length })}
          </span>
          <button
            type="button"
            className={styles.batchClose}
            aria-label={t('sessionBatchSelectCloseButtonAriaLabel')}
            onClick={batch.stop}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={styles.newChat}
          onClick={() => {
            newChat()
            closeMobileSider()
          }}
        >
          <span className={styles.newChatIcon}>
            <NewChatIcon />
          </span>
          {t('newChat')}
        </button>
      )}
      <div className={styles.listWrap}>
        <div className={styles.list} ref={listRef}>
          {groups.map((group) => {
            // 与官方一致：置顶超过 10 个才出现折叠控件，否则只有标题
            const collapsible = group.key === 'pinned' && group.sessions.length > PINNED_FOLD_THRESHOLD
            const collapsed = collapsible && pinnedCollapsed
            return (
              <div key={group.key} className={styles.section} data-group={group.key}>
                <div className={styles.sectionHeader}>
                  <span>
                    {collapsed ? t('pinNCountChats', { count: group.sessions.length }) : group.label}
                  </span>
                  <span className={styles.sectionActions}>
                    {collapsible ? (
                      <button
                        type="button"
                        className={styles.sectionToggle}
                        aria-label={
                          collapsed
                            ? t('sessionPinnedSectionExpandTooltip')
                            : t('sessionPinnedSectionCollapseTooltip')
                        }
                        aria-expanded={!collapsed}
                        onClick={() => setPinnedCollapsed(!pinnedCollapsed)}
                      >
                        {collapsed ? <IconChevronRightOutline14 /> : <IconChevronDownOutline14 />}
                      </button>
                    ) : null}
                    {batch.active || group.key !== topGroupKey ? null : (
                      <Tooltip content={t('sessionBatchEntryButton')} placement="bottom">
                        <button
                          type="button"
                          className={styles.sectionAction}
                          aria-label={t('sessionBatchEntryButton')}
                          onClick={() => batch.start()}
                        >
                          <IconMultiSelectOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </div>
                {collapsed
                  ? null
                  : group.sessions.map((session) => (
                      <SessionItem
                        key={session.id}
                        session={session}
                        active={session.id === activeId}
                        onDelete={() => setDeleting(session)}
                        selectable={batch.active}
                        selected={batch.selected.includes(session.id)}
                        onToggle={() => {
                          if (!batch.toggle(session.id)) {
                            showToast({ key: 'sessionBatchMaxSelectToast' })
                          }
                        }}
                        onStartBatch={() => batch.start(session.id)}
                      />
                    ))}
              </div>
            )
          })}
        </div>
      </div>
      {batch.active ? (
        <div className={styles.batchBar}>
          <button
            type="button"
            className={styles.batchAction}
            disabled={batch.selected.length === 0}
            onClick={() => void applyBatchPin(!allPinned)}
          >
            {allPinned ? <IconUnpinOutline16 /> : <IconPinOutline16 />}
            <span>{allPinned ? t('unpinSession') : t('pinSession')}</span>
          </button>
          <button
            type="button"
            className={clsx(styles.batchAction, styles.batchDanger)}
            disabled={batch.selected.length === 0}
            onClick={() => setBatchDeleting(true)}
          >
            <IconTrashOutline16 />
            <span>{t('delete')}</span>
          </button>
        </div>
      ) : null}
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {batchDeleting ? (
        <Modal
          title={t('sessionBatchDeleteAlertTitle', { count: batch.selected.length })}
          onClose={() => {
            if (!deletePending) {
              setBatchDeleting(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setBatchDeleting(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={deletePending} onClick={() => void confirmBatchDelete()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          <div className={styles.deleteText}>{t('sessionBatchDeleteDescription')}</div>
        </Modal>
      ) : null}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <>
      <div className={styles.drawerMask} onClick={closeMobileSider} />
      <div className={styles.drawer}>
        <Sider mobile />
      </div>
    </>
  )
}
