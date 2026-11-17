import { create } from 'zustand'

/** 网关级设置：端口与「启动时打开浏览器」，写在 config/app.json，改动需重启网关 */
export type AppSettings = {
  port: number
  openBrowser: boolean
}

type AppSettingsState = {
  settings: AppSettings | null
  loaded: boolean
}

export const useAppSettings = create<AppSettingsState>(() => ({ settings: null, loaded: false }))

export const loadAppSettings = async () => {
  try {
    const res = await fetch('/api/app-settings')
    if (!res.ok) return
    const data = (await res.json()) as AppSettings
    useAppSettings.setState({ settings: data, loaded: true })
  } catch {
    useAppSettings.setState({ loaded: true })
  }
}

/** 写回配置；返回是否需要重启网关才能生效 */
export const saveAppSettings = async (next: AppSettings): Promise<boolean | null> => {
  try {
    const res = await fetch('/api/app-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    })
    if (!res.ok) return null
    const data = (await res.json()) as AppSettings & { restartRequired?: boolean }
    useAppSettings.setState({ settings: { port: data.port, openBrowser: data.openBrowser }, loaded: true })
    return data.restartRequired === true
  } catch {
    return null
  }
}
