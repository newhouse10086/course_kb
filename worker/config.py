"""配置（路径 / 端口 / LLM 凭据 / 已验证常量）。

原则（AGENTS.md §8）：
* 凭据**只从环境变量读**，不写死在代码里，也不落盘到日志。
* 能力不可用时**如实降级**：``llm.configured=False`` 时 REST 返回 ``E_LLM``，
  而不是假装能抽卡片。
* 已验证常量（``SPAN_THRESHOLD`` / ``MAX_PAGES_PER_UNIT`` / ``MIN_DEGREE_FOR_PAGE`` /
  **并发=1**）**不要重新发明**。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

#: 工程根目录（course-kb/）
ROOT = Path(__file__).resolve().parents[1]

#: 支持的 LLM 凭据环境变量名（按优先级）。
#: ``AMR_*`` 是上游工程 `数据库课程智能体调研` 已用的名字；``OPENAI_*`` 是通用名字。
BASE_URL_ENVS: tuple[str, ...] = ("COURSE_KB_LLM_BASE", "AMR_BASE", "OPENAI_BASE_URL")
API_KEY_ENVS: tuple[str, ...] = ("COURSE_KB_LLM_KEY", "AMR_KEY", "OPENAI_API_KEY")
MODEL_ENVS: tuple[str, ...] = ("COURSE_KB_LLM_MODEL", "LLM_MODEL")

#: 与上游一致的默认模型（FUNCTIONAL_SPEC F2 已验证值）
DEFAULT_MODEL = "deepseek-v4.1-flash"


def _env_str(names: tuple[str, ...], default: str = "") -> str:
    for n in names:
        v = os.environ.get(n)
        if v and v.strip():
            return v.strip()
    return default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def load_dotenv(path: Path | None = None) -> int:
    """极简 ``.env`` 加载（没有 python-dotenv 依赖）。

    已存在的环境变量**优先**（不被 .env 覆盖），符合 12-factor。
    返回加载的键数。
    """
    p = path or (ROOT / ".env")
    if not p.exists():
        return 0
    n = 0
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v
            n += 1
    return n


@dataclass
class Settings:
    """运行期配置快照（``get_settings()`` 每次读环境变量，测试可注入）。"""

    # ── 服务 ────────────────────────────────────────────────────────
    host: str = "127.0.0.1"
    port: int = 8787
    version: str = "1.0.0"
    #: 上传大小上限（字节）。超过 → E_TOOBIG 413
    max_upload_bytes: int = 1024 * 1024 * 1024

    # ── 路径 ────────────────────────────────────────────────────────
    root: Path = ROOT
    data_dir: Path = ROOT / "data"
    db_path: Path = ROOT / "data" / "course_kb.sqlite3"

    # ── LLM ─────────────────────────────────────────────────────────
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = DEFAULT_MODEL
    llm_temperature: float = 0.0
    #: ★ 用户硬要求：**并发=1**。不是"可调参数"，任何 >1 都是 bug。
    llm_concurrency: int = 1
    llm_max_retries: int = 2
    llm_timeout_s: float = 120.0
    #: 单次请求塞给模型的正文上限（字符），防超上下文
    llm_chunk_chars: int = 24_000

    # ── 已验证管线常量（不要重新发明）────────────────────────────────
    span_threshold: int = 3
    max_pages_per_unit: int = 8
    min_degree_for_page: int = 2
    #: PDF 单次解析页数上限（0 = 全篇）。大手册端到端测试用得上。
    pdf_max_pages: int = 0

    # ── SSE ─────────────────────────────────────────────────────────
    sse_keepalive_s: float = 15.0
    sse_poll_interval_s: float = 0.3

    # 派生路径（在 __post_init__ 里补）
    upload_dir: Path = field(default_factory=lambda: ROOT / "data" / "uploads")
    artifact_dir: Path = field(default_factory=lambda: ROOT / "data" / "artifacts")
    checkpoint_dir: Path = field(default_factory=lambda: ROOT / "data" / "checkpoints")

    def __post_init__(self) -> None:
        self.data_dir = Path(self.data_dir)
        self.db_path = Path(self.db_path)
        self.upload_dir = self.data_dir / "uploads"
        self.artifact_dir = self.data_dir / "artifacts"
        self.checkpoint_dir = self.data_dir / "checkpoints"

    # ── 能力（诚实接口用）───────────────────────────────────────────
    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_api_key)

    @property
    def llm_mode(self) -> str:
        return "openai_compatible" if self.llm_configured else "none"

    @property
    def llm_reason(self) -> str:
        if self.llm_configured:
            return ""
        return (
            "未配置 LLM 凭据：请设置 "
            + " 或 ".join(API_KEY_ENVS)
            + "（及 "
            + " 或 ".join(BASE_URL_ENVS)
            + "）"
        )

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.upload_dir, self.artifact_dir, self.checkpoint_dir):
            d.mkdir(parents=True, exist_ok=True)

    def doc_dir(self, doc_id: str) -> Path:
        return self.upload_dir / doc_id


def get_settings() -> Settings:
    """从环境变量构造配置（每次调用都重新读，便于测试改 env）。"""
    load_dotenv()
    data_dir = Path(os.environ.get("COURSE_KB_DATA") or (ROOT / "data"))
    db_path = Path(os.environ.get("COURSE_KB_DB") or (data_dir / "course_kb.sqlite3"))
    return Settings(
        host=os.environ.get("COURSE_KB_HOST", "127.0.0.1"),
        port=_env_int("COURSE_KB_PORT", 8787),
        max_upload_bytes=_env_int("COURSE_KB_MAX_UPLOAD", 1024 * 1024 * 1024),
        data_dir=data_dir,
        db_path=db_path,
        llm_base_url=_env_str(BASE_URL_ENVS),
        llm_api_key=_env_str(API_KEY_ENVS),
        llm_model=_env_str(MODEL_ENVS, DEFAULT_MODEL),
        llm_temperature=_env_float("COURSE_KB_LLM_TEMPERATURE", 0.0),
        llm_max_retries=_env_int("COURSE_KB_LLM_RETRIES", 2),
        llm_timeout_s=_env_float("COURSE_KB_LLM_TIMEOUT", 120.0),
        llm_chunk_chars=_env_int("COURSE_KB_LLM_CHUNK_CHARS", 24_000),
        pdf_max_pages=_env_int("COURSE_KB_PDF_MAX_PAGES", 0),
    )


#: 模块级单例（REST 层直接用；测试用 get_settings() 另建）
settings = get_settings()
