import { create } from 'zustand'

/** 设置弹窗的分组：通用设置 / API 管理 / 数据管理 */
export type SettingsSection = 'general' | 'providers' | 'data'

/** 设置弹窗：侧边栏底部、错误提示等都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/**
 * 密钥由网关持有并在「API 管理」里配置，前端不再要求填写。
 * 保留该函数是为了让调用点语义不变。
 */
export const ensureApiKey = () => true
