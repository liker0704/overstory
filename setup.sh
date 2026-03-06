#!/bin/bash
set -euo pipefail

# ─── Overstory Setup ─────────────────────────────────────────────────────────
# Устанавливает os-eco ecosystem: overstory, mulch, canopy, seeds
# Использование:
#   ./setup.sh                           базовая установка
#   ./setup.sh --docker                  + Docker сборка
#   ./setup.sh --github-user=myuser      клонирует из github.com/myuser/*
# ─────────────────────────────────────────────────────────────────────────────

PROJECTS_DIR="${PROJECTS_DIR:-$HOME/projects}"
GITHUB_USER="${GITHUB_USER:-liker0704}"
DOCKER_MODE=false
SKIP_INSTALL=false

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

# ─── Parse args ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case $arg in
    --docker)            DOCKER_MODE=true ;;
    --github-user=*)     GITHUB_USER="${arg#*=}" ;;
    --projects-dir=*)    PROJECTS_DIR="${arg#*=}" ;;
    --skip-install)      SKIP_INSTALL=true ;;
    --help|-h)
      echo "Usage: $0 [--docker] [--github-user=USER] [--projects-dir=DIR] [--skip-install]"
      exit 0
      ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Overstory Setup"
echo "  Projects: $PROJECTS_DIR"
echo "  GitHub:   $GITHUB_USER"
echo "  Docker:   $DOCKER_MODE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ─── 1. Системные зависимости ────────────────────────────────────────────────
info "Проверка системных зависимостей..."

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 найден: $(command -v "$1")"
    return 0
  else
    return 1
  fi
}

install_if_missing() {
  local cmd="$1"
  local install_hint="$2"

  if check_cmd "$cmd"; then
    return 0
  fi

  warn "$cmd не найден, пробую установить..."

  case "$cmd" in
    bun)
      curl -fsSL https://bun.sh/install | bash
      export PATH="$HOME/.bun/bin:$PATH"
      ;;
    tmux)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq tmux
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm tmux
      elif command -v brew &>/dev/null; then
        brew install tmux
      else
        fail "Не могу установить tmux автоматически. Установи вручную: $install_hint"
      fi
      ;;
    git)
      if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq git
      elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm git
      elif command -v brew &>/dev/null; then
        brew install git
      else
        fail "Не могу установить git автоматически."
      fi
      ;;
    node)
      if command -v bun &>/dev/null; then
        warn "Node.js не обязателен при наличии bun, пропускаю"
        return 0
      fi
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
      sudo apt-get install -y nodejs
      ;;
    *)
      fail "Неизвестная зависимость: $cmd. $install_hint"
      ;;
  esac

  if check_cmd "$cmd"; then
    ok "$cmd установлен"
  else
    fail "Не удалось установить $cmd"
  fi
}

install_if_missing git "https://git-scm.com/downloads"
install_if_missing bun "https://bun.sh"
install_if_missing tmux "sudo apt install tmux / brew install tmux"
echo ""

# ─── 2. Клонирование форков ──────────────────────────────────────────────────
info "Проверка репозиториев..."
mkdir -p "$PROJECTS_DIR"

clone_if_missing() {
  local name="$1"
  local repo="$2"
  local target="$PROJECTS_DIR/$name"

  if [ -d "$target" ]; then
    ok "$name уже существует: $target"
    return 0
  fi

  info "Клонирую $repo → $target"
  git clone "https://github.com/$repo.git" "$target"
  ok "$name клонирован"
}

clone_if_missing overstory "$GITHUB_USER/overstory"
clone_if_missing mulch     "$GITHUB_USER/mulch"
clone_if_missing canopy    "$GITHUB_USER/canopy"
echo ""

# ─── 3. Установка зависимостей ───────────────────────────────────────────────
if [ "$SKIP_INSTALL" = false ]; then
  info "Установка npm зависимостей..."

  for repo in overstory mulch canopy; do
    local_path="$PROJECTS_DIR/$repo"
    if [ -d "$local_path" ] && [ -f "$local_path/package.json" ]; then
      info "bun install в $repo..."
      (cd "$local_path" && bun install --frozen-lockfile 2>/dev/null || bun install)
      ok "$repo: зависимости установлены"
    fi
  done
  echo ""
fi

# ─── 4. Линковка CLI ────────────────────────────────────────────────────────
info "Линковка CLI инструментов..."

link_cli() {
  local name="$1"
  local dir="$PROJECTS_DIR/$name"

  if [ ! -d "$dir" ]; then
    warn "$name не найден, пропускаю линковку"
    return 0
  fi

  info "bun link в $name..."
  (cd "$dir" && bun link 2>/dev/null) && ok "$name: CLI залинкован" || warn "$name: bun link не удался (может не иметь bin)"
}

link_cli overstory
link_cli mulch
link_cli canopy

# Seeds ставим глобально из npm
if ! command -v sd &>/dev/null; then
  info "Установка seeds-cli глобально..."
  bun install -g @os-eco/seeds-cli 2>/dev/null && ok "seeds-cli установлен" || warn "seeds-cli: установка не удалась"
else
  ok "sd (seeds) уже в PATH"
fi
echo ""

# ─── 5. Docker (опционально) ────────────────────────────────────────────────
if [ "$DOCKER_MODE" = true ]; then
  info "Сборка Docker..."

  if ! command -v docker &>/dev/null; then
    fail "Docker не найден. Установи: https://docs.docker.com/engine/install/"
  fi

  OVERSTORY_DIR="$PROJECTS_DIR/overstory"

  # Создаём .env из шаблона если нет
  if [ ! -f "$OVERSTORY_DIR/.env" ]; then
    info "Создаю .env из .env.example..."
    cp "$OVERSTORY_DIR/.env.example" "$OVERSTORY_DIR/.env"
    warn "Отредактируй $OVERSTORY_DIR/.env — впиши API ключи и PROJECT_PATH"
  else
    ok ".env уже существует"
  fi

  # Сборка образа
  info "docker compose build..."
  (cd "$OVERSTORY_DIR" && docker compose build)
  ok "Docker образ собран"
  echo ""

  info "Запуск: cd $OVERSTORY_DIR && docker compose up -d"
  info "Вход:   docker exec -it overstory bash"
  echo ""
fi

# ─── 6. Верификация ─────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Верификация"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

PASS=0
TOTAL=0

verify() {
  local cmd="$1"
  TOTAL=$((TOTAL + 1))
  if command -v "$cmd" &>/dev/null; then
    local version
    version=$("$cmd" --version 2>/dev/null || echo "ok")
    ok "$cmd: $version"
    PASS=$((PASS + 1))
  else
    warn "$cmd: не найден в PATH"
  fi
}

verify git
verify bun
verify tmux
verify ov
verify ml
verify cn
verify sd

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Результат: ${GREEN}$PASS${NC}/$TOTAL инструментов доступно"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$PASS" -ge 6 ]; then
  echo ""
  ok "Установка завершена!"
  echo ""
  info "Быстрый старт:"
  echo "  cd /path/to/your/project"
  echo "  ov init                  # Инициализация overstory"
  echo "  ov coordinator start     # Запуск координатора"
  echo "  ov status                # Статус агентов"
else
  echo ""
  warn "Некоторые инструменты не установились. Проверь вывод выше."
fi
