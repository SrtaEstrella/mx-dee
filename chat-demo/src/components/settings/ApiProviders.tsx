import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useModelChoice } from '../../services/modelChoice.js'
import {
  createProvider,
  deleteProvider,
  fetchProviders,
  refreshProviderModels,
  setToolsChannel,
  type ProviderInfo,
  type ProviderPlatform,
} from '../../services/providers.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './ApiProviders.module.css'

/**
 * API 管理：列出网关里的全部 provider，支持新增、删除与刷新模型列表。
 * 密钥只提交给本地网关，不写入浏览器存储。
 */
export const ApiProviders = () => {
  const t = useTranslate()
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)

  const reload = async () => {
    try {
      setProviders(await fetchProviders())
      setFailed(false)
    } catch {
      setProviders([])
      setFailed(true)
    }
    // 增删改之后通知引导层重新判断「是否还没有可用 API」
    window.dispatchEvent(new Event('ds-providers-changed'))
  }

  useEffect(() => {
    void reload()
  }, [])

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.title}>{t('apiProvidersTitle')}</div>
          <div className={styles.hint}>{t('apiProvidersHint')}</div>
        </div>
        <Button variant="outlined" size="m" onClick={() => setAdding(true)} disabled={adding}>
          {t('apiProvidersAdd')}
        </Button>
      </div>

      {/* 表单紧贴标题栏：点「添加 API」后立即出现在视野内，不被已有卡片挤到底部 */}
      {adding ? (
        <ProviderForm
          onCancel={() => setAdding(false)}
          onCreated={async (created) => {
            setAdding(false)
            await reload()
            // 第一个 API 建好后即成为默认：取其第一个模型，之后请求都带显式 provider
            const list = await fetchProviders()
            if (created?.id) {
              const provider = list.find((item) => item.id === created.id)
              const model = provider?.defaultModel || provider?.models[0]
              if (provider && model) {
                useModelChoice.getState().setGlobal({ providerId: provider.id, model })
              }
            }
            showToast({ key: 'apiProvidersAdded' })
          }}
        />
      ) : null}

      {failed ? <div className={styles.error}>{t('apiProvidersLoadFailed')}</div> : null}

      {providers === null ? null : providers.length === 0 ? (
        <div className={styles.empty}>{t('apiProvidersEmpty')}</div>
      ) : (
        providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} onChanged={reload} />
        ))
      )}
    </div>
  )
}

const ProviderCard = ({
  provider,
  onChanged,
}: {
  provider: ProviderInfo
  onChanged: () => Promise<void>
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const global = useModelChoice((state) => state.global)
  const setGlobal = useModelChoice((state) => state.setGlobal)
  const isDefault = global?.providerId === provider.id

  const run = async (
    action: () => Promise<unknown>,
    successKey: 'apiProvidersRefreshed' | 'apiProvidersDeleted' | 'apiProvidersDefaultSaved'
  ) => {
    setBusy(true)
    try {
      await action()
      await onChanged()
      showToast({ key: successKey })
    } catch (error) {
      showToast({
        key: 'apiProvidersActionFailed',
        type: 'error',
        params: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardName}>{provider.name}</span>
        <span className={styles.badge}>{provider.platform}</span>
        {provider.toolsChannel ? (
          <span className={`${styles.badge} ${styles.badgeTools}`}>{t('apiProvidersToolsChannel')}</span>
        ) : null}
        {isDefault ? (
          <span className={`${styles.badge} ${styles.badgeTools}`}>{t('apiProvidersDefault')}</span>
        ) : null}
        <span className={styles.spacer} />
        <IconButton
          size="xs"
          icon={<IconRefreshOutline16 />}
          tooltip={t('apiProvidersRefresh')}
          disabled={busy}
          onClick={() => void run(() => refreshProviderModels(provider.id), 'apiProvidersRefreshed')}
        />
        <IconButton
          size="xs"
          className={styles.danger}
          icon={<IconTrashOutline16 />}
          tooltip={t('delete')}
          disabled={busy}
          onClick={() => void run(() => deleteProvider(provider.id), 'apiProvidersDeleted')}
        />
      </div>

      <div className={styles.cardMeta}>
        {t('apiProvidersModelCount', { count: provider.models.length })}
        {' · '}
        {provider.hasKey ? t('apiProvidersKeyReady') : t('apiProvidersKeyMissing')}
      </div>

      {provider.models.length > 0 ? (
        <div className={styles.models} title={provider.models.join(', ')}>
          {provider.models.join(' · ')}
        </div>
      ) : null}

      {(!isDefault && provider.models.length > 0) ||
      (provider.platform === 'official' && !provider.toolsChannel) ? (
        <div className={styles.cardActions}>
          {!isDefault && provider.models.length > 0 ? (
            <button
              type="button"
              className={styles.linkButton}
              disabled={busy}
              onClick={() =>
                setGlobal({ providerId: provider.id, model: provider.defaultModel || provider.models[0] })
              }
            >
              {t('apiProvidersSetDefault')}
            </button>
          ) : null}
          {provider.platform === 'official' && !provider.toolsChannel ? (
            <button
              type="button"
              className={styles.linkButton}
              disabled={busy}
              onClick={() => void run(() => setToolsChannel(provider.id), 'apiProvidersRefreshed')}
            >
              {t('apiProvidersSetTools')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const ProviderForm = ({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (created: ProviderInfo) => Promise<void>
}) => {
  const t = useTranslate()
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState<ProviderPlatform>('official')
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (!name.trim() || !apiKey.trim()) {
      setError(t('apiProvidersRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await createProvider({
        name: name.trim(),
        platform,
        apiKey: apiKey.trim(),
        ...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
      })
      await onCreated(created)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.form}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('apiProvidersName')}</span>
        <input
          className={styles.input}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('apiProvidersNamePlaceholder')}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('apiProvidersPlatform')}</span>
        <Select
          ariaLabel={t('apiProvidersPlatform')}
          value={platform}
          options={[
            { value: 'official', label: t('apiProvidersPlatformOfficial') },
            { value: 'ocgo', label: t('apiProvidersPlatformOcgo') },
          ]}
          onChange={(value) => setPlatform(value as ProviderPlatform)}
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('apiProvidersApiKey')}</span>
        <input
          className={styles.input}
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={platform === 'official' ? 'sk-...' : 'oc_sk_...'}
          autoComplete="off"
        />
      </label>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('apiProvidersBaseURL')}</span>
        <input
          className={styles.input}
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
          placeholder={platform === 'official' ? 'https://api.deepseek.com' : 'https://opencode.ai/zen/go/v1'}
        />
      </label>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.formActions}>
        <Button variant="outlined" size="m" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button variant="primary" size="m" disabled={busy} onClick={() => void submit()}>
          {t('apiProvidersSave')}
        </Button>
      </div>
    </div>
  )
}
