/**
 * 混合搜索：模型在 OCGO 上生成回答，搜索与抓页交给官方计次接口执行。
 *
 * 把官方的「服务端工具」在网关里重放一遍：
 *   1. 向 OCGO 声明标准工具（web_search / read_url）；
 *   2. 模型返回 tool_use 时调用官方 /v1/tools/search、/v1/tools/fetch；
 *   3. 结果作为 tool_result 回传，进入下一轮；
 *   4. 同时把动作与结果合成为官方格式的 server_tool_use / web_search_tool_result 块，
 *      前端因此仍能渲染搜索卡片与引用角标。
 *
 * 输出始终是一条逻辑消息：内层的 message_start / message_stop 不外发，
 * content block 的 index 由本模块统一分配。
 */

import { randomUUID } from 'node:crypto'

/** 工具回传后最多再问几轮；最后一轮不带工具，强制模型收尾 */
const MAX_ROUNDS = 5
const SEARCH_TIMEOUT = 20_000
const FETCH_TIMEOUT = 20_000
const SEARCH_COUNT = 8
/** 回传给模型的单页正文上限 */
const FETCH_TEXT_LIMIT = 20_000
/** 客户端未指定输出上限时的默认值；按实际输出计费，上限只防截断 */
const DEFAULT_MAX_TOKENS = 65_536

const sse = (res, event, data) => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 22)}`

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 各平台上 messages 接口的地址 */
const messagesUrl = (provider) =>
  provider.baseURL.replace(/\/+$/, '') + (provider.platform === 'official' ? '/anthropic/v1/messages' : '/messages')

/** 各平台的请求头；OCGO 需要 x-opencode-session */
const messagesHeaders = (provider, key) =>
  provider.platform === 'official'
    ? {
        'x-api-key': key,
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }
    : {
        'x-opencode-session': provider.session || '',
        authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      }

/**
 * 让 provider 生成会话标题。
 *
 * OCGO 不认官方的 title 参数，但标题只是一次普通生成，不需要任何服务端工具能力。
 */
export async function titleFrom(provider, key, question) {
  if (!provider || !key || !question) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(messagesUrl(provider), {
      method: 'POST',
      headers: messagesHeaders(provider, key),
      body: JSON.stringify({
        model: provider.defaultModel || 'deepseek-flash',
        max_tokens: 32,
        thinking: { type: 'disabled' },
        messages: [
          {
            role: 'user',
            content:
              '为这段对话起一个不超过 12 个字的中文标题，只输出标题本身，不要引号、标点或解释。\n\n' +
              `用户的问题：${question.slice(0, 200)}`,
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = await response.json()
    const text = (payload.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    const title = text.replace(/^[「『"']+|[」』"']+$/g, '').split('\n')[0].trim()
    return title.slice(0, 40) || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 生成会话标题；失败时本轮不设标题，下一轮前端会再次请求 */
async function generateTitle({ provider, key, question, log }) {
  const title = await titleFrom(provider, key, question)
  if (title) {
    log?.(`  标题 → ${provider.name}: 「${title}」`)
  } else {
    log?.('  标题生成失败，本轮不设标题')
  }
  return title
}

async function withTimeout(run, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function callSearch(toolsProvider, toolsKey, query, oriQuestion) {
  return withTimeout(async (signal) => {
    const response = await fetch(`${toolsProvider.baseURL.replace(/\/+$/, '')}/v1/tools/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${toolsKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: query.slice(0, 128),
        count: SEARCH_COUNT,
        need_content: false,
        ...(oriQuestion ? { ori_question: oriQuestion.slice(0, 128) } : {}),
      }),
      signal,
    })
    if (!response.ok) throw new Error(`search ${response.status}`)
    const payload = await response.json()
    return Array.isArray(payload.results) ? payload.results : []
  }, SEARCH_TIMEOUT)
}

async function callFetch(toolsProvider, toolsKey, url) {
  return withTimeout(async (signal) => {
    const response = await fetch(`${toolsProvider.baseURL.replace(/\/+$/, '')}/v1/tools/fetch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${toolsKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    })
    if (!response.ok) throw new Error(`fetch ${response.status}`)
    return await response.json()
  }, FETCH_TIMEOUT)
}

/** 读取上游 SSE，逐事件回调 */
async function readSse(stream, onEvent) {
  const decoder = new TextDecoder()
  let buffer = ''
  const flushFrame = (raw) => {
    const data = /^data: (.+)$/m.exec(raw)?.[1]
    if (!data) return
    try {
      onEvent(JSON.parse(data))
    } catch {
      // 忽略无法解析的帧
    }
  }
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let cut = buffer.indexOf('\n\n')
    while (cut >= 0) {
      flushFrame(buffer.slice(0, cut))
      buffer = buffer.slice(cut + 2)
      cut = buffer.indexOf('\n\n')
    }
  }
  if (buffer.trim()) flushFrame(buffer)
}

/** 提取文本里的 http(s) 链接 */
const extractUrls = (text) =>
  [...new Set((String(text).match(/https?:\/\/[^\s<>"'）)]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, '')))]

/** 段落写入器：按空行切块，引用挂在段落末尾（与官方行为一致） */
const createWriter = (res, nextIndex) => {
  let open = null
  let buffer = ''

  const openBlock = () => {
    open = nextIndex()
    sse(res, 'content_block_start', {
      type: 'content_block_start',
      index: open,
      content_block: { type: 'text', text: '' },
    })
  }

  const emitCitations = (citations) => {
    for (const source of citations) {
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: open,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: source.url,
            title: source.title ?? null,
            cited_text: '',
          },
        },
      })
    }
  }

  const closeBlock = (citations) => {
    if (open === null) return
    emitCitations(citations)
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: open })
    open = null
  }

  const write = (text) => {
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: open,
      delta: { type: 'text_delta', text },
    })
  }

  return {
    /** 追加文本；遇到空行即切段，把该段提到的来源挂上 */
    push(text, pickCitations) {
      if (!open) openBlock()
      buffer += text
      let cut = buffer.indexOf('\n\n')
      while (cut >= 0) {
        const chunk = buffer.slice(0, cut + 2)
        buffer = buffer.slice(cut + 2)
        write(chunk)
        closeBlock(pickCitations(chunk))
        if (buffer) openBlock()
        cut = buffer.indexOf('\n\n')
      }
      if (buffer) {
        write(buffer)
        buffer = ''
      }
    },
    /** 关闭当前段落；includeUncited 为真时把剩余来源一并挂上 */
    flush(pickCitations, includeUncited) {
      if (buffer && open) {
        write(buffer)
        buffer = ''
      }
      if (open === null) return
      closeBlock(pickCitations(null, includeUncited))
    },
  }
}

/** 段落里是否提到该来源 */
const mentions = (paragraph, source) => {
  const text = paragraph.toLowerCase()
  if (source.siteName && text.includes(source.siteName.toLowerCase())) return true
  const host = hostOf(source.url)
  return !!host && text.includes(host.toLowerCase())
}

/**
 * 执行工具调用：先把动作与结果合成为官方内容块发出，再返回给模型的结果。
 */
async function runTools({ res, toolUses, toolsProvider, toolsKey, nextIndex, log, oriQuestion, sources }) {
  const blocks = []
  const results = []

  for (const use of toolUses) {
    if (use.name === 'web_search') {
      const id = newId('srvtoolu')
      const query = String(use.input?.query || '')

      const toolIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: toolIndex,
        content_block: {
          type: 'server_tool_use',
          id,
          name: 'deepseek_web_search',
          kind: 'search',
          input: { action: 'search', queries: [query] },
          caller: { type: 'direct' },
        },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: toolIndex })

      let items = []
      let text = '没有搜索到结果。'
      try {
        log?.(`  搜索 → ${toolsProvider.name}: ${query}`)
        const found = await callSearch(toolsProvider, toolsKey, query, oriQuestion)
        items = found.map((item) => ({
          type: 'web_search_result',
          url: item.url,
          title: item.title,
          snippet: item.snippet ?? null,
          site_name: item.site_name ?? null,
          site_icon: item.site_icon ?? null,
          page_age: item.date ?? null,
        }))
        for (const item of found) {
          if (!sources.some((s) => s.url === item.url)) {
            sources.push({ url: item.url, title: item.title, siteName: item.site_name || '' })
          }
        }
        text =
          found.length === 0
            ? '没有搜索到结果。'
            : found
                .map(
                  (item, i) =>
                    `[${i + 1}] ${item.title}\n${item.url}\n${item.summary || item.snippet || ''}`
                )
                .join('\n\n')
      } catch (error) {
        log(`  搜索失败: ${error.message}`)
        items = [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
        text = '搜索服务暂时不可用。'
      }

      const resultIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: resultIndex,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: id,
          kind: 'search',
          content: items,
        },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: resultIndex })

      blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: text })
      continue
    }

    if (use.name === 'read_url') {
      const id = newId('srvtoolu')
      const url = String(use.input?.url || '')

      const toolIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: toolIndex,
        content_block: {
          type: 'server_tool_use',
          id,
          name: 'deepseek_read_url',
          kind: 'read_link',
          input: { action: 'open_page', url },
          caller: { type: 'direct' },
        },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: toolIndex })

      let contentBlock
      let text
      try {
        log?.(`  抓取 → ${toolsProvider.name}: ${url}`)
        const page = await callFetch(toolsProvider, toolsKey, url)
        contentBlock = {
          type: 'web_fetch_result',
          url,
          content: { title: page.title ?? null },
          published_at: null,
        }
        text = `# ${page.title || '（无标题）'}\n\n${(page.content || '').slice(0, FETCH_TEXT_LIMIT)}`
        if (!sources.some((s) => s.url === url)) {
          sources.push({ url, title: page.title || url, siteName: hostOf(url) })
        }
      } catch (error) {
        log(`  抓取失败: ${error.message}`)
        contentBlock = { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }
        text = `读取 ${url} 失败。`
      }

      const resultIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: resultIndex,
        content_block: {
          type: 'web_fetch_tool_result',
          tool_use_id: id,
          kind: 'read_link',
          content: contentBlock,
        },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: resultIndex })

      blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input })
      results.push({ type: 'tool_result', tool_use_id: use.id, content: text })
      continue
    }

    blocks.push({ type: 'tool_use', id: use.id, name: use.name, input: use.input })
    results.push({ type: 'tool_result', tool_use_id: use.id, content: `不支持的工具 ${use.name}` })
  }

  return { blocks, results }
}

/**
 * 主入口：跑完整个工具循环，把结果作为一条消息写给客户端。
 *
 * 返回后响应已结束。
 */
export async function runHybrid({
  res,
  provider,
  key,
  body,
  toolsProvider,
  toolsKey,
  log,
  enableSearch,
  enableReadUrl,
  wantTitle = false,
}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })

  let counter = 0
  const nextIndex = () => counter++
  const messageId = newId('msg')
  const model = body.model

  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  })

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }

  // latest_reminder 角色 OCGO 不认，转成系统提示
  const reminders = (body.messages || [])
    .filter((m) => m?.role === 'latest_reminder')
    .map((m) => m.content)
    .filter(Boolean)
  const history = (body.messages || [])
    .filter((m) => m?.role !== 'latest_reminder')
    .map((m) => ({ role: m.role, content: m.content }))
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  const oriQuestion = typeof lastUser?.content === 'string' ? lastUser.content : ''

  // 标题与首轮并发生成，收尾时再取，避免回答结束后多等一次往返
  const titlePromise = wantTitle
    ? generateTitle({
        provider,
        key,
        question: oriQuestion,
        log,
      }).catch(() => null)
    : null

  const toolSpecs = []
  if (enableSearch) {
    toolSpecs.push({
      name: 'web_search',
      description:
        'Search the live web. Returns ranked results with title, url and summary. Use it whenever the answer depends on current information.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query, 1-128 characters.' } },
        required: ['query'],
      },
    })
  }
  if (enableReadUrl) {
    toolSpecs.push({
      name: 'read_url',
      description: 'Fetch one web page and return its content as Markdown.',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    })
  }

  const systemParts = [body.system || '']
  if (reminders.length > 0) systemParts.push(`当前时间与位置：${reminders.join(' | ')}`)
  if (toolSpecs.length > 0) {
    systemParts.push(
      '需要最新信息或核对事实时必须调用工具，不要凭记忆作答；在提到来源的句子末尾写出它的域名。'
    )
  }
  const system = systemParts.filter(Boolean).join('\n\n')

  const sources = []
  const cited = new Set()
  const writer = createWriter(res, nextIndex)

  // 官方会把用户消息里的链接自动读一遍；这里保持同样语义：先抓取，再交给模型
  if (enableReadUrl) {
    const urls = extractUrls(oriQuestion).slice(0, 3)
    const pages = []
    for (const url of urls) {
      const id = newId('srvtoolu')
      const toolIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: toolIndex,
        content_block: {
          type: 'server_tool_use',
          id,
          name: 'deepseek_read_url',
          kind: 'read_link',
          input: { action: 'open_page', url },
          caller: { type: 'direct' },
        },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: toolIndex })

      let contentBlock
      try {
        const page = await callFetch(toolsProvider, toolsKey, url)
        contentBlock = {
          type: 'web_fetch_result',
          url,
          content: { title: page.title ?? null },
          published_at: null,
        }
        pages.push({ url, title: page.title || url, text: (page.content || '').slice(0, 8000) })
        sources.push({ url, title: page.title || url, siteName: hostOf(url) })
        log(`  预读链接 ${url}`)
      } catch (error) {
        log(`  预读链接失败 ${url}: ${error.message}`)
        contentBlock = { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }
      }

      const resultIndex = nextIndex()
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: resultIndex,
        content_block: { type: 'web_fetch_tool_result', tool_use_id: id, kind: 'read_link', content: contentBlock },
      })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: resultIndex })
    }

    if (pages.length > 0) {
      const context = pages.map((page) => `【已读取网页：${page.url}】\n${page.text}`).join('\n\n')
      const lastIndexInHistory = history.length - 1
      const last = history[lastIndexInHistory]
      history[lastIndexInHistory] = {
        ...last,
        content: Array.isArray(last.content)
          ? [...last.content, { type: 'text', text: context }]
          : [{ type: 'text', text: String(last.content) }, { type: 'text', text: context }],
      }
    }
  }

  /** 段落关闭时挑选要挂的引用 */
  const pickCitations = (paragraph, includeUncited) => {
    const picked = []
    for (const source of sources) {
      if (cited.has(source.url)) continue
      if (paragraph === null ? includeUncited : mentions(paragraph, source)) {
        picked.push(source)
        cited.add(source.url)
      }
    }
    return picked
  }

  let stopReason = 'end_turn'

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const finalRound = round === MAX_ROUNDS - 1
    let upstream
    try {
      upstream = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-opencode-session': provider.session || '',
          authorization: `Bearer ${key}`,
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
          ...(body.thinking ? { thinking: body.thinking } : {}),
          system,
          // 最后一轮不再声明工具，让模型基于已有结果作答
          ...(toolSpecs.length > 0 && !finalRound ? { tools: toolSpecs } : {}),
          messages: history,
        }),
      })
    } catch (error) {
      sse(res, 'error', { type: 'error', error: { type: 'upstream_error', message: error.message } })
      break
    }

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      sse(res, 'error', {
        type: 'error',
        error: { type: 'upstream_error', message: `OCGO ${upstream.status} ${detail.slice(0, 200)}` },
      })
      break
    }

    let roundText = ''
    let roundStop = 'end_turn'
    let thinkingIndex = null
    const toolUses = []

    await readSse(upstream.body, (event) => {
      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage
          if (u) {
            usage.input_tokens += u.input_tokens || 0
            usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0
            usage.cache_read_input_tokens += u.cache_read_input_tokens || 0
          }
          break
        }
        case 'content_block_start': {
          const block = event.content_block
          if (block?.type === 'thinking') {
            thinkingIndex = nextIndex()
            sse(res, 'content_block_start', {
              type: 'content_block_start',
              index: thinkingIndex,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            })
          } else if (block?.type === 'tool_use') {
            toolUses.push({ id: block.id, name: block.name, input: {}, partial: '' })
          }
          break
        }
        case 'content_block_delta': {
          const delta = event.delta
          if (delta?.type === 'thinking_delta' && thinkingIndex !== null) {
            sse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: thinkingIndex,
              delta: { type: 'thinking_delta', thinking: delta.thinking },
            })
          } else if (delta?.type === 'signature_delta' && thinkingIndex !== null) {
            sse(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: thinkingIndex,
              delta: { type: 'signature_delta', signature: delta.signature },
            })
          } else if (delta?.type === 'text_delta') {
            roundText += delta.text
            writer.push(delta.text, pickCitations)
          } else if (delta?.type === 'input_json_delta') {
            const use = toolUses.at(-1)
            if (use) use.partial += delta.partial_json || ''
          }
          break
        }
        case 'content_block_stop': {
          if (thinkingIndex !== null) {
            sse(res, 'content_block_stop', { type: 'content_block_stop', index: thinkingIndex })
            thinkingIndex = null
          }
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) roundStop = event.delta.stop_reason
          if (event.usage) usage.output_tokens += event.usage.output_tokens || 0
          break
        }
        default:
          break
      }
    })

    const wantsTools = roundStop === 'tool_use' && toolUses.length > 0

    // 工具轮：先合上当前段落（不补挂剩余来源）；终轮：补挂所有剩余来源
    writer.flush(pickCitations, !wantsTools)

    if (!wantsTools) {
      stopReason = roundStop === 'max_tokens' ? 'max_tokens' : 'end_turn'
      break
    }
    // 最后一轮不该再要工具；万一要了也不再执行
    if (finalRound) {
      stopReason = 'end_turn'
      break
    }

    for (const use of toolUses) {
      try {
        use.input = use.partial ? JSON.parse(use.partial) : {}
      } catch {
        use.input = {}
      }
    }

    const executed = await runTools({
      res,
      toolUses,
      toolsProvider,
      toolsKey,
      nextIndex,
      log,
      oriQuestion,
      sources,
    })

    const assistantContent = [
      ...(roundText ? [{ type: 'text', text: roundText }] : []),
      ...executed.blocks,
    ]
    history.push({ role: 'assistant', content: assistantContent })
    if (executed.results.length > 0) {
      history.push({ role: 'user', content: executed.results })
    }
  }

  const title = titlePromise ? await titlePromise : null
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, ...(title ? { title } : {}) },
    usage,
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}
