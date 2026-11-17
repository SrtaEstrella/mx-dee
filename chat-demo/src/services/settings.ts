import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  /** 发给网关的占位值：真实密钥由网关在「API 管理」里持有 */
  apiKey: string
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
  /** 侧栏「置顶」分组是否收起 */
  pinnedCollapsed: boolean
  /** 附加在固定身份声明之后的自定义指令，空串表示不加 */
  customInstructions: string
  /** 消息区最大宽度（px），0 表示用默认值 */
  messageWidth: number
  /** 消息正文与思考内容的字号（px） */
  messageFontSize: number
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  pinnedCollapsed: 'chat-demo:pinned-collapsed',
  customInstructions: 'chat-demo:custom-instructions',
  messageWidth: 'chat-demo:message-width',
  messageFontSize: 'chat-demo:message-font-size',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

/** 网关不校验前端传来的密钥，这里给一个固定占位值即可 */
const PLACEHOLDER_API_KEY = 'local'

/** 消息区宽度：0 表示用默认值，否则限制在 480–1600px */
export const clampWidth = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.min(1600, Math.max(480, Math.round(value))) : 0

/** 正文字号限制在 12–20px */
export const clampFontSize = (value: number) =>
  Number.isFinite(value) && value >= 12 && value <= 20 ? Math.round(value) : 14

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey) ?? PLACEHOLDER_API_KEY,
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  pinnedCollapsed: read(KEYS.pinnedCollapsed) === 'true',
  customInstructions: read(KEYS.customInstructions) ?? '',
  messageWidth: clampWidth(Number(read(KEYS.messageWidth))),
  messageFontSize: clampFontSize(Number(read(KEYS.messageFontSize))),
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setPinnedCollapsed = (pinnedCollapsed: boolean) => {
  write(KEYS.pinnedCollapsed, String(pinnedCollapsed))
  useSettings.setState({ pinnedCollapsed })
}

export const setCustomInstructions = (customInstructions: string) => {
  write(KEYS.customInstructions, customInstructions)
  useSettings.setState({ customInstructions })
}

export const setMessageWidth = (value: number) => {
  const messageWidth = clampWidth(value)
  write(KEYS.messageWidth, String(messageWidth))
  useSettings.setState({ messageWidth })
  applyLayoutSettings()
}

export const setMessageFontSize = (value: number) => {
  const messageFontSize = clampFontSize(value)
  write(KEYS.messageFontSize, String(messageFontSize))
  useSettings.setState({ messageFontSize })
  applyLayoutSettings()
}

/** 把宽度与字号写到根元素上的 CSS 变量，样式表直接用它们 */
export const applyLayoutSettings = () => {
  const { messageWidth, messageFontSize } = useSettings.getState()
  const root = document.documentElement.style
  if (messageWidth > 0) {
    root.setProperty('--message-list-max-width', `${messageWidth}px`)
  } else {
    root.removeProperty('--message-list-max-width')
  }
  root.setProperty('--message-font-size', `${messageFontSize}px`)
}
