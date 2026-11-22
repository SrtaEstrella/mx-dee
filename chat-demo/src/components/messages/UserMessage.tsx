import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { IconCloseFill14, IconEditOutline16, IconPaperclipOutline16 } from '../base/icons.js'
import {
  ACCEPT,
  cancelUpload,
  getFileViewType,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
} from '../../services/attachments.js'
import { editMessage, retryUpload } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { showToast } from '../base/toastState.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { FileAttachment, UserMessage as UserMessageType } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  /** 编辑态下的附件：包含原有附件与新增（上传中）的附件 */
  const [files, setFiles] = useState<FileAttachment[]>(message.files)
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** 新增附件的上传任务：id → 上传结果 */
  const uploadsRef = useRef(new Map<string, Promise<string>>())
  const isMobile = useIsMobile()
  const canSend = !busy && !sending && (draft.trim() !== '' || files.length > 0)

  /** 新增附件：整批校验通过后加入编辑态并立即上传 */
  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) {
      return
    }
    const error = validateFiles(incoming, files.length)
    if (error) {
      showToast(error)
      return
    }
    const apiKey = useSettings.getState().apiKey ?? ''
    const added = incoming.map((file) => {
      const id = createId()
      const mimeType = resolveMimeType(file)
      const image = isImage(mimeType)
      uploadsRef.current.set(id, uploadAttachment(apiKey, id, file, file.name, image))
      return { id, serverId: null, name: file.name, size: file.size, isImage: image, mimeType }
    })
    setFiles((previous) => [...previous, ...added])
  }

  const removeFile = (id: string) => {
    if (uploadsRef.current.has(id)) {
      cancelUpload(id)
      uploadsRef.current.delete(id)
    }
    setFiles((previous) => previous.filter((file) => file.id !== id))
  }

  // 进入编辑时把光标放到文本末尾：autoFocus 只负责聚焦，插入点默认在开头
  useLayoutEffect(() => {
    if (!editing) {
      return
    }
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.focus()
    const end = textarea.value.length
    textarea.setSelectionRange(end, end)
  }, [editing])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  const sendEdit = async () => {
    if (!canSend) {
      return
    }
    setSending(true)
    try {
      // 等新增附件上传完成；任一失败则不发，保留编辑态让用户重试或删除
      const resolved = await Promise.all(
        files.map(async (file) => {
          if (file.serverId) {
            return file
          }
          const pending = uploadsRef.current.get(file.id)
          if (!pending) {
            return null
          }
          try {
            return { ...file, serverId: await pending }
          } catch {
            return null
          }
        })
      )
      if (resolved.some((file) => file === null)) {
        showToast({ key: 'uploadFileStatusFailed' })
        return
      }
      if (!ensureApiKey()) {
        return
      }
      if (editMessage(sessionId, message.id, draft.trim(), resolved as FileAttachment[])) {
        stopReadAloud()
        setEditing(false)
        uploadsRef.current.clear()
      }
    } finally {
      setSending(false)
    }
  }

  const startEditing = () => {
    setDraft(message.content)
    setFiles(message.files)
    setEditing(true)
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)} data-message-id={message.id}>
      {!editing && message.files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            message.files.some((file) => !isImage(getFileViewType(file.name))) &&
              styles.filesWithDocuments
          )}
        >
          {message.files.map((file) => (
            <MessageFile
              key={file.id}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
            />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          {files.length > 0 ? (
            <div className={styles.editFiles}>
              {files.map((file) => (
                <div key={file.id} className={styles.editFile}>
                  <MessageFile file={file} onRetry={null} />
                  <button
                    type="button"
                    className={styles.editFileRemove}
                    aria-label={t('delete')}
                    onClick={() => removeFile(file.id)}
                  >
                    <IconCloseFill14 />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy || sending}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const pasted = [...event.clipboardData.files]
              if (pasted.length > 0) {
                event.preventDefault()
                addFiles(pasted)
              }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !isMobile) {
                event.preventDefault()
                void sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT}
              className={styles.fileInput}
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
            <IconButton
              icon={<IconPaperclipOutline16 />}
              tooltip={t('addAttachment')}
              tooltipPlacement="top"
              disabled={busy || sending}
              onClick={() => fileInputRef.current?.click()}
            />
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={() => void sendEdit()}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
              {message.content ? <CopyButton text={message.content} /> : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => {
                  startEditing()
                }}
              />
            </div>
            <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          </div>
        </>
      )}
    </div>
  )
})
