/**
 * dsh-image-create standalone settings page (settings.section).
 *
 * Mirrors the vision plugin: a Settings-sidebar entry ("生图插件") opening a
 * full-page provider/model manager styled like the platform's settings UI.
 */

import { ImageGenSettingsPage } from './SettingsPage.tsx'

/**
 * The settings section page. No props: dsh's settings.section renderer
 * supplies optional runtime/locale props, but the page is self-sufficient
 * through the plugin's own HTTP config routes.
 */
export function ImageGenSettingsSection() {
  return <ImageGenSettingsPage />
}
