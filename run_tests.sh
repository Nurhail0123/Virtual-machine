#!/usr/bin/env bash
# run_tests.sh — build semua file di tests/*.lua lalu jalankan pakai Lua asli.
# WAJIB dijalankan di mesin yang punya `lua5.1` atau `luau` terpasang.
#
# Cara pakai:
#   chmod +x run_tests.sh
#   ./run_tests.sh lua5.1      # pakai Lua 5.1 resmi
#   ./run_tests.sh luau        # pakai Luau (Roblox) CLI
#   ./run_tests.sh lua         # pakai `lua` generik yang ada di PATH

set -e
LUA_BIN="${1:-lua5.1}"
OUT_DIR="/tmp/obfuscator_test_output"
mkdir -p "$OUT_DIR"

echo "Menggunakan interpreter: $LUA_BIN"
echo "=================================================="

for f in tests/*.lua; do
  name=$(basename "$f" .lua)
  out="$OUT_DIR/$name.out.lua"
  echo ""
  echo "=== $f ==="
  node build.js "$f" "$out"
  echo "--- output eksekusi ($LUA_BIN) ---"
  "$LUA_BIN" "$out"
done

echo ""
echo "=================================================="
echo "Selesai. File hasil build ada di: $OUT_DIR"
