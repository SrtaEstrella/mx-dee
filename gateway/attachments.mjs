/**
 * 附件在混合模式下的中转。
 *
 * 官方 Files API 不提供下载，解析结果取不回来；OCGO 又不认 file_id。
 * 因此在删除/替换前先把上传的原始字节缓存在网关内存里，
 * 混合轮次再按类型换成 OCGO 能消费的块：
 *
 *   图片          → base64 image（保留视觉）
 *   PDF           → base64 document（保留版面与图表）
 *   纯文本 / 代码 → 直接作为 text 块
 *   其余（DOCX/PPTX/XLSX 等）→ 无法转换，该轮回落到官方整轮处理
 *
 * 缓存只存在于进程内存，重启后失效；失效时同样回落官方。
 */

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const TEXT_LIMIT = 200_000

/** PDF 之外能被 OCGO 当作 document 接收的类型只有 PDF */
/** Office 文档的 MIME 里带 openxmlformats，不能按 xml 当纯文本处理 */
const OFFICE_MIME = /officedocument|msword|ms-excel|ms-powerpoint|openxmlformats|epub|mobi/i

const isPdfMime = (mime) => /application\/pdf/i.test(mime || '')
const isImageMime = (mime) => /^image\//.test(mime || '')
const isTextMime = (mime) => {
  if (OFFICE_MIME.test(mime || '')) return false
  return (
    /^text\//.test(mime || '') ||
    /^application\/(json|xml|csv|x-yaml|x-sh|sql|javascript|typescript)\b/i.test(mime || '')
  )
}

/** 从 content-type 里取 boundary */
const boundaryOf = (contentType) =>
  /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '')?.slice(1).find(Boolean)

/**
 * 极简 multipart 解析：只取表单字段与第一个文件。
 */
export const parseMultipart = (buffer, contentType) => {
  const boundary = boundaryOf(contentType)
  if (!boundary) return null
  const delimiter = Buffer.from(`--${boundary}`)
  const fields = {}
  let file = null

  let index = buffer.indexOf(delimiter)
  while (index >= 0) {
    const start = index + delimiter.length
    if (buffer.slice(start, start + 2).toString() === '--') break
    const headerEnd = buffer.indexOf('\r\n\r\n', start)
    if (headerEnd < 0) break
    const next = buffer.indexOf(delimiter, headerEnd)
    if (next < 0) break

    const headers = buffer.slice(start, headerEnd).toString('utf8')
    const body = buffer.slice(headerEnd + 4, next - 2)
    const name = /name="([^"]*)"/i.exec(headers)?.[1]
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1]
    const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()

    if (name) {
      if (filename !== undefined) {
        if (!file) file = { name: filename, mime: mime || 'application/octet-stream', data: body }
      } else {
        fields[name] = body.toString('utf8')
      }
    }
    index = next
  }

  return { fields, file }
}

/** 内存缓存，按总字节数淘汰最旧的条目 */
export const createAttachmentStore = ({ maxBytes = DEFAULT_MAX_BYTES } = {}) => {
  const items = new Map()
  let total = 0

  const evict = () => {
    while (total > maxBytes && items.size > 1) {
      const [id, entry] = items.entries().next().value
      total -= entry.data?.length ?? 0
      items.delete(id)
    }
  }

  return {
    put(id, entry) {
      if (items.has(id)) {
        total -= items.get(id).data?.length ?? 0
        items.delete(id)
      }
      items.set(id, entry)
      total += entry.data?.length ?? 0
      evict()
    },
    get(id) {
      return items.get(id) ?? null
    },
    get size() {
      return items.size
    },
    get bytes() {
      return total
    },
  }
}

/** 把一个 file 引用换成 OCGO 能消费的块；无法转换时返回 null */
const convertBlock = (block, entry) => {
  if (isImageMime(entry.mime)) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: entry.mime,
        data: Buffer.from(entry.data).toString('base64'),
      },
    }
  }
  if (isPdfMime(entry.mime)) {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from(entry.data).toString('base64'),
      },
    }
  }
  if (isTextMime(entry.mime)) {
    const text = Buffer.from(entry.data).toString('utf8').slice(0, TEXT_LIMIT)
    return { type: 'text', text: `【文件：${entry.name}】\n\n${text}` }
  }
  return null
}

/**
 * 把消息里的 file 引用替换成 OCGO 能消费的块。
 *
 * 返回 { messages, resolved }；resolved 为 false 时调用方应回落到官方整轮处理。
 */
export const rewriteAttachments = ({ messages, store, log }) => {
  const out = []

  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    const blocks = []
    for (const block of message.content) {
      const isFileBlock =
        (block?.type === 'image' || block?.type === 'document') && block?.source?.type === 'file'
      if (!isFileBlock) {
        blocks.push(block)
        continue
      }

      const entry = store.get(block.source.file_id)
      if (!entry?.data) {
        log(`  附件 ${block.source.file_id} 不在缓存中，回落官方`)
        return { messages: null, resolved: false }
      }

      const converted = convertBlock(block, entry)
      if (!converted) {
        log(`  附件 ${entry.name} 的类型 OCGO 无法接收，回落官方`)
        return { messages: null, resolved: false }
      }
      blocks.push(converted)
    }
    out.push({ ...message, content: blocks })
  }

  return { messages: out, resolved: true }
}
