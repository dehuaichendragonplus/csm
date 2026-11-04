#!/bin/bash
# 双击即可启动 CSM（Config Sync Manager，Configs 表格同步 + 代码生成 Web GUI）
# 关闭方式：在本窗口按 Ctrl+C，或直接关闭窗口

# Finder 双击时 cwd 是用户主目录，这里以脚本自身位置为准
script_dir=$(cd "$(dirname "$0")" && pwd)
cd "$script_dir" || exit 1

# 终端标题
printf '\033]0;CSM\007'

# 双击启动的登录 shell 可能没加载 Homebrew 环境，兜底注入
if ! command -v node >/dev/null 2>&1 && [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 找不到 node，请先安装 Node.js ≥ 18（brew install node）"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

echo "==================================================="
echo "  CSM (Config Sync Manager)"
echo "  目录: $script_dir"
echo "  Node: $(node -v)"
echo "  启动后浏览器会自动打开（端口 7321 起，被占用则自动顺延）"
echo "  停止: 在本窗口按 Ctrl+C"
echo "==================================================="
echo

./start.sh
status=$?

echo
if [ $status -ne 0 ]; then
  echo "❌ CSM 异常退出（exit $status），错误信息见上方日志"
else
  echo "✅ CSM 已停止"
fi
read -n 1 -s -r -p "按任意键关闭…"
