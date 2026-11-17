import { create } from 'zustand'

/** 一次选择：哪个 provider 的哪个模型 */
export type ModelChoice = { providerId: string; model: string }

type Stored = {
  /** 没有会话级设置时使用的默认选择 */
  global: ModelChoice | null
  /** 按会话 id 覆盖 */
  sessions: Record<string, ModelChoice>
}

const KEY = 'chat-demo:model-choice'

const empty = (): Stored => ({ global: null, sessions: {} })

const read = (): Stored => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as Partial<Stored>
    return {
      global: parsed.global ?? null,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    }
  } catch {
    return empty()
  }
}

const write = (value: Stored) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

type State = Stored & {
  setGlobal: (choice: ModelChoice | null) => void
  setForSession: (sessionId: string | null, choice: ModelChoice) => void
  clearForSession: (sessionId: string) => void
}

export const useModelChoice = create<State>((set, get) => ({
  ...read(),

  setGlobal: (choice) => {
    const next = { ...get(), global: choice }
    write({ global: next.global, sessions: next.sessions })
    set({ global: choice })
  },

  /** sessionId 为空时写入全局默认 */
  setForSession: (sessionId, choice) => {
    if (!sessionId) {
      get().setGlobal(choice)
      return
    }
    const sessions = { ...get().sessions, [sessionId]: choice }
    write({ global: get().global, sessions })
    set({ sessions })
  },

  clearForSession: (sessionId) => {
    const sessions = { ...get().sessions }
    delete sessions[sessionId]
    write({ global: get().global, sessions })
    set({ sessions })
  },
}))

/** 会话优先，其次全局默认；都没有时返回 null，由调用方决定回落 */
export const resolveChoice = (sessionId: string | null): ModelChoice | null => {
  const state = useModelChoice.getState()
  if (sessionId && state.sessions[sessionId]) return state.sessions[sessionId]
  return state.global
}

/**
 * 首次使用时把默认服务商写成显式选择，避免「没选过」导致请求不带 provider、
 * 由网关隐式路由。规则与网关兜底一致：优先有密钥的 OCGO，其次第一个有密钥的。
 */
export const ensureGlobalChoice = (
  providers: { id: string; platform: string; defaultModel: string; hasKey: boolean }[]
): ModelChoice | null => {
  if (useModelChoice.getState().global) {
    return useModelChoice.getState().global
  }
  const usable = providers.filter((provider) => provider.hasKey && provider.defaultModel)
  const picked = usable.find((provider) => provider.platform === 'ocgo') ?? usable[0]
  if (!picked) {
    return null
  }
  const choice = { providerId: picked.id, model: picked.defaultModel }
  useModelChoice.getState().setGlobal(choice)
  return choice
}

/** 当前会话是否有独立设置 */
export const hasSessionChoice = (sessionId: string | null): boolean =>
  !!(sessionId && useModelChoice.getState().sessions[sessionId])
