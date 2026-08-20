/**
 * 生图插件 → 主对话框的图片附件桥。
 *
 * 设计约束：绝不修改其他插件（尤其 dsh-drop-caret，它在 window 捕获阶段
 * 拦截所有 Files drop 并落盘到 .dsh-drop）。因此本桥完全绕开拖拽事件：
 *
 * 1. 通过注入 `conversation.input.left` slot 拿到当前会话 id（slot 的
 *    inject(sessionId) 由主对话输入栏提供，零渲染组件写入模块级变量）；
 * 2. 用 conversation 服务的 `createDraftImages(files)` 创建草稿附件，
 *    再用 `input.for(actx).addImages(ids)` 把图片追加到输入框 —— 与
 *    真实拖拽图片走完全相同的渲染路径（缩略图 + 可点开预览）。
 *
 * 全部在 dsh-image-create 自身代码内完成。
 */

import { useEffect } from 'react'

/** 模块级桥接状态（由 index.ts 的 apply 注入）。 */
let sessionsRef: { scope: (sessionId: string) => unknown } | undefined
/** 当前对话会话 id（由 SessionBridge 组件写入）。 */
let currentSessionId: string | undefined

/** apply 时注入 sessions 服务引用。 */
export function bindConversationBridge(sessions: { scope: (sessionId: string) => unknown }): void {
  sessionsRef = sessions
}

/** SessionBridge 组件写入当前会话 id。 */
export function setCurrentSessionId(sessionId: string): void {
  currentSessionId = sessionId
}

/** 当前会话 id（可能 undefined，说明输入框尚未挂载）。 */
export function peekSessionId(): string | undefined {
  return currentSessionId
}

/** 把一张图片作为草稿附件加入主对话框输入框。
 *  @returns null 表示成功，否则返回可展示的错误文案。 */
export async function addImageFileToConversation(file: File): Promise<string | null> {
  const sessionId = currentSessionId
  if (sessionId === undefined) return '当前对话输入框尚未就绪'
  const sessions = sessionsRef
  if (sessions === undefined) return '对话服务不可用'
  try {
    const actx = sessions.scope(sessionId) as { get: (name: string) => unknown }
    const conversation = actx.get('conversation') as {
      createDraftImages: (files: File[]) => Array<{ id: string }>
      releaseDraftImages: (attachments: Array<{ id: string }>) => void
      input: { for: (actx: unknown) => { addImages: (ids: string[]) => boolean } }
    } | undefined
    if (conversation === undefined) return '对话服务不可用'
    const attachments = conversation.createDraftImages([file])
    const shell = conversation.input.for(actx)
    if (!shell.addImages(attachments.map(attachment => attachment.id))) {
      conversation.releaseDraftImages(attachments)
      return '图片未能加入输入框'
    }
    return null
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught)
  }
}

/** 零渲染桥组件：挂载到 conversation.input.left slot，捕获当前会话 id。 */
export function SessionBridge(props: { sessionId?: string }): null {
  useEffect(() => {
    if (props.sessionId !== undefined) setCurrentSessionId(props.sessionId)
  }, [props.sessionId])
  return null
}
