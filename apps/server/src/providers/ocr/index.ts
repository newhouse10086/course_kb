/**
 * OCR Provider —— 图片文字识别（可选能力）
 *
 * 规格：[`docs/PROVIDERS.md`](../../../docs/PROVIDERS.md) §6
 *
 * ## 用途
 * 视频课堂里用 ffmpeg 场景检测抽出的**幻灯片帧** → 识别文字。
 *
 * ## ⚠️ 产品预期管理（v1 教训，**别过度承诺**）
 * 视频里"抽出的 PPT"**是图片帧，不是可编辑 PPT**。
 *  - 有 OCR → 出 `ocr_text`
 *  - 无 OCR → **只出帧图 + 时间点**，UI 标注**"图片帧"**
 *  - **绝不承诺**还原版式/动画/可编辑
 *
 * 因此本模块的 `available=false` 是**完全可接受的正常状态**，
 * 上层应当降级为"只给帧图"，而不是报错。
 */

import type { HealthResult, OcrRequest, OcrResult, Provider, ProviderConfigEntry, ProviderInfo } from '../types.ts';
import { ProviderError } from '../types.ts';

export interface CloudOcrOptions {
  id: string;
  label: string;
  vendor: string;
  runtime?: 'local' | 'cloud';
  pricing?: ProviderInfo['pricing'];
  languages?: string[];
  probe: (signal?: AbortSignal) => Promise<void>;
  recognize: (req: OcrRequest) => Promise<Omit<OcrResult, 'usedProvider'>>;
  notConfiguredReason?: string;
}

export class CloudOcr implements Provider {
  readonly info: ProviderInfo;
  private readonly impl: CloudOcrOptions;

  constructor(o: CloudOcrOptions) {
    this.impl = o;
    this.info = {
      id: o.id,
      kind: 'ocr',
      label: o.label,
      vendor: o.vendor,
      runtime: o.runtime ?? 'cloud',
      configured: !o.notConfiguredReason,
      available: false,
      reason: o.notConfiguredReason,
      capabilities: {
        languages: o.languages ?? ['zh', 'en'],
        /** 是否返回文字块坐标（用于定位到幻灯片元素） */
        blocks: true,
      },
      pricing: o.pricing,
      limits: { maxSizeBytes: 10 * 1024 * 1024, concurrency: 1 },
    };
  }

  async healthCheck(signal?: AbortSignal): Promise<HealthResult> {
    if (!this.info.configured) {
      return { ok: false, reason: this.info.reason ?? '凭据未配置', probe: 'config' };
    }
    const t0 = Date.now();
    try {
      await this.impl.probe(signal);
      return { ok: true, latencyMs: Date.now() - t0, probe: '识别一张极小测试图' };
    } catch (e) {
      return { ok: false, reason: `OCR 探测失败：${(e as Error).message}`, latencyMs: Date.now() - t0 };
    }
  }

  async recognize(req: OcrRequest): Promise<OcrResult> {
    if (!this.info.configured) {
      throw new ProviderError('E_NOT_CONFIGURED', `${this.info.id} 凭据未配置`, this.info.reason);
    }
    const r = await this.impl.recognize(req);
    return { ...r, usedProvider: this.info.id };
  }
}

/**
 * type: `baidu_ocr` | `aliyun_ocr` | `tencent_ocr` | `local_paddle` | `local_tesseract`
 *
 * 未实现的 type 会**如实声明未实现**。
 */
export function createOcrProvider(entry: ProviderConfigEntry): Provider | null {
  const o = entry.options as Record<string, unknown>;
  const mk = (
    label: string, vendor: string, missing: string,
    runtime: 'local' | 'cloud', pricing?: ProviderInfo['pricing'],
  ): Provider => {
    const notConfigured = (entry.missingEnv?.length ?? 0) > 0
      ? `缺少 ${missing}（在 course-kb/.env 配置）`
      : undefined;
    return new CloudOcr({
      id: entry.id,
      label,
      vendor,
      runtime,
      pricing,
      notConfiguredReason: notConfigured,
      probe: async () => {
        throw new Error(`${entry.type} 适配器尚未实现（provider id=${entry.id}）`);
      },
      recognize: async () => {
        throw new ProviderError(
          'E_PROVIDER',
          `${entry.type} 适配器尚未实现`,
          `provider「${entry.id}」的 type=${entry.type} 还没有实现。` +
          `若不需要 OCR，可把该 provider 从配置里移除 —— 视频页会自动降级为"只出帧图 + 时间点"`,
        );
      },
    });
  };

  switch (entry.type) {
    case 'baidu_ocr':
      return mk(String(o.label ?? '百度 OCR'), '百度', 'BAIDU_OCR_API_KEY / BAIDU_OCR_SECRET_KEY',
        'cloud', { unit: 'call', amount: 0.002, currency: 'CNY' });
    case 'aliyun_ocr':
      return mk(String(o.label ?? '阿里云 OCR'), '阿里云', 'ALIYUN_AK / ALIYUN_SK',
        'cloud', { unit: 'call', amount: 0.002, currency: 'CNY' });
    case 'tencent_ocr':
      return mk(String(o.label ?? '腾讯云 OCR'), '腾讯云', 'TENCENT_SECRET_ID / TENCENT_SECRET_KEY',
        'cloud', { unit: 'call', amount: 0.002, currency: 'CNY' });
    case 'local_tesseract':
      return mk(String(o.label ?? '本地 Tesseract'), '本地', '（本地无需凭据）',
        'local', { unit: 'call', amount: 0, currency: 'CNY', note: '中文需额外语言包，精度一般' });
    case 'local_paddle':
      return mk(String(o.label ?? '本地 PaddleOCR'), '本地', '（本地无需凭据）',
        'local', { unit: 'call', amount: 0, currency: 'CNY', note: '需装 paddlepaddle，较重' });
    default:
      return null;
  }
}
