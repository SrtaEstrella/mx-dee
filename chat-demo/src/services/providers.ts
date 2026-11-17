import { API_ORIGIN } from './api/client.js'

/** 上游平台：官方按 Anthropic 兼容路径，OCGO 走其自有路径 */
export type ProviderPlatform = 'official' | 'ocgo'

/** 网关返回的 provider 视图，不含密钥 */
export type ProviderInfo = {
  id: string
  name: string
  platform: ProviderPlatform
  models: string[]
  defaultModel: string
  /** 是否为官方服务端工具通道（搜索、附件、语音都走它） */
  toolsChannel: boolean
  hasKey: boolean
}

const BASE = `${API_ORIGIN}/providers`

const readJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(text || '网关返回了无法解析的响应')
  }
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? (body as { error?: { message?: string } }).error?.message
        : undefined
    throw new Error(message || `请求失败（${response.status}）`)
  }
  return body as T
}

export const fetchProviders = async (): Promise<ProviderInfo[]> => {
  const body = await readJson<{ providers: ProviderInfo[] }>(await fetch(BASE))
  return body.providers ?? []
}

export const createProvider = async (input: {
  name: string
  platform: ProviderPlatform
  apiKey: string
  baseURL?: string
  toolsChannel?: boolean
}): Promise<ProviderInfo> => {
  const body = await readJson<{ provider: ProviderInfo }>(
    await fetch(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
  )
  return body.provider
}

export const deleteProvider = async (id: string): Promise<void> => {
  await readJson(await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }))
}

/** 指定工具通道：服务端会把其他 provider 的该标记清掉 */
export const setToolsChannel = async (id: string): Promise<ProviderInfo> => {
  const body = await readJson<{ provider: ProviderInfo }>(
    await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolsChannel: true }),
    })
  )
  return body.provider
}

export const refreshProviderModels = async (id: string): Promise<ProviderInfo> => {
  const body = await readJson<{ provider: ProviderInfo }>(
    await fetch(`${BASE}/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
  )
  return body.provider
}
