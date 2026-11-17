import { create } from 'zustand'

/** 搜索范围：null 为全部会话，会话 id 为对话内搜索 */
type SessionSearchState = { open: boolean; scope: string | null }

export const useSessionSearch = create<SessionSearchState>(() => ({ open: false, scope: null }))

export const openSessionSearch = (scope?: string) =>
  useSessionSearch.setState({ open: true, scope: scope ?? null })

export const closeSessionSearch = () =>
  useSessionSearch.setState({ open: false, scope: null })
