import { create } from 'zustand'

/** 官方限制：一次最多选择 99 个对话 */
export const MAX_BATCH_SELECT = 99

type BatchState = {
  active: boolean
  /** 选中的会话 id，按选择顺序排列 */
  selected: string[]
  /** 从某条会话进入多选，并保持它被选中 */
  start: (id: string) => void
  /** 切换选中；超过上限时返回 false，不改动状态 */
  toggle: (id: string) => boolean
  stop: () => void
}

export const useBatchSelect = create<BatchState>((set, get) => ({
  active: false,
  selected: [],
  start: (id) => set({ active: true, selected: [id] }),
  toggle: (id) => {
    const { selected } = get()
    if (selected.includes(id)) {
      set({ selected: selected.filter((item) => item !== id) })
      return true
    }
    if (selected.length >= MAX_BATCH_SELECT) {
      return false
    }
    set({ selected: [...selected, id] })
    return true
  },
  stop: () => set({ active: false, selected: [] }),
}))
