#!/usr/bin/env node
/**
 * DS-Chat 本地网关与静态服务器。
 *
 * 托管 chat-demo 的构建产物，并把 /api/* 的请求按能力分发到上游：
 *   deepseek_web_search、deepseek_read_url + 链接、image/document 块、title 生成
 *     → 官方服务端工具通道（providers.json 里 toolsChannel 为 true 的那个）
 *   其余对话
 *     → 请求头 x-ds-provider 指定的 provider；缺省时按 DS_ROUTE 策略选择
 *   /anthropic/v1/files、/v1/tools/*
 *     → 官方服务端工具通道
 *
 * Provider 注册表存于 config/providers.json，密钥只在服务端。
 * 首次启动若文件不存在，会用 DEEPSEEK_API_KEY / OCGO_API_KEY 生成两个默认 provider。
 *
 * 上游约束：
 *   - OpenCode Go 使用 Anthropic Messages 协议，SSE 事件与官方一致；
 *   - 该上游拒绝 latest_reminder 角色、safety_check、title 字段（400），转发前剥除；
 *   - 其工具调用会被静默忽略（返回 200 但未执行），因此搜索类请求必须走官方；
 *   - OCGO 请求必须带 x-opencode-session，缺失返回 400 MissingSessionID。
 *
 * 用法：
 *   node server.mjs
 *   node server.mjs --port 8090 --root chat-demo/dist
 *   node server.mjs --route auto|ocgo|official
 */

import { createServer } from 'node:http'
import { createReadStream, readFileSync } from 'node:fs'
import { stat, readFile, writeFile, mkdir } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { runHybrid, titleFrom } from './gateway/hybrid.mjs'
import { createAttachmentStore, parseMultipart, rewriteAttachments } from './gateway/attachments.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- 参数与配置

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/** 极简 .env 解析：KEY=VALUE，# 注释 */
async function loadEnvFile(file) {
  const out = {}
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return out
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

/** 从 DSH 凭证文件读取 OCGO key */
async function readDshCredentials() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh')
  const file = join(home, '.credentials.yaml')
  try {
    const yaml = await readFile(file, 'utf8')
    const pick = (n) => {
      const m = yaml.match(new RegExp(`^\\s*${n}\\s*:\\s*["']?([^"'\\s,]+)`, 'm'))
      return m ? m[1] : null
    }
    return {
      ocgo: pick('OPENCODE_GO_API_KEY') || pick('OCGO_API_KEY'),
      zen: pick('OPENCODE_ZEN_API_KEY'),
    }
  } catch {
    return { ocgo: null, zen: null }
  }
}

const envFile = await loadEnvFile(arg('env', join(__dirname, '.env.local')))
const dshCred = await readDshCredentials()
const pickEnv = (...names) => {
  for (const n of names) {
    if (process.env[n]) return process.env[n]
    if (envFile[n]) return envFile[n]
  }
  return null
}

/** 应用级设置存在 config/app.json：端口与「启动时是否打开浏览器」 */
const appSettingsPath = join(__dirname, 'config', 'app.json')
const clampPort = (value) => {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8090
}
const readAppSettings = async () => {
  try {
    const raw = JSON.parse(readFileSync(appSettingsPath, 'utf8'))
    return { port: clampPort(raw.port), openBrowser: raw.openBrowser !== false }
  } catch {
    return { port: 8090, openBrowser: true }
  }
}
const writeAppSettings = async (next) => {
  await mkdir(dirname(appSettingsPath), { recursive: true })
  await writeFile(appSettingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}
/** CFG 是同步构造的，端口只能同步读一次 */
const readPortSync = () => {
  try {
    return clampPort(JSON.parse(readFileSync(appSettingsPath, 'utf8')).port)
  } catch {
    return 8090
  }
}

const CFG = {
  host: arg('host', '127.0.0.1'),
  port: Number(arg('port', readPortSync())),
  root: resolve(arg('root', join(__dirname, 'chat-demo', 'dist'))),
  configDir: resolve(arg('config', join(__dirname, 'config'))),
  get configPath() {
    return join(this.configDir, 'providers.json')
  },
  /** auto | ocgo | official，仅影响「没有显式指定 provider」的请求 */
  route: arg('route', pickEnv('DS_ROUTE') || 'auto'),
  titleStrategy: pickEnv('DS_TITLE_STRATEGY') || 'first-turn-official',
  stripSafety: pickEnv('DS_STRIP_SAFETY') !== '0',
  /** 选中的 OCGO provider 遇到搜索轮次时，用官方的搜索/抓取接口在网关内执行工具 */
  hybridSearch: pickEnv('DS_HYBRID_SEARCH') !== '0',
  verbose: pickEnv('DS_VERBOSE') !== '0',
}

const log = (...a) => {
  if (CFG.verbose) console.log(...a)
}

/** 上传附件的原始字节缓存：官方不给下载，混合模式只能靠这里拿回内容 */
const attachments = createAttachmentStore()
/** 超过该体积的上传只转发、不缓存 */
const MAX_CACHED_UPLOAD = 40 * 1024 * 1024

// ---------------------------------------------------------------- Provider 注册表

/**
 * provider 形状：
 *   { id, name, platform: 'official'|'ocgo', baseURL, apiKey|apiKeyEnv,
 *     session?, models: string[], defaultModel?, toolsChannel?: boolean }
 */

const OFFICIAL_BASE = pickEnv('OFFICIAL_API_BASE') || 'https://api.deepseek.com'
const OCGO_BASE = pickEnv('OCGO_API_BASE') || 'https://opencode.ai/zen/go/v1'
const OCGO_SESSION = pickEnv('OCGO_SESSION') || '63acfced-83c5-4f27-8be0-edf88cb8679e'

const DEFAULT_OFFICIAL_MODELS = ['deepseek-flash', 'deepseek-v4-pro']
const DEFAULT_OCGO_MODELS = ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'mimo-v2.6-flash']

/** 首次启动用环境变量生成默认 provider */
function bootstrapProviders() {
  const list = []
  const officialKey = pickEnv('DEEPSEEK_API_KEY', 'OFFICIAL_API_KEY')
  if (officialKey) {
    list.push({
      id: 'official-default',
      name: 'DeepSeek API',
      platform: 'official',
      baseURL: OFFICIAL_BASE,
      apiKey: officialKey,
      models: DEFAULT_OFFICIAL_MODELS,
      defaultModel: 'deepseek-flash',
      toolsChannel: true,
    })
  }
  const ocgoKey = pickEnv('OPENCODE_GO_API_KEY', 'OCGO_API_KEY') || dshCred.ocgo
  if (ocgoKey) {
    list.push({
      id: 'ocgo-default',
      name: 'OpenCode Go',
      platform: 'ocgo',
      baseURL: OCGO_BASE,
      apiKey: ocgoKey,
      session: OCGO_SESSION,
      models: DEFAULT_OCGO_MODELS,
      defaultModel: 'deepseek-v4.1-flash',
    })
  }
  return { version: 1, providers: list }
}

let registry = { version: 1, providers: [] }
let registryLoaded = false

const loadRegistry = async () => {
  if (registryLoaded) return registry
  try {
    const text = await readFile(CFG.configPath, 'utf8')
    const parsed = JSON.parse(text)
    registry = {
      version: 1,
      providers: Array.isArray(parsed.providers) ? parsed.providers.filter(isValidProvider) : [],
    }
  } catch {
    registry = bootstrapProviders()
    await saveRegistry()
    log(`已生成默认 provider 配置: ${CFG.configPath}`)
  }
  registryLoaded = true
  return registry
}

const saveRegistry = async () => {
  await mkdir(CFG.configDir, { recursive: true })
  await writeFile(CFG.configPath, JSON.stringify(registry, null, 2), 'utf8')
}

const isValidProvider = (p) =>
  p && typeof p.id === 'string' && typeof p.name === 'string' && (p.platform === 'official' || p.platform === 'ocgo')

/** 密钥解析：优先 apiKeyEnv，其次内联 apiKey */
const providerKey = (p) => (p.apiKeyEnv ? pickEnv(p.apiKeyEnv) : p.apiKey) || null

/** 对外暴露的形态，不含密钥 */
const publicProvider = (p) => ({
  id: p.id,
  name: p.name,
  platform: p.platform,
  models: Array.isArray(p.models) ? p.models : [],
  defaultModel: p.defaultModel || (Array.isArray(p.models) ? p.models[0] : '') || '',
  toolsChannel: !!p.toolsChannel,
  hasKey: !!providerKey(p),
})

const findProvider = (id) => registry.providers.find((p) => p.id === id)
const toolsProvider = () =>
  registry.providers.find((p) => p.toolsChannel && providerKey(p)) ||
  registry.providers.find((p) => p.platform === 'official' && providerKey(p)) ||
  null

/** 没有显式指定时的默认 provider */
const defaultProvider = () => {
  const usable = registry.providers.filter((p) => providerKey(p))
  if (CFG.route === 'official') return usable.find((p) => p.platform === 'official') ?? null
  if (CFG.route === 'ocgo') return usable.find((p) => p.platform === 'ocgo') ?? null
  return usable.find((p) => p.platform === 'ocgo') ?? usable[0] ?? null
}

const providerUrl = (p, path) =>
  p.baseURL.replace(/\/+$/, '') + (p.platform === 'official' ? `/anthropic/v1${path}` : path)

const providerHeaders = (p, key) =>
  p.platform === 'official'
    ? {
        'content-type': 'application/json',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
      }
    : {
        'content-type': 'application/json',
        'x-opencode-session': p.session || OCGO_SESSION,
        authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      }

/** 用 provider 自己的 /models 拉模型列表 */
const fetchProviderModels = async (p) => {
  const key = providerKey(p)
  if (!key) throw new Error('provider 没有可用的密钥')
  const url = p.baseURL.replace(/\/+$/, '') + '/models'
  const response = await fetch(url, {
    headers:
      p.platform === 'official'
        ? { authorization: `Bearer ${key}` }
        : { authorization: `Bearer ${key}`, 'x-opencode-session': p.session || OCGO_SESSION },
  })
  if (!response.ok) throw new Error(`上游返回 ${response.status}`)
  const payload = await response.json()
  const models = (payload.data || payload.models || [])
    .map((m) => m.id || m.name)
    .filter((m) => typeof m === 'string')
  return [...new Set(models)]
}

// ---------------------------------------------------------------- 请求分类

/** 一段 content 里是否出现 http(s) 链接（字符串或块数组都处理） */
const containsUrl = (content) => {
  if (typeof content === 'string') return /https?:\/\//i.test(content)
  if (Array.isArray(content)) {
    return content.some((b) => b?.type === 'text' && /https?:\/\//i.test(b.text || ''))
  }
  return false
}

/**
 * 只看最后一条用户消息：链接出现在更早的轮次里时，那一轮已经读过，
 * 继续每轮重读会重复计费，也会让请求前缀每轮都不同、命中不了缓存。
 */
const lastUserHasUrl = (body) => {
  if (!Array.isArray(body?.messages)) return false
  const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user')
  return lastUser ? containsUrl(lastUser.content) : false
}

/** 最后一条用户消息的纯文本，用于生成标题 */
const lastUserText = (body) => {
  if (!Array.isArray(body?.messages)) return ''
  const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user')
  if (!lastUser) return ''
  if (typeof lastUser.content === 'string') return lastUser.content
  return (Array.isArray(lastUser.content) ? lastUser.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

const toolNames = (body) =>
  new Set(
    (Array.isArray(body?.tools) ? body.tools : [])
      .map((t) => t?.name || t?.type)
      .filter(Boolean)
  )

const hasAttachmentBlock = (body) =>
  Array.isArray(body?.messages) &&
  body.messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === 'image' || b?.type === 'document')
  )

/**
 * 请求末尾是一条写了一半的 assistant（客户端「继续生成」用的 prefill），
 * 返回草稿文本，否则空串。
 */
const prefillOf = (body) => {
  const last = Array.isArray(body?.messages) ? body.messages.at(-1) : null
  if (last?.role !== 'assistant') return ''
  if (typeof last.content === 'string') return last.content.trim()
  if (!Array.isArray(last.content)) return ''
  return last.content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * 判断本轮是否必须走官方服务端工具通道。
 * safety_check 与 latest_reminder 每轮都由前端发送，不作为判据；
 * 关闭智能搜索时前端仍会声明 deepseek_read_url，因此该工具只有配合消息内链接才需要官方。
 */
function needsToolsChannel(body) {
  const reasons = []
  const tools = toolNames(body)
  // 续写要沿用已经产生的思考及其签名，只有官方能接续，OCGO 会重新作答
  if (prefillOf(body)) reasons.push('续写')
  if (tools.has('deepseek_web_search')) reasons.push('智能搜索')
  if (tools.has('deepseek_read_url') && lastUserHasUrl(body)) reasons.push('读取链接')
  if (hasAttachmentBlock(body)) reasons.push('附件')
  if (CFG.titleStrategy === 'first-turn-official' && body?.title?.enabled) reasons.push('生成标题')
  return reasons
}

/** 走 OCGO 需剥除的字段 */
const stripForOcgo = (body, target) => {
  if (Array.isArray(body.tools) && body.tools.length > 0) delete target.tools
  if (body.title) delete target.title
  if (body.safety_check) delete target.safety_check
  if (Array.isArray(body.messages)) {
    target.messages = body.messages.filter((m) => m?.role !== 'latest_reminder')
  }
}

// ---------------------------------------------------------------- 上游调用

const joinUrl = (base, path) => base.replace(/\/+$/, '') + path

/**
 * 把上游 SSE 原样转发；给了 titlePromise 时，在 message_delta 帧上补一个 title。
 * 标题是协议自带字段（message_delta.delta.title），OCGO 不接受该请求参数，
 * 所以在转发阶段合成，客户端无需区分走哪家。
 */
async function pipeUpstream(upstream, res, { titlePromise } = {}) {
  const ac = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  const ct = upstream.headers.get('content-type') || 'application/octet-stream'
  const headers = {
    'content-type': ct,
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }
  const len = upstream.headers.get('content-length')
  if (len) headers['content-length'] = len
  res.writeHead(upstream.status, headers)

  if (!upstream.body) {
    res.end()
    return
  }

  if (!titlePromise) {
    try {
      for await (const chunk of upstream.body) {
        if (res.writableEnded) break
        if (!res.write(chunk)) {
          await new Promise((r) => res.once('drain', r))
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') log('  上游流中断:', err.message)
    } finally {
      if (!res.writableEnded) res.end()
    }
    return
  }

  // 需要改帧：按空行切分事件，只在 message_delta 上动一次
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  let injected = false
  const write = async (text) => {
    if (res.writableEnded) return
    if (!res.write(encoder.encode(text))) {
      await new Promise((r) => res.once('drain', r))
    }
  }
  try {
    for await (const chunk of upstream.body) {
      if (res.writableEnded) break
      pending += decoder.decode(chunk, { stream: true })
      let cut = pending.indexOf('\n\n')
      while (cut >= 0) {
        const event = pending.slice(0, cut + 2)
        pending = pending.slice(cut + 2)
        cut = pending.indexOf('\n\n')
        if (!injected && event.includes('"type":"message_delta"')) {
          injected = true
          let title = null
          try {
            title = await Promise.race([
              titlePromise,
              new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
            ])
          } catch {
            title = null
          }
          await write(title ? withTitle(event, title) : event)
          continue
        }
        await write(event)
      }
    }
    if (pending) await write(pending)
  } catch (err) {
    if (err?.name !== 'AbortError') log('  上游流中断:', err.message)
  } finally {
    if (!res.writableEnded) res.end()
  }
}

/** 在 message_delta 的 data 行里写入 delta.title，其余字节保持原样 */
function withTitle(event, title) {
  return event.replace(/^data: (.+)$/m, (line, json) => {
    try {
      const payload = JSON.parse(json)
      if (payload?.type !== 'message_delta' || !payload.delta) return line
      payload.delta.title = title
      return `data: ${JSON.stringify(payload)}`
    } catch {
      return line
    }
  })
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// ---------------------------------------------------------------- 消息路由

async function handleMessages(req, res) {
  const raw = await readBody(req)
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    return sendJson(res, 400, { error: { type: 'invalid_request', message: '网关：请求体不是合法 JSON' } })
  }

  const forcedReasons = needsToolsChannel(body)
  const requested = req.headers['x-ds-provider']
  const requestedProvider = typeof requested === 'string' ? findProvider(requested) : null
  const requestedUsable = requestedProvider && providerKey(requestedProvider)

  let provider
  let reasons = []
  /** 没有官方工具通道时，联网与标题被忽略 */
  let degradeTools = false
  if (requestedUsable) {
    if (requestedProvider.platform === 'official') {
      // 官方 provider 自带服务端工具能力，所有场景统一使用它
      provider = requestedProvider
      reasons = forcedReasons.length > 0 ? ['指定官方 provider', ...forcedReasons] : ['指定官方 provider']
    } else if (forcedReasons.length === 0) {
      provider = requestedProvider
      reasons = ['指定 provider']
    } else {
      // 选中的是 OCGO：搜索类轮次改在网关内执行官方工具，其余仍回落工具通道
      const hybridAllowed = forcedReasons.every(
        (r) => r === '智能搜索' || r === '读取链接' || r === '附件' || r === '生成标题'
      )
      const official = toolsProvider()
      if (CFG.hybridSearch && hybridAllowed && official && providerKey(official)) {
        provider = requestedProvider
        reasons = ['指定 provider（网关内执行官方搜索）', ...forcedReasons]
      } else if (official && providerKey(official)) {
        provider = official
        reasons = ['指定 provider 无服务端工具，改用 DeepSeek API', ...forcedReasons]
      } else if (hasAttachmentBlock(body)) {
        // 附件需要官方通道做版面解析，没有官方时明确报错，不静默丢内容
        return sendJson(res, 400, {
          error: {
            type: 'attachment_needs_official',
            message: '当前没有可用的 DeepSeek API，无法解析该附件',
          },
        })
      } else {
        // 没有官方通道时，联网与标题静默降级：仍用选中的 provider 作答
        provider = requestedProvider
        reasons = ['无 DeepSeek 工具通道，已忽略联网', ...forcedReasons]
        degradeTools = true
      }
    }
  } else if (forcedReasons.length > 0) {
    const official = toolsProvider()
    if (official && providerKey(official)) {
      provider = official
      reasons = requestedProvider ? ['指定 provider 不可用', ...forcedReasons] : forcedReasons
    } else if (hasAttachmentBlock(body)) {
      return sendJson(res, 400, {
        error: {
          type: 'attachment_needs_official',
          message: '当前没有可用的 DeepSeek API，无法解析该附件',
        },
      })
    } else {
      // 只有 OCGO 时联网无通道可用：降级为普通请求
      provider = defaultProvider()
      reasons = ['无 DeepSeek 工具通道，已忽略联网', ...forcedReasons]
      degradeTools = true
    }
  } else {
    provider = defaultProvider()
    reasons = requestedProvider ? ['指定 provider 不可用，回落默认'] : ['默认']
  }

  if (!provider) {
    return sendJson(res, 500, {
      error: { type: 'gateway_config', message: '没有可用的 provider，请在设置里添加 API 或检查密钥' },
    })
  }

  // 混合模式：OCGO 生成回答，搜索 / 抓页 / 附件在网关内用官方能力补齐
  const officialForHybrid = toolsProvider()
  if (
    CFG.hybridSearch &&
    provider.platform === 'ocgo' &&
    reasons.some((r) => r.includes('网关内执行官方搜索')) &&
    officialForHybrid &&
    providerKey(officialForHybrid)
  ) {
    const rewritten = rewriteAttachments({ messages: body.messages ?? [], store: attachments, log })
    if (rewritten.resolved) {
      const tools = toolNames(body)
      const ocgoModels = Array.isArray(provider.models) ? provider.models : []
      let hybridModel = body.model
      if (hybridModel && ocgoModels.length > 0 && !ocgoModels.includes(hybridModel)) {
        hybridModel = provider.defaultModel || ocgoModels[0]
      }
      log(
        `[messages] → ${provider.name}(${provider.platform}·混合) model=${hybridModel} | ${reasons.join(' / ')}`
      )
      // 普通链路返回的就是上游原样响应；混合模式只有流式，非流式请求明确拒绝
      if (body.stream === false) {
        return sendJson(res, 400, {
          error: { type: 'stream_required', message: '混合模式只支持流式请求（stream: true）' },
        })
      }
      const hybridOptions = {
        provider,
        key: providerKey(provider),
        body: { ...body, model: hybridModel, messages: rewritten.messages },
        toolsProvider: officialForHybrid,
        toolsKey: providerKey(officialForHybrid),
        log,
        enableSearch: tools.has('deepseek_web_search'),
        enableReadUrl: tools.has('deepseek_read_url') && lastUserHasUrl(body),
        // 标题由网关用官方通道单独生成，不再因为 title 把整轮切到官方
        wantTitle: CFG.titleStrategy === 'first-turn-official' && !!body.title?.enabled,
      }
      try {
        await runHybrid({ ...hybridOptions, res })
      } catch (err) {
        log(`  混合执行失败: ${err.message}`)
        if (!res.headersSent) {
          return sendJson(res, 502, { error: { type: 'hybrid_error', message: err.message } })
        }
        res.end()
      }
      return
    }

    // 附件无法转换：本轮改由官方整轮处理
    provider = officialForHybrid
    reasons = [
      '附件无法在混合模式处理，改由 DeepSeek API 整轮处理',
      ...reasons.filter((r) => !r.includes('网关内执行')),
    ]
  }

  const key = providerKey(provider)
  const upstreamBody = { ...body }
  if (provider.platform === 'ocgo') stripForOcgo(body, upstreamBody)
  if (degradeTools) {
    delete upstreamBody.tools
    delete upstreamBody.title
  }
  if (CFG.stripSafety && upstreamBody.safety_check) delete upstreamBody.safety_check

  // 请求的模型不在该 provider 的列表里时改用其默认模型
  const models = Array.isArray(provider.models) ? provider.models : []
  if (upstreamBody.model && models.length > 0 && !models.includes(upstreamBody.model)) {
    const fallbackModel = provider.defaultModel || models[0]
    reasons.push(`模型 ${upstreamBody.model} → ${fallbackModel}`)
    upstreamBody.model = fallbackModel
  }

  log(
    `[messages] → ${provider.name}(${provider.platform}) model=${upstreamBody.model} | ${reasons.join(' / ')}`
  )

  let upstreamRes
  try {
    upstreamRes = await fetch(providerUrl(provider, '/messages'), {
      method: 'POST',
      headers: {
        ...providerHeaders(provider, key),
        // 引用 file_id 时必须带；客户端会传，这里原样转给上游
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
      },
      body: JSON.stringify(upstreamBody),
    })
  } catch (err) {
    return sendJson(res, 502, {
      error: { type: 'upstream_unreachable', message: `网关无法连接上游：${err.message}` },
    })
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text()
    log(`[messages] ← ${upstreamRes.status} ${text.slice(0, 200)}`)
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') || 'application/json',
    })
    return res.end(text)
  }

  // OCGO 不接受 title 参数：标题改在转发阶段合成，客户端仍从 message_delta 读
  const wantTitle = CFG.titleStrategy === 'first-turn-official' && !!body.title?.enabled
  const titlePromise =
    provider.platform === 'ocgo' && wantTitle
      ? titleFrom(provider, key, lastUserText(body))
      : undefined

  await pipeUpstream(upstreamRes, res, { titlePromise })
}

/**
 * 文件上传：转发给官方 Files API，同时把原始字节缓存下来。
 * 官方不提供下载、解析结果也取不回来，混合模式只能靠这份副本。
 */
async function handleFileUpload(req, res, provider, key) {
  const body = await readBody(req)
  const contentType = req.headers['content-type'] || ''
  const headers = { authorization: `Bearer ${key}`, 'content-type': contentType }
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta']

  let upstreamRes
  try {
    upstreamRes = await fetch(providerUrl(provider, '/files'), { method: 'POST', headers, body })
  } catch (err) {
    return sendJson(res, 502, { error: { type: 'upstream_unreachable', message: err.message } })
  }

  const text = await upstreamRes.text()

  if (upstreamRes.ok && body.length <= MAX_CACHED_UPLOAD) {
    const parsed = parseMultipart(body, contentType)
    if (parsed?.file?.data?.length) {
      try {
        const payload = JSON.parse(text)
        if (payload.id) {
          attachments.put(payload.id, {
            name: parsed.file.name,
            mime: parsed.file.mime,
            data: parsed.file.data,
          })
          log(
            `  缓存附件 ${parsed.file.name} (${(parsed.file.data.length / 1024 / 1024).toFixed(1)}MB) → ${payload.id}`
          )
        }
      } catch {
        // 响应不是预期结构时不缓存
      }
    }
  }

  res.writeHead(upstreamRes.status, {
    'content-type': upstreamRes.headers.get('content-type') || 'application/json',
  })
  res.end(text)
}

/** Files / TTS / ASR 直通官方工具通道 */
async function passthroughOfficial(req, res, path) {
  const provider = toolsProvider()
  if (!provider) {
    return sendJson(res, 500, {
      error: { type: 'gateway_config', message: '缺少可用的官方 provider，无法处理文件或语音请求' },
    })
  }
  const key = providerKey(provider)
  log(`[${req.method}] → ${provider.name} ${path}`)

  if (req.method === 'POST' && path === '/files') {
    return handleFileUpload(req, res, provider, key)
  }

  const headers = {
    ...providerHeaders(provider, key),
    'content-type': req.headers['content-type'] || 'application/json',
  }
  delete headers['anthropic-version']
  if (req.headers['anthropic-beta']) headers['anthropic-beta'] = req.headers['anthropic-beta']

  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD') {
    init.body = req
    init.duplex = 'half'
  }

  let upstreamRes
  try {
    upstreamRes = await fetch(joinUrl(provider.baseURL, path), init)
  } catch (err) {
    return sendJson(res, 502, { error: { type: 'upstream_unreachable', message: err.message } })
  }
  await pipeUpstream(upstreamRes, res)
}

// ---------------------------------------------------------------- Provider 管理接口

async function listProviders(res) {
  await loadRegistry()
  sendJson(res, 200, { providers: registry.providers.map(publicProvider) })
}

async function createProvider(req, res) {
  const input = JSON.parse((await readBody(req)).toString('utf8'))
  const platform = input.platform === 'official' || input.platform === 'ocgo' ? input.platform : null
  if (!platform) return sendJson(res, 400, { error: { type: 'invalid_request', message: 'platform 必须是 official 或 ocgo' } })
  if (!input.name || typeof input.name !== 'string') {
    return sendJson(res, 400, { error: { type: 'invalid_request', message: '缺少名称' } })
  }
  if (!input.apiKey || typeof input.apiKey !== 'string') {
    return sendJson(res, 400, { error: { type: 'invalid_request', message: '缺少 API Key' } })
  }

  const provider = {
    id: `p_${randomUUID().slice(0, 8)}`,
    name: input.name.trim(),
    platform,
    baseURL: (input.baseURL || (platform === 'official' ? OFFICIAL_BASE : OCGO_BASE)).replace(/\/+$/, ''),
    apiKey: input.apiKey.trim(),
    models: Array.isArray(input.models) ? input.models : [],
    defaultModel: input.defaultModel || '',
    ...(platform === 'ocgo' ? { session: input.session || OCGO_SESSION } : {}),
    ...(input.toolsChannel ? { toolsChannel: true } : {}),
  }

  // 拉一次模型列表，失败也允许保存
  try {
    provider.models = await fetchProviderModels(provider)
    provider.defaultModel = provider.defaultModel || provider.models[0] || ''
  } catch (err) {
    log(`  provider ${provider.name} 拉取模型失败: ${err.message}`)
    if (provider.defaultModel === '') {
      provider.defaultModel =
        platform === 'official' ? DEFAULT_OFFICIAL_MODELS[0] : DEFAULT_OCGO_MODELS[0]
    }
    if (provider.models.length === 0) {
      provider.models = platform === 'official' ? [...DEFAULT_OFFICIAL_MODELS] : [...DEFAULT_OCGO_MODELS]
    }
  }

  // 第一个官方 provider 默认作为工具通道
  if (platform === 'official' && !toolsProvider()) provider.toolsChannel = true

  registry.providers.push(provider)
  await saveRegistry()
  sendJson(res, 201, { provider: publicProvider(provider) })
}

async function patchProvider(req, res, id) {
  const provider = findProvider(id)
  if (!provider) return sendJson(res, 404, { error: { type: 'not_found', message: 'provider 不存在' } })

  const input = JSON.parse((await readBody(req)).toString('utf8'))
  if (typeof input.name === 'string' && input.name.trim()) provider.name = input.name.trim()
  if (typeof input.apiKey === 'string' && input.apiKey.trim()) provider.apiKey = input.apiKey.trim()
  if (typeof input.baseURL === 'string' && input.baseURL.trim()) {
    provider.baseURL = input.baseURL.trim().replace(/\/+$/, '')
  }
  if (typeof input.toolsChannel === 'boolean') {
    if (input.toolsChannel) {
      registry.providers.forEach((p) => (p.toolsChannel = false))
    }
    provider.toolsChannel = input.toolsChannel
  }
  await saveRegistry()
  sendJson(res, 200, { provider: publicProvider(provider) })
}

async function deleteProvider(res, id) {
  const index = registry.providers.findIndex((p) => p.id === id)
  if (index < 0) return sendJson(res, 404, { error: { type: 'not_found', message: 'provider 不存在' } })
  const wasTools = registry.providers[index].toolsChannel
  registry.providers.splice(index, 1)
  if (wasTools) {
    const next = registry.providers.find((p) => p.platform === 'official')
    if (next) next.toolsChannel = true
  }
  await saveRegistry()
  sendJson(res, 200, { ok: true })
}

async function refreshProviderModels(res, id) {
  const provider = findProvider(id)
  if (!provider) return sendJson(res, 404, { error: { type: 'not_found', message: 'provider 不存在' } })
  try {
    const models = await fetchProviderModels(provider)
    provider.models = models
    if (!provider.defaultModel || !models.includes(provider.defaultModel)) {
      provider.defaultModel = models[0] || provider.defaultModel
    }
    await saveRegistry()
    sendJson(res, 200, { provider: publicProvider(provider) })
  } catch (err) {
    sendJson(res, 502, { error: { type: 'upstream_error', message: err.message } })
  }
}

// ---------------------------------------------------------------- 静态资源

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStaticFile(res, file, info) {
  const ext = extname(file).toLowerCase()
  const isHtml = ext === '.html'
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(file).pipe(res)
}

async function handleStatic(req, res, pathname) {
  if (pathname.endsWith('/')) pathname += 'index.html'
  const abs = resolve(join(CFG.root, normalize(pathname)))
  if (abs !== CFG.root && !abs.startsWith(CFG.root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' })
    return res.end('Forbidden')
  }
  let info = await stat(abs).catch(() => null)
  if (!info || !info.isFile()) {
    const fallback = join(CFG.root, 'index.html')
    info = await stat(fallback).catch(() => null)
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      return res.end('Not Found')
    }
    return serveStaticFile(res, fallback, info)
  }
  return serveStaticFile(res, abs, info)
}

// ---------------------------------------------------------------- 主服务

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  try {
    await loadRegistry()

    // Key 校验：前端用 GET /models 验证，真实 Key 不出服务端
    if (pathname === '/api/models' && req.method === 'GET') {
      const provider = findProvider(String(req.headers['x-ds-provider'] || '')) || defaultProvider()
      const models = provider?.models?.length ? provider.models : ['deepseek-flash']
      return sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', owned_by: provider?.id || 'gateway' })),
      })
    }

    if (pathname === '/api/providers' && req.method === 'GET') return await listProviders(res)
    if (pathname === '/api/providers' && req.method === 'POST') return await createProvider(req, res)

    const providerMatch = /^\/api\/providers\/([^/]+)(\/refresh)?$/.exec(pathname)
    if (providerMatch) {
      const id = providerMatch[1]
      if (providerMatch[2]) {
        if (req.method !== 'POST') return sendJson(res, 405, { error: { type: 'method_not_allowed' } })
        return await refreshProviderModels(res, id)
      }
      if (req.method === 'PATCH') return await patchProvider(req, res, id)
      if (req.method === 'DELETE') return await deleteProvider(res, id)
      return sendJson(res, 405, { error: { type: 'method_not_allowed' } })
    }

    if (pathname === '/api/anthropic/v1/messages' && req.method === 'POST') {
      return await handleMessages(req, res)
    }

    if (pathname.startsWith('/api/anthropic/v1/files')) {
      return await passthroughOfficial(req, res, pathname.slice('/api/anthropic/v1'.length))
    }

    if (pathname.startsWith('/api/v1/tools/')) {
      return await passthroughOfficial(req, res, pathname.slice('/api'.length))
    }

    if (pathname === '/api/app-settings' && req.method === 'GET') {
      return sendJson(res, 200, await readAppSettings())
    }
    if (pathname === '/api/app-settings' && req.method === 'PUT') {
      const raw = JSON.parse((await readBody(req)).toString('utf8') || '{}')
      const current = await readAppSettings()
      const next = {
        port: clampPort(raw.port ?? current.port),
        openBrowser: typeof raw.openBrowser === 'boolean' ? raw.openBrowser : current.openBrowser,
      }
      await writeAppSettings(next)
      // 端口要重启网关才生效，这里只回报写入结果
      return sendJson(res, 200, { ...next, restartRequired: next.port !== CFG.port })
    }

    if (pathname === '/api/health') {
      const tools = toolsProvider()
      const resolved = registry.providers.map((p) => ({
        id: p.id,
        name: p.name,
        platform: p.platform,
        models: p.models?.length ?? 0,
        key: providerKey(p) ? 'configured' : 'missing',
      }))
      return sendJson(res, 200, {
        ok: true,
        route: CFG.route,
        titleStrategy: CFG.titleStrategy,
        stripSafety: CFG.stripSafety,
        providers: resolved,
        toolsChannel: tools ? tools.name : null,
        configPath: CFG.configPath,
        root: CFG.root,
      })
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: { type: 'not_found', message: `网关未处理的路由 ${pathname}` } })
    }

    return await handleStatic(req, res, pathname)
  } catch (err) {
    log('处理请求出错:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
    }
    res.end(JSON.stringify({ error: { type: 'gateway_error', message: err.message } }))
  }
})

server.listen(CFG.port, CFG.host, async () => {
  await loadRegistry()
  const line = '─'.repeat(60)
  console.log(line)
  console.log(`DS-Chat 网关  http://${CFG.host}:${CFG.port}`)
  console.log(`  静态产物  ${CFG.root}`)
  console.log(`  配置      ${CFG.configPath}`)
  console.log(`  路由模式  ${CFG.route} ｜ 标题策略 ${CFG.titleStrategy} ｜ safety_check ${CFG.stripSafety ? '屏蔽' : '保留'}`)
  for (const p of registry.providers) {
    const mark = p.toolsChannel ? ' [工具通道]' : ''
    console.log(`  · ${p.name} (${p.platform}) key=${providerKey(p) ? '✓' : '✗'} 模型 ${p.models?.length ?? 0} 个${mark}`)
  }
  if (registry.providers.length === 0) {
    console.log('  ! 还没有 provider，请在页面「设置 → API 管理」里添加')
  }
  console.log(line)
})

server.on('error', (err) => {
  console.error(`监听失败: ${err.code} ${err.message}`)
  process.exit(1)
})
