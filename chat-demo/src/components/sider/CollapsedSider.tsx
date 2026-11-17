import { IconPanelLeftOutline16, IconSearchOutline16, NewChatIcon } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { searchShortcutLabel } from './SessionSearch.js'
import { openSessionSearch } from './sessionSearchState.js'
import styles from './Sider.module.css'

/** 收起后左上角的胶囊按钮组：展开侧栏、新建会话、会话搜索 */
export const CollapsedSider = () => {
  const t = useTranslate()
  const shortcut = searchShortcutLabel()
  return (
    <div className={styles.collapsed}>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<IconSearchOutline16 />}
          tooltip={`${t('sessionSearchTip')} ${shortcut}`}
          onClick={openSessionSearch}
        />
        <IconButton
          size="m"
          tone="primary"
          icon={<NewChatIcon />}
          tooltip={t('newChat')}
          onClick={newChat}
        />
      </div>
    </div>
  )
}
