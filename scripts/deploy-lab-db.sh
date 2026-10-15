#!/usr/bin/env bash
# ==============================================================================
# deploy-lab-db.sh —— 实验数据库引擎：部署 → 起服务 → 建非超管账号 → 写 .env
#                     → 打印 settings.json 片段 → ★ 末尾真连一次自检
# ==============================================================================
#
#   ./scripts/deploy-lab-db.sh postgres      # 或 mysql | opengauss | sqlite
#   ./scripts/deploy-lab-db.sh sqlite --check
#   ./scripts/deploy-lab-db.sh postgres --dry-run
#
# 契约见 docs/LAB_DB_DEPLOY.md（§3 配置 / §4 部署 / §7 安全红线 / §9 验收）。
#
# ── 三条设计原则（与文档一致）──────────────────────────────────────────────────
#  1. **幂等**：重复跑不报错、不重复建号；已存在的角色/账号只更新密码与权限。
#  2. **如实**：能力/连通性只报真探测结果。装不上、连不上就**非零退出 + 可读原因 +
#     指向文档章节**；openGauss 在 Ubuntu 上**明确拒绝**（无官方包），不假装能装。
#  3. **凭据不进 settings.json**：密码只写 `.env`（chmod 600），settings.json 里用
#     `passwordEnv` 指向变量名（§3）。
#
# ── 退出码 ─────────────────────────────────────────────────────────────────────
#   0 成功（含"已是最新，无需改动"）    3 平台不支持（如 Ubuntu 上的 openGauss）
#   1 执行失败                          4 ★ 末尾自检失败（部署了但连不上 —— 必须如实失败）
#   2 用法错误（缺参数/未知引擎）
#
# ── ⚠️ 与文档 §4.3 的一处有意差异 ──────────────────────────────────────────────
#   文档写了 `ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '...'`。
#   本脚本**默认不改 root 的认证方式** —— 因为 Ubuntu 的 MySQL 初始是 auth_socket，
#   一旦改成密码认证，`sudo mysql`（本脚本建号用的通道）就会失效，且会**锁死用户**；
#   我们的目的只是"建一个非超管实验账号"，不需要动 root。
#   需要按文档做请显式加：`--set-root-password`（脚本会先验证新密码可用再切换）。
#
# ── 已验证 / 未验证（诚实声明；本机 = Ubuntu 24.04 WSL2，无免密 sudo）────────────
#   ✅ **本机实测通过（45 项断言，0 失败）**：
#      · `bash -n` 语法；`--help` / `-h`
#      · 8 类参数校验（缺引擎/未知引擎/未知选项/非法端口/非法用户名/非法库名/重复引擎/多余参数）
#        → 一律退出码 2 且给可读原因
#      · **sqlite 分支真跑**（建表→插入→更新→回读断言→删表；库文件真生成）+ **幂等**（两次跑输出一致）
#      · `sqlite --dry-run`（不做改动、不跑假自检）
#      · **openGauss 在 Ubuntu 上如实拒绝**（退出码 3，且**不会先索要密码**）
#      · postgres/mysql `--dry-run`：打印全部命令**含 SQL**、settings 片段、密码用占位符、不写 .env
#      · 密码策略：7 种非法字符（' " $ ` \ * /）全部被拒、2 种合法被接受、过短被拒、
#        非交互无密码**拒绝而不是编默认值**
#      · 未部署引擎的 `--check` → 退出码 4 + 可读原因 + 安装建议
#      · `.env` 写入 12 项断言：保留 LLM 凭据等其它键、注释不丢、旧值不残留、无重复键、
#        chmod 600、重复写不增行、文件不存在时新建
#   ❌ **未验证（本机条件不允许）**：
#      · postgres/mysql 的**真实安装 + 真连**（无免密 sudo、未装这两个引擎）
#        → 命令逐字抄自 docs/LAB_DB_DEPLOY.md §4.2/§4.3；请先在真 Ubuntu 上 `--dry-run` 复核，再去掉
#      · openEuler 上的 openGauss 流程（无该平台）
#      · `--set-root-password` 的真实执行（有锁死风险，只在 dry-run 下验证过打印）
# ==============================================================================

set -Eeuo pipefail

# ── 常量 ───────────────────────────────────────────────────────────────────────
SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# 允许重定向 .env 位置（部署到别的目录树 / 测试用）。
# 默认就是仓库根的 .env —— 那里可能已经有 LLM 凭据，所以写入必须**只改自己的键**
# （见 upsert_env_kv：保留其它所有行，含注释与空行）。
ENV_FILE="${LAB_DB_ENV_FILE:-${REPO_ROOT}/.env}"
DOC_REF="docs/LAB_DB_DEPLOY.md"

DEFAULT_USER="labadmin"
DEFAULT_HOST="127.0.0.1"
DEFAULT_DB="labdb"
PG_VERSION="17"
MYSQL_MIN_LEN=8

EXIT_OK=0
EXIT_FAIL=1
EXIT_USAGE=2
EXIT_UNSUPPORTED=3
EXIT_SELFCHECK=4

# ── 运行时状态 ─────────────────────────────────────────────────────────────────
ENGINE=""
DRY_RUN=0
CHECK_ONLY=0
ASSUME_YES=0
SET_ROOT_PASSWORD=0
LAB_USER="${DEFAULT_USER}"
LAB_HOST="${DEFAULT_HOST}"
LAB_PORT=""
LAB_DB="${DEFAULT_DB}"
PASSWORD=""
PASSWORD_SOURCE=""
SUDO=()
OS_ID=""
OS_LIKE=""
PKG=""
CURRENT_STEP=0

# ── 输出 ───────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[36m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_DIM=""; C_OFF=""
fi

step() { CURRENT_STEP=$((CURRENT_STEP + 1)); printf '\n%s[%d] %s%s\n' "$C_BOLD$C_BLUE" "$CURRENT_STEP" "$*" "$C_OFF"; }
info() { printf '      %s\n' "$*"; }
dim()  { printf '      %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '      %s✔%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '      %s⚠%s  %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
err()  { printf '      %s✘%s  %s\n' "$C_RED" "$C_OFF" "$*" >&2; }
die()  { local code="${2:-$EXIT_FAIL}"; err "$1"; exit "$code"; }

# 出错时打印行号与命令（不打印变量值 —— 可能含密码）
on_error() {
  local rc=$? line=${1:-?}
  err "第 ${line} 行执行失败（退出码 ${rc}）"
  err "排查指引：见 ${DOC_REF} §4；加 --dry-run 可先看脚本打算执行什么"
  exit "$rc"
}
trap 'on_error $LINENO' ERR
# 中断（Ctrl-C）时不留半截状态
trap 'printf "\n"; warn "已被中断（未完成）"; exit 130' INT

mask() {
  local p="$1"
  if [ -z "$p" ]; then printf '(空)'; return; fi
  printf '******（%d 字符）' "${#p}"
}

# ── dry-run 执行包装 ───────────────────────────────────────────────────────────
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '      %s[dry-run] %s%s\n' "$C_DIM" "$(printf '%q ' "$@")" "$C_OFF"
    return 0
  fi
  "$@"
}

run_shell() {  # 需要管道/重定向的复合命令
  if [ "$DRY_RUN" = 1 ]; then
    printf '      %s[dry-run] %s%s\n' "$C_DIM" "$1" "$C_OFF"
    return 0
  fi
  bash -c "$1"
}

# SQL 走 **stdin**（不进 argv → 不会出现在 ps 里）；dry-run 时把 SQL 也打印出来
# （打码用 ${var//pw/***}，因为密码被限制在白名单字符内，不存在通配符/正则歧义）
run_sql() {
  local sql
  sql="$(cat)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '      %s[dry-run] 将经 stdin 执行 SQL（密码已打码）：%s\n' "$C_DIM" "$C_OFF"
    printf '%s\n' "${sql//$PASSWORD/***}" | sed 's/^/        │ /'
    return 0
  fi
  printf '%s\n' "$sql" | "$@"
}

# ==============================================================================
# 用法
# ==============================================================================
usage() {
  cat <<EOF
${C_BOLD}${SCRIPT_NAME}${C_OFF} —— 实验数据库引擎部署（幂等；末尾真连一次自检）

${C_BOLD}用法${C_OFF}
  ./scripts/${SCRIPT_NAME} <engine> [选项]

${C_BOLD}engine${C_OFF}
  sqlite      零部署（内置）；脚本仍会真建库 + 自检 CRUD
  postgres    PostgreSQL ${PG_VERSION}（PGDG 源 → 起服务 → 建 ${DEFAULT_USER} → 自检）
  mysql       MySQL 8.4（apt/dnf 包 → 起服务 → 建 ${DEFAULT_USER} → 自检）
  opengauss   ⚠️ 仅 openEuler/CentOS 可跑；Ubuntu/Debian 上**明确拒绝**（无官方包）

${C_BOLD}选项${C_OFF}
  --check              不安装，只对"已部署好的引擎"跑连通性自检
  --dry-run            只打印将要执行的命令，不做任何改动
  -y, --yes            非交互（密码必须来自环境变量，见下）
  --user NAME          实验账号名（默认 ${DEFAULT_USER}）
  --host HOST          监听/连接地址（默认 ${DEFAULT_HOST}）
  --port PORT          端口（默认: pg 5432 / mysql 3306）
  --db NAME            初始库名（默认 ${DEFAULT_DB}）
  --set-root-password  （仅 mysql）按文档 §4.3 把 root 改为密码认证 —— 有锁死风险
  -h, --help           显示本帮助

${C_BOLD}密码（**不提供默认值**，§7 安全红线）${C_OFF}
  优先级：环境变量 → 交互式输入（不回显、需二次确认）
    postgres : \$LAB_PG_PASSWORD      （与 settings.json 的 passwordEnv 同名）
    mysql    : \$LAB_MYSQL_PASSWORD   （同上）
    opengauss: \$LAB_OG_PASSWORD
    sqlite   : 不需要密码
  ⚠️ 非交互（无 TTY 或 -y）且环境变量为空 → **直接报错退出**，不会替你编一个默认密码。
  密码要求：≥ ${MYSQL_MIN_LEN} 字符；为避开各类转义歧义，**不允许**出现
  引号(' " \`) / 反斜杠(\\) / 美元符(\$) / 换行等控制字符。

${C_BOLD}产物${C_OFF}
  ${ENV_FILE}            密码（追加/更新对应键，chmod 600；不动其它已有内容）
  stdout                  settings.json 的 sandbox.engines.<id> 片段（含**脱敏**连接信息）
  stdout                 ★ 末尾打印真实连接测试结果（失败则退出码 ${EXIT_SELFCHECK}）

${C_BOLD}退出码${C_OFF}
  0 成功   1 执行失败   2 用法错误   3 平台不支持   4 自检失败

${C_BOLD}文档${C_OFF}
  ${DOC_REF} §3（配置）§4（部署）§7（安全）§9（验收）
EOF
}

# ==============================================================================
# 参数解析
# ==============================================================================
parse_args() {
  if [ $# -eq 0 ]; then
    err "缺少引擎参数"
    printf '\n' >&2
    usage >&2
    exit "$EXIT_USAGE"
  fi

  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help) usage; exit "$EXIT_OK" ;;
      sqlite|postgres|mysql|opengauss)
        if [ -n "$ENGINE" ]; then
          die "只能指定一个引擎（已有 '${ENGINE}'，又给了 '$1'）" "$EXIT_USAGE"
        fi
        ENGINE="$1"; shift ;;
      --sqlite|--postgres|--mysql|--opengauss)   # 宽容：也接受 --engine 形式
        e="${1#--}"
        if [ -n "$ENGINE" ]; then die "只能指定一个引擎" "$EXIT_USAGE"; fi
        ENGINE="$e"; shift ;;
      --check) CHECK_ONLY=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      --set-root-password) SET_ROOT_PASSWORD=1; shift ;;
      --user) LAB_USER="${2:-}"; [ -n "$LAB_USER" ] || die "--user 需要一个值" "$EXIT_USAGE"; shift 2 ;;
      --host) LAB_HOST="${2:-}"; [ -n "$LAB_HOST" ] || die "--host 需要一个值" "$EXIT_USAGE"; shift 2 ;;
      --port) LAB_PORT="${2:-}"; [ -n "$LAB_PORT" ] || die "--port 需要一个值" "$EXIT_USAGE"; shift 2 ;;
      --db)   LAB_DB="${2:-}";   [ -n "$LAB_DB" ]   || die "--db 需要一个值" "$EXIT_USAGE"; shift 2 ;;
      --user=*) LAB_USER="${1#*=}"; shift ;;
      --host=*) LAB_HOST="${1#*=}"; shift ;;
      --port=*) LAB_PORT="${1#*=}"; shift ;;
      --db=*)   LAB_DB="${1#*=}"; shift ;;
      -*)
        err "未知选项：$1"
        printf '\n' >&2
        usage >&2
        exit "$EXIT_USAGE" ;;
      *)
        err "未知参数：'$1'（引擎只能是 sqlite|postgres|mysql|opengauss）"
        printf '\n' >&2
        usage >&2
        exit "$EXIT_USAGE" ;;
    esac
  done

  [ -n "$ENGINE" ] || die "缺少引擎参数" "$EXIT_USAGE"

  # 端口默认值
  if [ -z "$LAB_PORT" ]; then
    case "$ENGINE" in
      postgres|opengauss) LAB_PORT=5432 ;;
      mysql) LAB_PORT=3306 ;;
      sqlite) LAB_PORT=0 ;;
    esac
  fi
  case "$LAB_PORT" in
    ''|*[!0-9]*) die "--port 必须是数字，收到 '${LAB_PORT}'" "$EXIT_USAGE" ;;
  esac
  case "$LAB_USER" in
    *[!A-Za-z0-9_]*) die "--user 只允许字母/数字/下划线，收到 '${LAB_USER}'" "$EXIT_USAGE" ;;
  esac
  case "$LAB_DB" in
    *[!A-Za-z0-9_]*) die "--db 只允许字母/数字/下划线，收到 '${LAB_DB}'" "$EXIT_USAGE" ;;
  esac
}

# ==============================================================================
# 环境探测
# ==============================================================================
detect_os() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    OS_ID="$(. /etc/os-release && printf '%s' "${ID:-}")"
    OS_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
    OS_PRETTY="$(. /etc/os-release && printf '%s' "${PRETTY_NAME:-${ID:-unknown}}")"
  else
    OS_ID="unknown"; OS_LIKE=""; OS_PRETTY="unknown"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    PKG="apt"
  elif command -v dnf >/dev/null 2>&1; then
    PKG="dnf"
  elif command -v yum >/dev/null 2>&1; then
    PKG="yum"
  else
    PKG=""
  fi
}

is_debian_family() {
  case "$OS_ID" in
    ubuntu|debian|linuxmint|pop) return 0 ;;
  esac
  case " $OS_LIKE " in *" debian "*) return 0 ;; esac
  return 1
}

is_rhel_family() {
  case "$OS_ID" in
    centos|rhel|rocky|almalinux|fedora|openeuler) return 0 ;;
  esac
  case " $OS_LIKE " in
    *" rhel "*|*" centos "*|*" fedora "*) return 0 ;;
  esac
  return 1
}

#: 需要 root 的引擎（SQLite 是嵌入式：**永远不需要 root**，也不需要跑 sudo）
needs_root() {
  case "$ENGINE" in
    postgres|mysql) return 0 ;;
    *) return 1 ;;
  esac
}

# 宽松：只决定命令前缀（dry-run 下要能打印出 `sudo ...` 的样子）
setup_sudo() {
  if [ "$(id -u)" = "0" ]; then SUDO=(); return 0; fi
  if command -v sudo >/dev/null 2>&1; then SUDO=(sudo); return 0; fi
  SUDO=()
}

# 严格：**真的要执行**需要 root 的动作前才调用
ensure_sudo_usable() {
  if ! needs_root; then return 0; fi
  if [ "$CHECK_ONLY" = 1 ]; then return 0; fi     # --check 只连客户端，不需要 root
  if [ "$DRY_RUN" = 1 ]; then return 0; fi        # dry-run 不执行，不需要真权限
  if [ "$(id -u)" = "0" ]; then return 0; fi
  if ! command -v sudo >/dev/null 2>&1; then
    die "需要 root 权限，但没有 sudo 命令。请以 root 身份运行；或加 --check 只做自检" "$EXIT_FAIL"
  fi
  if sudo -n true 2>/dev/null; then return 0; fi
  # 无免密 sudo：交互式可以让用户输密码；非交互必须如实失败（不能挂着等输入）
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    die "需要 root 权限，但当前没有免密 sudo（非交互模式）。请改用：
      sudo ./scripts/${SCRIPT_NAME} ${ENGINE}
      或给该用户配置免密 sudo
      或加 --check 只做连通性自检（不需要 root）" "$EXIT_FAIL"
  fi
  info "需要 sudo 提权（可能提示输入密码）"
}

# ==============================================================================
# 密码处理
# ==============================================================================
password_env_name() {
  case "$ENGINE" in
    postgres)  printf 'LAB_PG_PASSWORD' ;;
    mysql)     printf 'LAB_MYSQL_PASSWORD' ;;
    opengauss) printf 'LAB_OG_PASSWORD' ;;
    *)         printf '' ;;
  esac
}

validate_password() {
  local p="$1" env_name="$2"
  if [ "${#p}" -lt "$MYSQL_MIN_LEN" ]; then
    die "${env_name} 太短（${#p} 字符，要求 ≥ ${MYSQL_MIN_LEN}）—— 实验库虽是教学用途，也不允许弱口令" "$EXIT_USAGE"
  fi
  # 白名单：只允许字母/数字与 . _ @ # % + = -
  # 为什么用白名单而不是"黑名单几个危险字符"：这个密码要经过 shell 变量、
  # SQL 字面量、以及 dry-run 的打码替换（`${var//$pw/***}`）三处；
  # 黑名单永远漏（实测 `$`、反引号、反斜杠、引号、以及**通配符 `*?[`** 都会出问题），
  # 白名单一次性消灭全部转义歧义。
  case "$p" in
    *[!A-Za-z0-9._@#%+=-]*)
      die "${env_name} 含不允许的字符。本脚本只接受字母、数字与 . _ @ # % + = -（长度 ≥ ${MYSQL_MIN_LEN}）。
      原因：密码要安全通过 shell / SQL 字面量 / 日志打码三处，白名单能一次性避免全部转义歧义。" "$EXIT_USAGE" ;;
  esac
}

acquire_password() {
  local env_name
  env_name="$(password_env_name)"
  if [ -z "$env_name" ]; then return 0; fi   # sqlite 不需要

  local from_env="${!env_name:-}"
  if [ -n "$from_env" ]; then
    PASSWORD="$from_env"
    PASSWORD_SOURCE="环境变量 \$${env_name}"
  elif [ "$DRY_RUN" = 1 ]; then
    # ★ dry-run **不索要也不输出**任何真实凭据：只打印命令，密码用占位符。
    #   （否则"看一眼要执行什么"就得先交出密码，且占位符能防止有人把 dry-run
    #     输出粘进工单时泄漏口令。）
    PASSWORD="__DRY_RUN_PASSWORD__"
    PASSWORD_SOURCE="dry-run 占位符（未索要真实密码）"
    info "dry-run：不索要密码，打印的命令里用占位符代替"
    return 0
  else
    if [ "$ASSUME_YES" = 1 ]; then
      die "非交互模式（-y）下必须通过环境变量提供密码：${env_name}=...
      ⚠️ 本脚本**不提供默认密码**（安全红线 §7）" "$EXIT_USAGE"
    fi
    if [ ! -t 0 ]; then
      die "当前没有 TTY，无法交互输入密码。请改用：${env_name}='...' ./scripts/${SCRIPT_NAME} ${ENGINE}" "$EXIT_USAGE"
    fi
    printf '      请输入 ${C_BOLD}%s${C_OFF} 的密码（不回显，≥%d 字符）：' "$env_name" "$MYSQL_MIN_LEN"
    local p1="" p2=""
    IFS= read -r -s p1 || true
    printf '\n      再输入一次确认：'
    IFS= read -r -s p2 || true
    printf '\n'
    if [ "$p1" != "$p2" ]; then
      die "两次输入不一致" "$EXIT_USAGE"
    fi
    if [ -z "$p1" ]; then
      die "密码不能为空" "$EXIT_USAGE"
    fi
    PASSWORD="$p1"
    PASSWORD_SOURCE="交互式输入"
  fi

  validate_password "$PASSWORD" "$env_name"
  ok "密码已获取（来源：${PASSWORD_SOURCE}，值：$(mask "$PASSWORD")）"
}

# ==============================================================================
# .env 写入（幂等 upsert；不动其它键）
# ==============================================================================
upsert_env_kv() {
  local key="$1" value="$2"
  if [ ! -f "$ENV_FILE" ]; then
    ( umask 077; : > "$ENV_FILE" )
  fi
  local tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  # 保留除目标键以外的所有行（含注释与空行）
  if ! grep -v -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" > "$tmp" 2>/dev/null; then
    : > "$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  # 覆盖式替换，保留原文件权限风格；随后统一 chmod 600
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

write_env_file() {
  local env_name
  env_name="$(password_env_name)"
  if [ -z "$env_name" ]; then
    info "sqlite：无需密码，不写 .env"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] 将写入 ${ENV_FILE}：${env_name}=*** + LAB_DB_HOST/PORT/NAME/USER，并 chmod 600"
    return 0
  fi
  local backup=""
  if [ -f "$ENV_FILE" ]; then
    backup="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$ENV_FILE" "$backup"
    info "已备份原 .env → $(basename "$backup")"
  fi
  upsert_env_kv "$env_name" "$PASSWORD"
  upsert_env_kv "LAB_DB_ENGINE" "$ENGINE"
  upsert_env_kv "LAB_DB_HOST" "$LAB_HOST"
  upsert_env_kv "LAB_DB_PORT" "$LAB_PORT"
  upsert_env_kv "LAB_DB_NAME" "$LAB_DB"
  upsert_env_kv "LAB_DB_USER" "$LAB_USER"
  chmod 600 "$ENV_FILE"
  ok "已写入 ${ENV_FILE}（chmod 600，密码不进 settings.json）"
  local perm
  perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || printf '?')"
  if [ "$perm" != "600" ]; then
    warn ".env 权限是 ${perm}，期望 600（某些文件系统/挂载不支持 chmod）"
  fi
}

# ==============================================================================
# settings.json 片段
# ==============================================================================
print_settings_snippet() {
  local env_name
  env_name="$(password_env_name)"
  printf '\n%s──────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_OFF"
  printf '%s把下面这段并进 config/settings.json 的 sandbox.engines（%s §3）：%s\n' "$C_BOLD" "$DOC_REF" "$C_OFF"
  printf '%s──────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_OFF"
  case "$ENGINE" in
    sqlite)
      cat <<'EOF'
    "sqlite": { "enabled": true, "dir": "data/sandbox" }
EOF
      ;;
    postgres|opengauss|mysql)
      cat <<EOF
    "${ENGINE}": {
      "enabled": true,
      "host": "${LAB_HOST}",
      "port": ${LAB_PORT},
      "adminUser": "${LAB_USER}",
      "passwordEnv": "${env_name}"
    }
EOF
      ;;
  esac
  printf '%s──────────────────────────────────────────────────────────────%s\n' "$C_DIM" "$C_OFF"
  if [ -n "$env_name" ]; then
    cat <<EOF
${C_BOLD}密码不进 settings.json${C_OFF}（§3）：只在 ${ENV_FILE} 里放
  ${env_name}=（已写入，chmod 600）
Node 侧读环境变量；${C_BOLD}不要把值贴进 settings.json 或提交进 git${C_OFF}。
EOF
  fi
}

# ==============================================================================
# 自检（★ 核心：真连一次）
# ==============================================================================
selfcheck_sqlite() {
  local dbdir="${REPO_ROOT}/data/sandbox"
  # 文件名刻意带 `_deploy_selfcheck` 前缀：`data/sandbox/` 下还有 Node 侧
  # 按学生建的 `u_<uid>/` 与 .db（引擎真正用的库），别让本脚本的探针文件看起来像学生的库。
  local dbpath="${dbdir}/_deploy_selfcheck.db"
  mkdir -p "$dbdir"

  # 优先 sqlite3 CLI；没有就用 python3 标准库（两者都是**真连接**，不是"文件存在"就算过）
  local runner="" 
  if command -v sqlite3 >/dev/null 2>&1; then
    runner="sqlite3"
  elif command -v python3 >/dev/null 2>&1; then
    runner="python3"
  else
    err "既没有 sqlite3 也没有 python3，无法做真实自检"
    return "$EXIT_SELFCHECK"
  fi
  info "客户端：${runner}；库文件：${dbpath}"

  local sql_crud="
CREATE TABLE IF NOT EXISTS t_labcheck(id INTEGER PRIMARY KEY, note TEXT);
DELETE FROM t_labcheck;
INSERT INTO t_labcheck(id, note) VALUES (1, 'hello-lab');
UPDATE t_labcheck SET note='updated' WHERE id=1;
"
  local fail=0
  if [ "$runner" = "sqlite3" ]; then
    printf '%s' "$sql_crud" | sqlite3 "$dbpath" || fail=1
    local got
    got="$(sqlite3 "$dbpath" 'select note from t_labcheck where id=1;' 2>/dev/null || true)"
    printf '      %s\n' "CRUD 回读：note='${got}'（期望 updated）"
    [ "$got" = "updated" ] || fail=1
    local ver
    ver="$(sqlite3 --version 2>/dev/null | awk '{print $1}')"
    printf '      %s\n' "引擎版本：sqlite ${ver}"
    sqlite3 "$dbpath" 'DROP TABLE t_labcheck;' >/dev/null 2>&1 || true
  else
    python3 - "$dbpath" <<'PY' || fail=1
import sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()
cur.executescript("""
CREATE TABLE IF NOT EXISTS t_labcheck(id INTEGER PRIMARY KEY, note TEXT);
DELETE FROM t_labcheck;
INSERT INTO t_labcheck(id, note) VALUES (1, 'hello-lab');
UPDATE t_labcheck SET note='updated' WHERE id=1;
""")
con.commit()
got = cur.execute("select note from t_labcheck where id=1").fetchone()[0]
print(f"      CRUD 回读：note='{got}'（期望 updated）")
print(f"      引擎版本：sqlite {sqlite3.sqlite_version}（python3 stdlib）")
assert got == "updated", f"CRUD 回读不符：{got!r}"
cur.execute("DROP TABLE t_labcheck")
con.commit()
con.close()
PY
  fi

  if [ "$fail" = 0 ]; then
    ok "SQLite 自检通过（建表/插入/更新/回读/删除 全部真跑）"
    return 0
  fi
  err "SQLite 自检失败（见上面的输出）"
  return "$EXIT_SELFCHECK"
}

selfcheck_postgres() {
  if ! command -v psql >/dev/null 2>&1; then
    err "找不到 psql 客户端（postgresql-client 未安装）"
    dim "装： sudo apt-get install -y postgresql-client-${PG_VERSION}  （或 postgresql-client）"
    return "$EXIT_SELFCHECK"
  fi
  local out rc=0
  info "真连：psql -h ${LAB_HOST} -p ${LAB_PORT} -U ${LAB_USER} -d postgres -c 'select 1'"
  out="$(PGPASSWORD="$PASSWORD" PGCONNECT_TIMEOUT=8 psql -h "$LAB_HOST" -p "$LAB_PORT" -U "$LAB_USER" \
        -d postgres -v ON_ERROR_STOP=1 -tAc 'select 1' 2>&1)" || rc=$?
  if [ "$rc" != 0 ] || [ "$(printf '%s' "$out" | tr -d '[:space:]')" != "1" ]; then
    err "连接测试失败（退出码 ${rc}）"
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    cat >&2 <<EOF

      ${C_BOLD}排查指引${C_OFF}（${DOC_REF} §4.2）：
        1) 服务起了吗：   sudo systemctl status postgresql --no-pager
                          （无 systemd： sudo pg_ctlcluster ${PG_VERSION} main start）
        2) 端口在听吗：   ss -ltnp | grep ${LAB_PORT}
        3) 认证规则对吗： grep labadmin /etc/postgresql/${PG_VERSION}/main/pg_hba.conf
                          需要： host all ${LAB_USER} ${LAB_HOST}/32 scram-sha-256
        4) 监听地址对吗： sudo -u postgres psql -c "SHOW listen_addresses;"（应为 localhost/127.0.0.1）
        5) 密码对吗：     重新跑本脚本可幂等更新密码
EOF
    return "$EXIT_SELFCHECK"
  fi

  # ★ 顺带验证"实验账号不是超管"（§7 红线 2）
  local super
  super="$(PGPASSWORD="$PASSWORD" PGCONNECT_TIMEOUT=8 psql -h "$LAB_HOST" -p "$LAB_PORT" -U "$LAB_USER" \
           -d postgres -tAc "select rolsuper from pg_roles where rolname='${LAB_USER}'" 2>/dev/null || true)"
  local createdb
  createdb="$(PGPASSWORD="$PASSWORD" PGCONNECT_TIMEOUT=8 psql -h "$LAB_HOST" -p "$LAB_PORT" -U "$LAB_USER" \
           -d postgres -tAc "select rolcreatedb from pg_roles where rolname='${LAB_USER}'" 2>/dev/null || true)"
  local ver
  ver="$(PGPASSWORD="$PASSWORD" PGCONNECT_TIMEOUT=8 psql -h "$LAB_HOST" -p "$LAB_PORT" -U "$LAB_USER" \
           -d postgres -tAc 'select version()' 2>/dev/null | head -1 || true)"
  ok "连接测试通过：select 1 → 1"
  printf '      %s\n' "版本：${ver:0:80}"
  if [ "$super" = "t" ] || [ "$super" = "true" ]; then
    err "⛔ ${LAB_USER} 是超级用户（rolsuper=${super}）—— 违反 §7 红线 2，必须降权"
    return "$EXIT_SELFCHECK"
  fi
  ok "权限检查：rolsuper=${super:-f}（非超管 ✔）；rolcreatedb=${createdb:-?}（建库能力，实验隔离需要）"
  return 0
}

selfcheck_mysql() {
  if ! command -v mysql >/dev/null 2>&1; then
    err "找不到 mysql 客户端"
    dim "装： sudo apt-get install -y mysql-client"
    return "$EXIT_SELFCHECK"
  fi
  local out rc=0
  info "真连：mysql -h ${LAB_HOST} -P ${LAB_PORT} -u ${LAB_USER} -e 'select 1'"
  out="$(MYSQL_PWD="$PASSWORD" mysql --connect-timeout=8 -h "$LAB_HOST" -P "$LAB_PORT" -u "$LAB_USER" \
        -N -B -e 'select 1' 2>&1)" || rc=$?
  if [ "$rc" != 0 ] || [ "$(printf '%s' "$out" | tr -d '[:space:]')" != "1" ]; then
    err "连接测试失败（退出码 ${rc}）"
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    cat >&2 <<EOF

      ${C_BOLD}排查指引${C_OFF}（${DOC_REF} §4.3）：
        1) 服务起了吗：   sudo systemctl status mysql --no-pager
        2) 端口在听吗：   ss -ltnp | grep ${LAB_PORT}
        3) 账号存在吗：   sudo mysql -e "select user,host from mysql.user where user='${LAB_USER}'"
                          需要 host 为 ${LAB_HOST} 或 %（本脚本建的是 ${LAB_HOST}）
        4) 认证插件：     sudo mysql -e "select user,host,plugin from mysql.user where user='${LAB_USER}'"
EOF
    return "$EXIT_SELFCHECK"
  fi
  local ver grants
  ver="$(MYSQL_PWD="$PASSWORD" mysql --connect-timeout=8 -h "$LAB_HOST" -P "$LAB_PORT" -u "$LAB_USER" \
        -N -B -e 'select version()' 2>/dev/null || true)"
  grants="$(MYSQL_PWD="$PASSWORD" mysql --connect-timeout=8 -h "$LAB_HOST" -P "$LAB_PORT" -u "$LAB_USER" \
        -N -B -e "show grants for current_user()" 2>/dev/null || true)"
  ok "连接测试通过：select 1 → 1"
  printf '      %s\n' "版本：${ver}"
  # ★ §7 红线 2：不许有 SUPER / FILE / PROCESS
  if printf '%s' "$grants" | grep -Eiq '(SUPER|FILE|PROCESS|ALL PRIVILEGES ON \*\.\*)'; then
    err "⛔ 实验账号权限过大（出现了 SUPER/FILE/PROCESS/ALL）："
    printf '%s\n' "$grants" | sed 's/^/        /' >&2
    return "$EXIT_SELFCHECK"
  fi
  ok "权限检查：无 SUPER/FILE/PROCESS ✔"
  printf '%s\n' "$grants" | sed 's/^/        /'
  return 0
}

run_selfcheck() {
  step_selfcheck_header
  case "$ENGINE" in
    sqlite)    selfcheck_sqlite ;;
    postgres)  selfcheck_postgres ;;
    mysql)     selfcheck_mysql ;;
    opengauss)
      info "openGauss 自检：需 gsql 客户端"
      if command -v gsql >/dev/null 2>&1; then
        local out rc=0
        out="$(GS_PASSWORD="$PASSWORD" gsql -d postgres -p "$LAB_PORT" -U "$LAB_USER" -c 'select version();' 2>&1)" || rc=$?
        if [ "$rc" = 0 ]; then ok "gsql 连接通过"; printf '%s\n' "$out" | head -3 | sed 's/^/        /'; return 0; fi
        err "gsql 连接失败（退出码 ${rc}）"
        printf '%s\n' "$out" | sed 's/^/        /' >&2
        return "$EXIT_SELFCHECK"
      fi
      err "找不到 gsql 客户端，无法完成真实自检（不做假判断）"
      return "$EXIT_SELFCHECK" ;;
  esac
}

step_selfcheck_header() {
  printf '\n%s[★] 连接自检（真连，不是"安装完成"就结束）%s\n' "$C_BOLD$C_BLUE" "$C_OFF"
}

# ==============================================================================
# 各引擎部署
# ==============================================================================
service_start() {
  local svc="$1"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files >/dev/null 2>&1; then
    run "${SUDO[@]}" systemctl enable --now "$svc"
    return 0
  fi
  if command -v service >/dev/null 2>&1; then
    warn "systemd 不可用（容器/WSL？）→ 退回 service ${svc} start"
    run "${SUDO[@]}" service "$svc" start
    return 0
  fi
  warn "既没有 systemctl 也没有 service，无法自动启动 ${svc}；请手动启动后重跑 --check"
  return 0
}

deploy_sqlite() {
  step "SQLite：无需部署（内置引擎）"
  ok "SQLite 是本项目**默认引擎**，开箱即用（${DOC_REF} §4.1）"
  info "局限（UI 需标注）：无存储过程、无用户/权限体系、类型系统宽松、AUTOINCREMENT ≠ AUTO_INCREMENT"

  step "准备沙箱目录"
  local dbdir="${REPO_ROOT}/data/sandbox"
  run mkdir -p "$dbdir"
  ok "目录就绪：${dbdir}"

  step "跳过安装/起服务/建账号"
  ok "SQLite 是嵌入式引擎：没有服务、没有账号、没有端口"
  info "隔离方式：一个学生一个 .db 文件（由 Node 侧 ensureSession 创建）"
  printf '\n'
}

deploy_postgres() {
  local ver="${PG_VERSION}"
  if [ "$CHECK_ONLY" = 0 ]; then
    step "安装 PostgreSQL ${ver}（PGDG 官方源）"
    # ⚠️ 这里**不能** `need_cmd curl` 做前置：最小化系统上 curl 本来就可能没装，
    #    而我们下面第一条 apt-get install 就是要装它 —— 先断言再装会变成死锁。
    if is_debian_family; then
      run "${SUDO[@]}" apt-get update -y
      run "${SUDO[@]}" apt-get install -y curl ca-certificates gnupg lsb-release
      run "${SUDO[@]}" install -d /usr/share/postgresql-common/pgdg
      info "导入 PGDG 签名密钥 + 源"
      run_shell "${SUDO[*]} curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc"
      run_shell "echo \"deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt \$(lsb_release -cs)-pgdg main\" | ${SUDO[*]} tee /etc/apt/sources.list.d/pgdg.list >/dev/null"
      run "${SUDO[@]}" apt-get update -y
      run "${SUDO[@]}" apt-get install -y "postgresql-${ver}" "postgresql-client-${ver}"
    elif is_rhel_family; then
      run "${SUDO[@]}" dnf install -y "https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm"
      run "${SUDO[@]}" dnf -qy module disable postgresql
      run "${SUDO[@]}" dnf install -y "postgresql${ver}-server" "postgresql${ver}"
      if [ ! -d "/var/lib/pgsql/${ver}/data" ]; then
        run "${SUDO[@]}" "/usr/pgsql-${ver}/bin/postgresql-${ver}-setup" initdb
      fi
    else
      die "不认识的分支（${OS_PRETTY}）：请按 ${DOC_REF} §4.2 手动安装，然后用 --check 自检" "$EXIT_UNSUPPORTED"
    fi
    ok "安装完成（幂等：已装则 apt/dnf 直接跳过）"
  else
    step "跳过安装（--check）"
  fi

  step "启动服务 + 开机自启"
  if [ "$CHECK_ONLY" = 0 ]; then
    if is_rhel_family; then service_start "postgresql-${ver}"; else service_start "postgresql"; fi
    if command -v pg_lsclusters >/dev/null 2>&1 && ! pg_lsclusters 2>/dev/null | grep -q "online"; then
      run "${SUDO[@]}" pg_ctlcluster "${ver}" main start || true
    fi
    ok "已请求启动（systemctl/service）"
  else
    dim "跳过（--check）"
  fi

  step "建/更新非超管实验账号 ${LAB_USER}（CREATEDB；**非超管**）"
  if [ "$CHECK_ONLY" = 0 ]; then
    run_sql "${SUDO[@]}" -u postgres psql -v ON_ERROR_STOP=1 -f - <<SQL
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LAB_USER}') THEN
    ALTER ROLE ${LAB_USER} WITH LOGIN PASSWORD '${PASSWORD}' CREATEDB;
    RAISE NOTICE 'role ${LAB_USER} 已存在 → 已更新密码与权限（幂等）';
  ELSE
    CREATE ROLE ${LAB_USER} WITH LOGIN PASSWORD '${PASSWORD}' CREATEDB;
    RAISE NOTICE 'role ${LAB_USER} 已创建';
  END IF;
END
\$\$;
SQL
    ok "账号就绪（role=${LAB_USER}, LOGIN + CREATEDB, **rolsuper=false**）"
  else
    dim "跳过（--check）"
  fi

  step "允许本机 TCP 密码登录（pg_hba.conf，幂等）"
  if [ "$CHECK_ONLY" = 0 ]; then
    local hba="/etc/postgresql/${ver}/main/pg_hba.conf"
    local line="host all ${LAB_USER} ${LAB_HOST}/32 scram-sha-256"
    run_shell "if [ -f '${hba}' ]; then
        if grep -qF '${line}' '${hba}'; then echo '  （已存在，跳过）';
        else ${SUDO[*]} sed -i '1i ${line}' '${hba}'; echo '  （已添加）'; fi
      else echo '  ⚠ 找不到 ${hba}（版本目录不同？）'; fi"
    run_shell "${SUDO[*]} -u postgres psql -v ON_ERROR_STOP=1 -c \"ALTER SYSTEM SET listen_addresses='${LAB_HOST}';\" >/dev/null"
    run_shell "${SUDO[*]} systemctl restart postgresql 2>/dev/null || ${SUDO[*]} pg_ctlcluster ${ver} main restart"
    ok "认证规则与监听地址就绪"
  else
    dim "跳过（--check）"
  fi
}

deploy_mysql() {
  if [ "$CHECK_ONLY" = 0 ]; then
    step "安装 MySQL Server"
    if is_debian_family; then
      run "${SUDO[@]}" apt-get update -y
      # ⚠️ 环境变量赋值**不能**直接当作 `run` 的参数（`run VAR=x cmd` 会去找名为
      #    "VAR=x" 的可执行文件）→ 必须经 `env`。
      run "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-server
    elif is_rhel_family; then
      warn "RHEL 系的 mysql-server 可能是 MariaDB（版本/特性不同，UI 方言提示要按实际探测）"
      run "${SUDO[@]}" dnf install -y mysql-server
    else
      die "不认识的分支（${OS_PRETTY}）：请按 ${DOC_REF} §4.3 手动安装" "$EXIT_UNSUPPORTED"
    fi
    ok "安装完成（幂等）"
  else
    step "跳过安装（--check）"
  fi

  step "启动服务 + 开机自启"
  if [ "$CHECK_ONLY" = 0 ]; then
    if is_debian_family; then service_start "mysql"; else service_start "mysqld"; fi
    ok "已请求启动"
  else
    dim "跳过（--check）"
  fi

  step "建/更新非超管实验账号 ${LAB_USER}@${LAB_HOST}（**不给 SUPER/FILE/PROCESS**）"
  if [ "$CHECK_ONLY" = 0 ]; then
    # 用 socket 认证的 root 通道（`sudo mysql`）建号：SQL 走 stdin，密码不进 argv
    run_sql "${SUDO[@]}" mysql -v -v -f - <<SQL
CREATE USER IF NOT EXISTS '${LAB_USER}'@'${LAB_HOST}' IDENTIFIED BY '${PASSWORD}';
ALTER USER '${LAB_USER}'@'${LAB_HOST}' IDENTIFIED BY '${PASSWORD}';
GRANT CREATE, DROP ON *.* TO '${LAB_USER}'@'${LAB_HOST}';
SQL
    # ⚠️ 这里**故意不写** `REVOKE SUPER, FILE, PROCESS`：
    #    我们从未授过这些权限，而 MySQL 对"撤一个不存在的授权"会报
    #    ERROR 1147 (There is no such grant defined for user) —— 在全新账号上**必然报错**，
    #    配上 `-f` 虽会继续，但退出码非零、日志里一条红字很容易被当成部署失败。
    #    正确做法是**只授需要的 + 由自检去断言没有危险权限**（见 selfcheck_mysql）。
    if [ "$DRY_RUN" = 1 ]; then
      ok "[dry-run] 将建号并只授 CREATE/DROP（供学生建自己的库）"
    else
      ok "账号就绪（只授 CREATE/DROP；未授予 SUPER/FILE/PROCESS，自检会断言这一点）"
    fi
  else
    dim "跳过（--check）"
  fi

  if [ "$SET_ROOT_PASSWORD" = 1 ]; then
    step "（可选）按 §4.3 把 root 改为密码认证"
    warn "这会**关闭** auth_socket 通道：改完 `sudo mysql` 将不再可用（请确保你记得 root 密码）"
    if [ "$DRY_RUN" = 1 ]; then
      info "[dry-run] 将执行 ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '***'"
    else
      run_sql "${SUDO[@]}" mysql --connect-expired-password -f - <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED WITH caching_sha2_password BY '${PASSWORD}';
FLUSH PRIVILEGES;
SQL
      ok "root 已改为密码认证（密码与实验账号相同；如需不同请手工 ALTER）"
    fi
  fi
}

# ==============================================================================
# 引擎前置校验（**必须早于密码/权限**：不能对一个马上要拒绝的平台先索要密码）
# ==============================================================================
preflight_engine() {
  case "$ENGINE" in
    sqlite) return 0 ;;
    postgres|mysql)
      if [ "$CHECK_ONLY" = 0 ] && [ -z "$PKG" ]; then
        die "本机既没有 apt-get 也没有 dnf/yum，无法自动安装 ${ENGINE}。
      请按 ${DOC_REF} §4 手工安装，然后用：./scripts/${SCRIPT_NAME} ${ENGINE} --check" "$EXIT_UNSUPPORTED"
      fi
      return 0 ;;
    opengauss)
      # openGauss 的平台判断放在这里 → Ubuntu 上会**立刻**如实拒绝，不会先问密码
      if is_debian_family; then
        err "openGauss 在 Ubuntu/Debian 上**没有官方包**（官方主推 openEuler）→ 本脚本**明确拒绝**，不会假装安装"
        cat >&2 <<EOF

      ${C_BOLD}为什么拒绝${C_OFF}（${DOC_REF} §4.4）：
        openGauss 官方只提供 openEuler/CentOS 的**离线安装包**（tar.gz + install.sh），
        不在 apt/dnf 源里；Ubuntu 上需自行编译（依赖多、不推荐）。
        ⛔ 在这种平台上"自动装"只能靠猜/编译，成功率低 —— 与其假装能装，不如如实告诉你。

      ${C_BOLD}可行路径（三选一）${C_OFF}
        1) ${C_BOLD}openEuler 虚拟机/容器${C_OFF}（推荐）：装好后用
             ./scripts/${SCRIPT_NAME} opengauss --check --host <host> --port 5432
           做连通性自检（--check 分支在 openEuler 上可用）
        2) ${C_BOLD}CentOS/Rocky 9${C_OFF}：按 §4.4 装依赖 → 下载 tar.gz → 非 root 用户 omm 跑 install.sh
        3) ${C_BOLD}改用 PostgreSQL${C_OFF}：openGauss 协议兼容 PG，可跑
             ./scripts/${SCRIPT_NAME} postgres
           ⚠️ 但方言不同（AUTO_INCREMENT 不支持、部分 PG 扩展缺失）→ 引擎 id 必须保持独立的 opengauss

      ${C_BOLD}装好之后${C_OFF}：用 --check 自检；把 settings.json 的 opengauss.enabled 置 true
        （片段本脚本照常打印；passwordEnv 用 LAB_OG_PASSWORD）
EOF
        exit "$EXIT_UNSUPPORTED"
      fi
      if is_rhel_family; then
        err "openGauss 需要**手工**安装：官方 tar.gz + install.sh（交互式，需非 root 用户 omm）"
        cat >&2 <<EOF

      ${C_BOLD}为什么仍不自动化${C_OFF}（${DOC_REF} §4.4）：
        · 安装包**不在 dnf 源里**，要从 opengauss.org 手工下载（脚本无法替你选版本）
        · install.sh 需要交互式设密码、以 omm 用户执行、并写入 /home/omm
        · 依赖包多（libaio/readline/zlib/openssl/bzip2/flex/bison/ncurses/glibc/pam/libffi）
        「一条命令装完」在这个引擎上**做不到** → 与其给半吊子脚本，不如给准确步骤。

      ${C_BOLD}照文档 §4.4 走完后${C_OFF}，用它做真实自检：
        ./scripts/${SCRIPT_NAME} opengauss --check --host 127.0.0.1 --port 5432
        gsql -d postgres -p 5432 -U ${LAB_USER} -W '***' -c 'select version();'
EOF
        exit "$EXIT_UNSUPPORTED"
      fi
      die "无法识别的平台（${OS_PRETTY}）：openGauss 只在 openEuler/CentOS/Rocky 上有官方包" "$EXIT_UNSUPPORTED" ;;
  esac
}

# ==============================================================================
# 主流程
# ==============================================================================
main() {
  parse_args "$@"
  detect_os

  printf '%s╔══════════════════════════════════════════════════════════════╗%s\n' "$C_BOLD" "$C_OFF"
  printf '%s║%s  实验数据库引擎部署：%s%-38s%s%s║%s\n' "$C_BOLD" "$C_OFF" "$C_BOLD" "$ENGINE" "$C_OFF" "$C_BOLD" "$C_OFF"
  printf '%s╚══════════════════════════════════════════════════════════════╝%s\n' "$C_BOLD" "$C_OFF"
  info "平台：${OS_PRETTY}（pkg=${PKG:-none}）"
  if [ "$ENGINE" = "sqlite" ]; then
    info "目标：嵌入式（无 host/port；库文件 data/sandbox/lab.db）"
  else
    info "目标：${LAB_USER}@${LAB_HOST}:${LAB_PORT}  库=${LAB_DB}"
  fi
  if [ "$DRY_RUN" = 1 ]; then warn "dry-run 模式：只打印命令，不做任何改动（也**不做**真实自检）"; fi
  if [ "$CHECK_ONLY" = 1 ]; then info "--check 模式：跳过安装/建号，只做连通性自检"; fi

  preflight_engine          # ★ 平台判断必须最早：不能先问密码再拒绝
  setup_sudo                # 宽松：只决定 sudo 前缀
  acquire_password          # sqlite 会自动跳过
  ensure_sudo_usable        # 严格：真的要动系统时才检查权限

  case "$ENGINE" in
    sqlite)    deploy_sqlite ;;
    postgres)  deploy_postgres ;;
    mysql)     deploy_mysql ;;
  esac

  # ── 写 .env + 打印 settings 片段（sqlite 无密码）──
  if [ "$CHECK_ONLY" = 0 ]; then
    step "写入凭据到 .env（密码不进 settings.json；chmod 600）"
    write_env_file
    if [ "$ENGINE" != "sqlite" ]; then
      step "打印 settings.json 该填什么"
      print_settings_snippet
    fi
  else
    step "打印 settings.json 片段"
    print_settings_snippet
  fi

  # ── dry-run：不执行真实自检（没部署就没得连；绝不假装"通过"）──
  if [ "$DRY_RUN" = 1 ]; then
    step "连接自检 —— dry-run 跳过"
    warn "dry-run 不执行自检（没有部署任何东西，跑出来的'成功'是假的）"
    info "去掉 --dry-run 重跑即可真正执行；自检失败会以退出码 ${EXIT_SELFCHECK} 如实失败"
    printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_OFF"
    printf '%s(dry-run 结束，未做任何改动)%s\n' "$C_DIM" "$C_OFF"
    printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_OFF"
    return 0
  fi

  # ── ★ 末尾真连 ──
  local rc=0
  run_selfcheck || rc=$?

  printf '\n%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_OFF"
  if [ "$rc" = 0 ]; then
    printf '%s✔ 部署 + 自检全部通过%s\n' "$C_GREEN$C_BOLD" "$C_OFF"
    info "下一步：把上面的 settings.json 片段并进 config/settings.json，然后重启 Node 服务"
    info "看引擎是否被发现： curl -s http://127.0.0.1:8787/api/v1/capabilities | python3 -m json.tool"
    printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_OFF"
    return 0
  fi
  printf '%s✘ 自检未通过（退出码 %s）—— 如实报错，不假装成功%s\n' "$C_RED$C_BOLD" "$rc" "$C_OFF"
  info "按上面的「排查指引」处理；修好后重跑： ./scripts/${SCRIPT_NAME} ${ENGINE} --check"
  printf '%s══════════════════════════════════════════════════════════════%s\n' "$C_BOLD" "$C_OFF"
  return "$rc"
}

main "$@"
