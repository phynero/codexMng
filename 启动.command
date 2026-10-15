#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18.15 或更新版本。安装后重新运行。"
  read -r "?按回车退出…"
  exit 1
fi
echo "浏览器地址：http://127.0.0.1:${PORT:-4317}"
echo "正在启用开机自启并启动后台服务…"
node server/autostart.mjs install
/usr/bin/open "http://127.0.0.1:${PORT:-4317}"
