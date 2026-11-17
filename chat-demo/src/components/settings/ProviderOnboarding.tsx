import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { fetchProviders } from '../../services/providers.js'
import { Button } from '../base/Button.js'
import { openSettings } from './settingsDialogState.js'
import styles from './ProviderOnboarding.module.css'

/**
 * 还没有任何可用 API 时的引导：盖住主区域，告诉用户先去添加，
 * 而不是让人先发一条消息再看到「API Key 无效」。
 * 每添加/删除 API 后由设置弹窗广播事件重新检查。
 */
export const ProviderOnboarding = () => {
  const t = useTranslate()
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const list = await fetchProviders()
        if (!cancelled) {
          setMissing(list.filter((provider) => provider.hasKey).length === 0)
        }
      } catch {
        // 网关不可达时不引导，交给已有的错误提示
      }
    }
    void check()
    const onChange = () => void check()
    window.addEventListener('ds-providers-changed', onChange)
    return () => {
      cancelled = true
      window.removeEventListener('ds-providers-changed', onChange)
    }
  }, [])

  if (!missing) {
    return null
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true">
      <div className={styles.card}>
        <div className={styles.title}>{t('onboardingTitle')}</div>
        <div className={styles.text}>{t('onboardingText')}</div>
        <Button variant="primary" size="m" onClick={() => openSettings('providers')}>
          {t('onboardingAction')}
        </Button>
      </div>
    </div>
  )
}
