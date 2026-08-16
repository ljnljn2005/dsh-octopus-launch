#!/usr/bin/env bash
# =============================================================================
# octopus 数据库安全清理脚本（重建策略，v2）
#
# 背景：octopus 会把每次模型转发的完整请求体（约 585KB/次）存入
#       relay_logs.request_content，长期运行数据库会涨到十几 GB。
#       v1 用 DELETE + VACUUM 清理，在大库上中断会导致 SQLite 文件损坏
#       （database disk image is malformed）。本版改为【重建】：
#
#   1. 停止 octopus
#   2. 原库 mv 备份为 data.db.bak.<时间戳>（零风险回退点）
#   3. 用 python 从备份库复制完整 schema + 全部配置/统计表数据，
#      relay_logs 建空表（损坏风险区直接丢弃）
#   4. PRAGMA integrity_check 验证新库
#   5. 验证通过 → 新库就位，旧库按保留策略删除；失败 → 自动回滚
#
# 用法：./cleanup.sh            # 默认：清空 relay_logs，保留 1 个备份
#       ./cleanup.sh --keep=3   # 保留最近 3 个备份
#       RESTART=0 ./cleanup.sh  # 清理后不重启 octopus
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

KEEP=1
ARGS="${1:-}"
[ "${ARGS#--keep=}" != "$ARGS" ] && KEEP="${ARGS#--keep=}"
DB="data/data.db"
BINARY="./octopus"
LOG="octopus.dsh.log"
RESTART="${RESTART:-1}"   # RESTART=0 时清理后不重启
TMPDB="data/.cleanup-new.db"

echo "═══ octopus 数据库安全清理（重建策略）═══"

if [ ! -f "$DB" ]; then
  echo "❌ 数据库不存在: $DB"
  exit 1
fi

# 1. 停止 octopus（若在运行）
if pgrep -x octopus > /dev/null 2>&1; then
  echo "→ 停止 octopus ..."
  pkill -x octopus || true
  sleep 1
  pkill -9 -x octopus 2>/dev/null || true
  sleep 1
fi
if pgrep -x octopus > /dev/null 2>&1; then
  echo "❌ 无法停止 octopus，中止清理"
  exit 1
fi
echo "✓ octopus 已停止"

BEFORE=$(du -m "$DB" | cut -f1)
echo "→ 清理前数据库: ${BEFORE} MB"

# 2. 备份原库（mv，保留最近 KEEP 个）
BK="data/data.db.bak.$(date +%Y%m%d%H%M%S)"
mv "$DB" "$BK"
echo "✓ 已备份原库 → $BK"
ls data/data.db.bak.* 2>/dev/null | sort -r | tail -n +$((KEEP+1)) | while read -r old; do
  rm -f "$old" && echo "  清理旧备份: $old"
done

# 3. 重建新库（python：复制 schema + 配置表，relay_logs 空表）
python3 - "$BK" "$TMPDB" <<'PYEOF'
import sqlite3, sys, os

src, dst = sys.argv[1], sys.argv[2]
if os.path.exists(dst):
    os.remove(dst)

s = sqlite3.connect(src)
d = sqlite3.connect(dst)
try:
    # 完整 schema（relay_logs 的表结构也保留，只是不拷数据）
    for stmt in s.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name != 'sqlite_sequence'"
    ):
        d.executescript(stmt[0])
    # 复制 sqlite_sequence 自增计数（跳过 relay_logs）
    try:
        for row in s.execute("SELECT name, seq FROM sqlite_sequence WHERE name != 'relay_logs'"):
            d.execute("INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)", row)
    except Exception:
        pass
    # 复制全部可读表数据，relay_logs 跳过
    tables = [r[0] for r in d.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'relay_logs'")]
    for t in tables:
        cols = [c[1] for c in s.execute(f'PRAGMA table_info("{t}")')]
        col_list = ", ".join(f'"{c}"' for c in cols)
        rows = s.execute(f'SELECT {col_list} FROM "{t}"').fetchall()
        if rows:
            ph = ",".join("?" * len(cols))
            d.executemany(f'INSERT INTO "{t}" ({col_list}) VALUES ({ph})', rows)
        print(f"  ✓ {t}: {len(rows)} 行")
    d.commit()
except Exception as e:
    d.rollback()
    print(f"❌ 重建失败: {e}", file=sys.stderr)
    sys.exit(1)
finally:
    s.close()
    d.close()
PYEOF

# 4. 完整性验证
echo "→ 完整性检查 ..."
CHECK=$(sqlite3 "$TMPDB" "PRAGMA integrity_check;" 2>&1 || true)
if [ "$CHECK" != "ok" ]; then
  echo "❌ 新库完整性检查失败: $CHECK"
  echo "→ 自动回滚：恢复 $BK"
  mv "$BK" "$DB"
  echo "⚠️ 已回滚，数据未丢失，请人工排查"
  exit 1
fi
# 关键表抽查
for t in users channels api_keys; do
  C=$(sqlite3 "$TMPDB" "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "?")
  echo "  ✓ $t: $C 行"
done
echo "✓ 完整性检查通过"

# 5. 新库就位
mv "$TMPDB" "$DB"
AFTER=$(du -m "$DB" | cut -f1)
echo "✓ 新库就位: ${BEFORE} MB → ${AFTER} MB（relay_logs 已清空）"

# 6. 重启 octopus（默认）
if [ "${RESTART:-1}" = "1" ]; then
  echo "→ 重启 octopus ..."
  setsid nohup "$BINARY" start >> "$LOG" 2>&1 < /dev/null &
  sleep 4
  if pgrep -x octopus > /dev/null 2>&1; then
    echo "✓ octopus 已重启 (pid $(pgrep -x octopus))"
  else
    echo "⚠️ octopus 启动失败，请检查 $LOG"
  fi
fi

echo "═══ 清理完成 ═══"
echo "提示：data.db.bak.* 为自动备份（保留最近 $KEEP 个），确认无误后可手动删除"
