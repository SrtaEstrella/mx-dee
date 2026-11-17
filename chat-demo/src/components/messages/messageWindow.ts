import { create } from 'zustand'

/** 请求把某条消息纳入渲染窗口（搜索跳转、标尺点击） */
type MessageWindow = {
  revealId: string | null
  reveal: (id: string) => void
  clear: () => void
}

export const useMessageWindow = create<MessageWindow>((set) => ({
  revealId: null,
  reveal: (id) => set({ revealId: id }),
  clear: () => set({ revealId: null }),
}))
