<script setup lang="ts">
/**
 * 登录页 —— 真后端 `auth.required=true` 时必须走这里
 *
 * 实测的真实契约（`apps/server` v1.0.0）：
 *   `POST /api/v1/auth/login {username,password}`
 *     → 200 `{user:{id,username,display_name,roles,status}, courses:{teacher,student}, expires_in_s}`
 *     → **httpOnly cookie `ckb_session`**（JS 读不到，浏览器自动带；这也是为什么不能用 localStorage 存 token）
 *   未登录访问受保护接口 → 401 `E_UNAUTHENTICATED` + hint 指向本接口
 *
 * 页面职责：
 *   · 真实提交（不给"演示账号"占位数据；凭据只在服务端校验）
 *   · 失败**如实显示**（401 是"用户名或密码不对"，429 是"尝试过多"，别都写成"网络错误"）
 *   · 登录成功回到 `?next=` 指向的页面
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, ApiError } from '../api/client'
import { writeReport } from '../utils/report'
import type { MeResponse } from '../api/types'

const route = useRoute()
const router = useRouter()
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')
const errorCode = ref('')
const hint = ref('')
const me = ref<MeResponse | null>(null)

const nextPath = computed(() => String(route.query.next || '/wiki'))
const alreadyIn = computed(() => !!me.value?.user)

async function submit() {
  if (!username.value.trim() || !password.value) {
    error.value = '请填写用户名和密码'
    errorCode.value = 'E_LOCAL'
    return
  }
  busy.value = true
  error.value = ''
  errorCode.value = ''
  hint.value = ''
  try {
    const r = await api.login(username.value.trim(), password.value)
    writeReport('login-report', {
      ok: true, user: r.user?.username, roles: r.user?.roles || [], expires_in_s: r.expires_in_s ?? null,
      next: nextPath.value,
    })
    await router.replace(nextPath.value)
  } catch (e) {
    const err = e as ApiError
    errorCode.value = err.code
    // 401 → 凭据错；429 → 限流；其它 → 原样显示 hint（别把可操作信息吞掉）
    error.value = err.status === 401
      ? `用户名或密码不正确（${err.code}）`
      : err.code === 'E_NETWORK' ? err.message : `${err.message}（${err.code}）`
    hint.value = err.hint || ''
    writeReport('login-report', { ok: false, code: err.code, status: err.status, msg: err.message, hint: err.hint })
  } finally {
    busy.value = false
  }
}

function logout() {
  void api.logout().finally(() => { me.value = null; void router.replace('/login') })
}

onMounted(async () => {
  // 已登录就直接回目标页（避免"刷新后又要登一次"）
  try { me.value = await api.me() } catch { me.value = null }
  writeReport('login-report', { ok: alreadyIn.value, stage: 'mounted', user: me.value?.user?.username || null })
})
</script>

<template>
  <div class="login">
    <h1 class="sec-title" data-testid="login-title">登录</h1>

    <div v-if="alreadyIn" class="panel">
      <div class="note ok" data-testid="already-in">
        已登录：<b>{{ me?.user?.display_name || me?.user?.username }}</b>
        <span class="meta faint">（{{ (me?.user?.roles || []).join(', ') || '无角色' }}）</span>
        <span v-if="me?.can" class="faint small"> · {{ me.can }}</span>
      </div>
      <div class="row">
        <button class="primary" type="button" data-testid="go-next" @click="router.replace(nextPath)">继续 →</button>
        <button type="button" data-testid="logout" @click="logout">退出登录</button>
      </div>
    </div>

    <form v-else class="panel" @submit.prevent="submit">
      <div class="note info">
        真后端的登录态是 **httpOnly cookie**（`ckb_session`）：JS 读不到，所以前端**不存 token**；
        未登录访问任何受保护接口都会拿到 401 并被送到这里。
      </div>

      <label class="fld">用户名
        <input v-model="username" type="text" name="username" data-testid="login-username" autocomplete="username" />
      </label>
      <label class="fld">密码
        <input v-model="password" type="password" name="password" data-testid="login-password" autocomplete="current-password" />
      </label>

      <div class="row">
        <button class="primary" type="submit" data-testid="login-submit" :disabled="busy">
          {{ busy ? '登录中…' : '登录' }}
        </button>
        <span class="small faint">凭据只在服务端校验，前端不留存</span>
      </div>

      <div v-if="error" class="note bad" data-testid="login-error" :data-code="errorCode">
        {{ error }}
        <div v-if="hint" class="small" style="margin-top: 4px">{{ hint }}</div>
      </div>
    </form>
  </div>
</template>

<style scoped>
.login { max-width: 520px; margin: 40px auto; padding: 0 22px; }
.fld { display: block; margin: 10px 0; font-size: 13px; }
.fld input { display: block; width: 100%; margin-top: 4px; padding: 6px 9px; font-size: 14px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
</style>
