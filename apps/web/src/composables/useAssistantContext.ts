/**
 * 全局小助手的**页面上下文**（Lead 2026-10-15 裁定）
 *
 * ⚠️ 只传 **id**（`doc_id` / `unit_id` / `session_id` / `page`）——
 *   客户端传来的东西**不可信**，服务端要用知识库把 id 解析成真实标题/正文再注入；
 *   解析不到的 id 会进 `context` 帧的 `dropped`，前端**必须如实显示**（不许静默）。
 *
 * 各页在 mount / 路由变化时调用 `setContext({...})`；小助手抽屉读同一个响应式对象。
 */
import { ref } from 'vue'

export interface AssistantContext {
  doc_id?: string
  unit_id?: string
  /** 沙箱会话 id（Lab 页 —— 让助教能直接看这位学生的 SQL 与报错） */
  session_id?: string
  page?: number
}

/** 当前页上下文（**只含 id**） */
export const assistantContext = ref<AssistantContext>({})
/** 给用户看的"我在看什么"（本地显示用；服务端解析结果优先，见 `context` 帧） */
export const assistantContextLabel = ref('')

export function setAssistantContext(ctx: AssistantContext, label = '') {
  assistantContext.value = { ...ctx }
  assistantContextLabel.value = label
}

export function clearAssistantContext() {
  assistantContext.value = {}
  assistantContextLabel.value = ''
}
