/**
 * 失败可见层（契约 §7.3.1 ⚠️7/⚠️8）——「让用户看懂到底是哪一层坏了」。
 *
 * v1 的教训（本机实测，跨语言有效）：
 *   pi 本身是好的，但模型/凭据侧失败时，如果什么都不报，用户只看到**一条空回复**，
 *   完全无法区分「桥/SDK 坏了」与「模型/订阅/额度问题」。排查方向会被带歪。
 *
 * 所以本模块只做一件事：**把任意失败归一成一条带 `hint` 的 error 帧**，且 `hint`
 * 的第一句必须明确"是哪一层的问题"。约定（测试会断言这两个前缀）：
 *
 *   - `pi SDK 正常，…`      → 故障在**模型/凭据/网络**侧，SDK 本身没问题
 *   - `pi SDK 不可用：…`    → 故障在 **SDK 加载/初始化**侧（此时也在 capabilities 里报 available:false）
 *
 * 分类规则**全部来自真实错误串**（不是猜的）：
 *   - `403: … An active OpenCode Go subscription is required …`（v1 本机实测）
 *   - `402 insufficient_balance`（本项目 AMR 凭据额度耗尽，PROVIDERS.md 记录）
 *   - `no model selected` / `no API key available`（SDK `prompt()` 的文档化抛错）
 *   - `fetch failed` / `ECONNREFUSED` / `ENOTFOUND`（Node undici 网络错误）
 */

/** 契约 §8 的既有码 + §7.3.1 ⚠️8 的扩展码（v2 去掉与 wire 协议相关的 E_PI_PROTOCOL）。 */
export const AGENT_ERROR_CODES = {
  /** 契约 §8：LLM 调用失败（模型/凭据/额度/网络 → 都在这一层） */
  E_LLM: 'E_LLM',
  /** 契约 §8：模型输出不符合 schema */
  E_LLM_SCHEMA: 'E_LLM_SCHEMA',
  /** 契约 §8：超时 */
  E_PI_TIMEOUT: 'E_PI_TIMEOUT',
  /** §7.3.1 ⚠️8：SDK/pi 不可用（加载失败、模块缺失、初始化失败） */
  E_PI_UNAVAILABLE: 'E_PI_UNAVAILABLE',
  /** §7.3.1 ⚠️8：客户端消息非法 / 命令被拒绝（区别于"SDK 不可用"） */
  E_PI_CMD: 'E_PI_CMD',
  /** §7.3.1 ⚠️8：非法 session id */
  E_PI_SESSION_ID: 'E_PI_SESSION_ID',
  /** 契约 §8：忙碌（同一会话并发 prompt） */
  E_BUSY: 'E_BUSY',
  /** 本地码：会话已释放/已关闭 */
  E_AGENT_DISPOSED: 'E_AGENT_DISPOSED',
} as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[keyof typeof AGENT_ERROR_CODES];

/** 服务端 → 客户端 的 error 帧（契约 §7.2）；字段与 §8 的错误响应体风格一致。 */
export interface AgentErrorFrame {
  type: 'error';
  code: AgentErrorCode;
  msg: string;
  /** ★ 关键字段：一句话说明"是哪一层坏了"，且给出可操作建议 */
  hint?: string;
  detail?: string;
}

/** `hint` 的两个前缀（测试断言用；改这里等于改契约语义，别偷偷改）。 */
export const HINT_SDK_OK = 'pi SDK 正常，';
export const HINT_SDK_BAD = 'pi SDK 不可用：';

/** 失败分类（故意做得小而可解释，便于单测断言具体值）。 */
export const FAILURE_KINDS = {
  quota: 'quota',
  subscription: 'subscription',
  credential: 'credential',
  rate_limit: 'rate_limit',
  model_missing: 'model_missing',
  network: 'network',
  timeout: 'timeout',
  protocol: 'protocol',
  unknown: 'unknown',
} as const;

export type FailureKind = (typeof FAILURE_KINDS)[keyof typeof FAILURE_KINDS];

interface Classified {
  kind: FailureKind;
  /** 面向用户的一句话（可操作） */
  hintTail: string;
  /** 契约 §8 的 code */
  code: AgentErrorCode;
}

/** 按真实错误串分类。`text` 已经是小写化的消息 + code 的拼接。 */
function classify(text: string, status: number | undefined): Classified {
  const has = (...needles: string[]) => needles.some((n) => text.includes(n));

  if (has('insufficient_balance', 'insufficient balance', 'quota', 'exceeded your current quota', '余额')) {
    return {
      kind: FAILURE_KINDS.quota,
      hintTail: '模型额度已耗尽，请充值或换 provider',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('subscription is required', 'subscription required', 'no active subscription', 'not subscribed')) {
    return {
      kind: FAILURE_KINDS.subscription,
      hintTail: '当前 provider 需要有效订阅（凭据本身可能有效），请检查订阅状态',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('invalid api key', 'invalid_api_key', 'incorrect api key', 'unauthorized', 'authentication', 'auth failed') || status === 401) {
    return {
      kind: FAILURE_KINDS.credential,
      hintTail: '凭据无效或已过期，请检查对应的 API key 环境变量',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('rate limit', 'rate_limit', 'too many requests', 'overloaded') || status === 429) {
    return {
      kind: FAILURE_KINDS.rate_limit,
      hintTail: '触发限流/上游过载，稍后重试',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('no model selected', 'no model', 'model not found', 'unknown model', 'no api key available', 'no api key')) {
    return {
      kind: FAILURE_KINDS.model_missing,
      hintTail: '没有可用模型或缺凭据（这是**配置**问题，不是 SDK 故障）：检查 providers.yaml 与环境变量',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('fetch failed', 'econnrefused', 'enotfound', 'econnreset', 'etimedout', 'socket hang up', 'network', 'certificate')) {
    return {
      kind: FAILURE_KINDS.network,
      hintTail: '无法连上模型端点（网络/域名/证书/DNS）：检查 base_url 与本机网络',
      code: AGENT_ERROR_CODES.E_LLM,
    };
  }
  if (has('aborted', 'abort', 'timeout', 'timed out')) {
    return {
      kind: FAILURE_KINDS.timeout,
      hintTail: '本轮被中断或超时；可重试或中断后重发',
      code: AGENT_ERROR_CODES.E_PI_TIMEOUT,
    };
  }
  if (has('schema', 'json_schema', 'did not match schema')) {
    return {
      kind: FAILURE_KINDS.protocol,
      hintTail: '模型输出不符合 schema，可重试',
      code: AGENT_ERROR_CODES.E_LLM_SCHEMA,
    };
  }
  return {
    kind: FAILURE_KINDS.unknown,
    hintTail: '上游返回未分类错误，可重试；若持续失败请查看服务端日志',
    code: AGENT_ERROR_CODES.E_LLM,
  };
}

/** 从任意抛出物里取出「人类可读消息」+ 可能的 HTTP 状态码。**永不抛**。 */
export function describeThrowable(err: unknown): { message: string; status?: number; name?: string } {
  if (err === null || err === undefined) return { message: '未知错误' };
  if (typeof err === 'string') return { message: err };
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return { message: String(err) };
  }
  if (typeof err === 'symbol') {
    try {
      return { message: String(err) };
    } catch {
      return { message: '符号类型的错误' };
    }
  }
  if (err instanceof Error) {
    try {
      const withStatus = err as Error & { status?: number; statusCode?: number; code?: string | number };
      const status =
        typeof withStatus.status === 'number'
          ? withStatus.status
          : typeof withStatus.statusCode === 'number'
            ? withStatus.statusCode
            : undefined;
      // 保留 `code`（ECONNREFUSED / ERR_MODULE_NOT_FOUND 等）参与分类
      const codePart = withStatus.code !== undefined ? ` [${String(withStatus.code)}]` : '';
      return { message: `${err.message}${codePart}`, ...(status !== undefined ? { status } : {}), name: err.name };
    } catch {
      return { message: 'Error 对象读取失败（getter 抛异常）' };
    }
  }
  if (typeof err === 'object') {
    // ⚠️ 原错误写法：直接读 `err.message`/`err.status`。
    //    遇到**会抛异常的 getter**（或 Proxy / 宿主对象）时，分类器自己抛了 ——
    //    违背"分类器永不抛"的契约，被 `classifyFailure 永不抛（畸形输入）` 单测抓出。
    try {
      const o = err as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof o.message === 'string') parts.push(o.message);
      if (typeof o.error === 'string') parts.push(o.error);
      if (o.error !== undefined && typeof o.error === 'object') parts.push(JSON.stringify(o.error));
      const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : undefined;
      return { message: parts.join(' | ') || JSON.stringify(err), ...(status !== undefined ? { status } : {}) };
    } catch {
      return { message: '错误对象读取失败（属性访问抛异常）' };
    }
  }
  return { message: safeString(err) };
}

/** `String(x)` 也可能抛（自定义 `toString`）→ 兜住。 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '未知错误';
  }
}

/**
 * 把任意失败归一成契约 §8 风格的错误描述（code + msg + hint）。
 *
 * 不会抛：任何内部异常都退化成 `unknown` 分类。
 */
export function classifyFailure(
  err: unknown,
  context: { where: string; model?: string | null; attempts?: number },
): { kind: FailureKind; code: AgentErrorCode; msg: string; hint: string; detail: string } {
  // describeThrowable 也包一层：本函数的契约是"**永不抛**"，
  // 连"取消息"这一步都不能成为例外（畸形输入单测专门盯这个）。
  let described: { message: string; status?: number };
  try {
    described = describeThrowable(err);
  } catch {
    described = { message: '错误对象无法解读' };
  }
  const { message, status } = described;
  let classified: Classified;
  try {
    const lowered = `${message} ${status ?? ''}`.toLowerCase();
    classified = classify(lowered, status);
  } catch {
    classified = { kind: FAILURE_KINDS.unknown, hintTail: '未分类错误', code: AGENT_ERROR_CODES.E_LLM };
  }

  const modelPart = context.model ? `模型 ${context.model}` : '模型';
  const attemptsPart = context.attempts && context.attempts > 0 ? `（已自动重试 ${context.attempts} 次）` : '';
  return {
    kind: classified.kind,
    code: classified.code,
    msg: message,
    // 前缀是契约语义：pi SDK 本身没坏，坏的是模型/凭据/网络
    hint: `${HINT_SDK_OK}${context.where}失败：${modelPart}侧问题 → ${classified.hintTail}${attemptsPart}`,
    detail: `kind=${classified.kind}; where=${context.where}${status !== undefined ? `; status=${status}` : ''}`,
  };
}

/** 构造 error 帧（省略 undefined 字段，保持线上 JSON 干净）。 */
export function agentError(
  code: AgentErrorCode,
  msg: string,
  opts: { hint?: string; detail?: string } = {},
): AgentErrorFrame {
  const frame: AgentErrorFrame = { type: 'error', code, msg };
  if (opts.hint) frame.hint = opts.hint;
  if (opts.detail) frame.detail = opts.detail;
  return frame;
}

/** SDK 不可用时的 error 帧（`hint` 前缀是 `HINT_SDK_BAD`）。 */
export function sdkUnavailableError(reason: string, detail?: string): AgentErrorFrame {
  return agentError(AGENT_ERROR_CODES.E_PI_UNAVAILABLE, reason, {
    hint: `${HINT_SDK_BAD}对话功能已禁用（这是 SDK 侧问题，不是模型问题）`,
    ...(detail ? { detail } : {}),
  });
}

/**
 * 把已知的敏感串从文本里抹掉（**只用于我们自己持有的凭据**）。
 *
 * 说明：T-BACKEND 的 `config.ts::redact()` 负责全局脱敏，这里保留一个**不依赖外部模块**的
 * 最小实现，确保 agent 模块单独被使用时也不会把 key 写进错误信息/日志。
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined | null)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    out = out.split(secret).join('<redacted>');
  }
  return out;
}
