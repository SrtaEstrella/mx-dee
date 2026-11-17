import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { resolveChoice, useModelChoice } from '../../services/modelChoice.js'
import { fetchProviders, type ProviderInfo } from '../../services/providers.js'
import { useChatStore } from '../../services/chat/store.js'
import styles from './ModelPicker.module.css'

/** 菜单宽度与离触发器、视口边缘的间距 */
const MENU_WIDTH = 264
const GAP = 8
const EDGE = 8

type Anchor = { left: number; bottom: number }

/**
 * 输入区的 API / 模型选择器。
 *
 * 选中项按会话保存；会话没有独立设置时沿用全局默认。
 * 菜单挂到 body 上并用 fixed 定位，避免被输入区容器的 overflow 裁剪。
 */
export const ModelPicker = () => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const sessions = useModelChoice((state) => state.sessions)
  const global = useModelChoice((state) => state.global)
  const setForSession = useModelChoice((state) => state.setForSession)
  const clearForSession = useModelChoice((state) => state.clearForSession)

  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const choice = activeId ? (sessions[activeId] ?? global) : global
  const selected = resolveChoice(activeId)
  const provider = providers?.find((p) => p.id === selected?.providerId) ?? null
  const label = selected?.model || provider?.defaultModel || t('modelPickerPlaceholder')

  /** 以触发按钮为基准向上展开；菜单高度由 CSS 的 max-height 约束 */
  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = Math.min(MENU_WIDTH, window.innerWidth - EDGE * 2)
    setAnchor({
      left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE)),
      bottom: window.innerHeight - rect.top + GAP,
    })
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, place])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setProviders(null)
    setFailed(false)
    fetchProviders()
      .then((list) => {
        if (!cancelled) setProviders(list)
      })
      .catch(() => {
        if (!cancelled) {
          setProviders([])
          setFailed(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // 点外部或按 Esc 关闭；菜单与触发器都在判定范围内
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = (providerId: string, model: string) => {
    setForSession(activeId ?? null, { providerId, model })
    setOpen(false)
  }

  const menu = open && anchor && (
    <div
      ref={menuRef}
      className={styles.popover}
      role="menu"
      style={{
        left: anchor.left,
        bottom: anchor.bottom,
        width: Math.min(MENU_WIDTH, window.innerWidth - EDGE * 2),
      }}
    >
      {providers === null ? null : failed ? (
        <div className={styles.empty}>{t('modelPickerLoadFailed')}</div>
      ) : providers.length === 0 ? (
        <div className={styles.empty}>{t('modelPickerEmpty')}</div>
      ) : (
        <>
          {choice && activeId ? (
            <>
              <button
                type="button"
                className={styles.item}
                role="menuitem"
                onClick={() => {
                  clearForSession(activeId)
                  setOpen(false)
                }}
              >
                {t('modelPickerFollowGlobal')}
              </button>
              <div className={styles.divider} />
            </>
          ) : null}
          {providers.map((p) => (
            <div key={p.id}>
              <div className={styles.groupLabel}>
                {p.name}
                {p.toolsChannel ? ` · ${t('apiProvidersToolsChannel')}` : ''}
              </div>
              {(p.models.length > 0 ? p.models : [p.defaultModel]).filter(Boolean).map((model) => (
                <button
                  key={`${p.id}:${model}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected?.providerId === p.id && selected?.model === model}
                  className={clsx(
                    styles.item,
                    selected?.providerId === p.id && selected?.model === model && styles.itemSelected
                  )}
                  onClick={() => pick(p.id, model)}
                >
                  <span className={styles.itemName}>{model}</span>
                  {p.platform === 'official' ? (
                    <span className={styles.itemMeta}>{t('apiProvidersPlatformOfficial')}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  )

  return (
    <div className={styles.picker}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx(styles.trigger, open && styles.triggerOpen)}
        aria-label={t('modelPickerLabel')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.triggerLabel}>{label}</span>
        <svg className={styles.chevron} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </div>
  )
}
