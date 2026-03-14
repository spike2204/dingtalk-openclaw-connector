#!/bin/bash

echo "=========================================="
echo "清理僵尸连接脚本"
echo "=========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "【步骤1】停止所有 OpenClaw 进程"
echo "----------------------------------------"
pkill -9 -f openclaw
sleep 2

# 确认进程已停止
REMAINING=$(ps aux | grep openclaw | grep -v grep | wc -l)
if [ "$REMAINING" -eq 0 ]; then
    echo -e "${GREEN}✅ 所有进程已停止${NC}"
else
    echo -e "${RED}❌ 还有 $REMAINING 个进程未停止${NC}"
    echo "详细信息："
    ps aux | grep openclaw | grep -v grep
    echo ""
    echo "请手动停止这些进程后再继续"
    exit 1
fi
echo ""

echo "【步骤2】等待钉钉服务端清理连接"
echo "----------------------------------------"
echo "等待 60 秒，让钉钉服务端清理僵尸连接..."
for i in {60..1}; do
    echo -ne "\r剩余时间: ${i} 秒  "
    sleep 1
done
echo ""
echo -e "${GREEN}✅ 等待完成${NC}"
echo ""

echo "【步骤3】清理进程锁文件"
echo "----------------------------------------"
LOCK_DIR="$HOME/.openclaw/locks"
if [ -d "$LOCK_DIR" ]; then
    echo "清理锁文件目录: $LOCK_DIR"
    rm -rf "$LOCK_DIR"/dingtalk-*.lock
    echo -e "${GREEN}✅ 锁文件已清理${NC}"
else
    echo "锁文件目录不存在，跳过"
fi
echo ""

echo "【步骤4】重新启动 OpenClaw"
echo "----------------------------------------"
echo "请手动执行以下命令启动 OpenClaw："
echo ""
echo -e "${YELLOW}  openclaw gateway start${NC}"
echo ""
echo "启动后，请等待 10 秒，然后运行诊断脚本验证："
echo ""
echo -e "${YELLOW}  ./diagnose-dingtalk-issue.sh${NC}"
echo ""
echo "=========================================="
echo "清理完成"
echo "=========================================="
