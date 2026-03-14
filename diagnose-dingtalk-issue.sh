#!/bin/bash

echo "=========================================="
echo "钉钉消息丢失问题诊断脚本"
echo "=========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. 检查 OpenClaw 进程数量
echo "【1】检查 OpenClaw 进程数量"
echo "----------------------------------------"
OPENCLAW_COUNT=$(ps aux | grep -i "openclaw" | grep -v grep | wc -l)
echo "OpenClaw 进程数量: $OPENCLAW_COUNT"

if [ $OPENCLAW_COUNT -gt 1 ]; then
    echo -e "${RED}⚠️  警告：检测到多个 OpenClaw 进程！${NC}"
    echo "详细信息："
    ps aux | grep -i "openclaw" | grep -v grep
    echo ""
    echo -e "${YELLOW}建议：停止所有进程，只保留一个${NC}"
else
    echo -e "${GREEN}✅ 正常：只有一个 OpenClaw 进程${NC}"
fi
echo ""

# 2. 检查 Node.js 进程（OpenClaw 可能以 node 进程运行）
echo "【2】检查 Node.js 进程"
echo "----------------------------------------"
NODE_COUNT=$(ps aux | grep -E "node.*openclaw|node.*gateway" | grep -v grep | wc -l)
echo "相关 Node 进程数量: $NODE_COUNT"

if [ $NODE_COUNT -gt 0 ]; then
    echo "详细信息："
    ps aux | grep -E "node.*openclaw|node.*gateway" | grep -v grep
fi
echo ""

# 3. 检查端口占用（OpenClaw 默认 18789）
echo "【3】检查端口 18789 占用情况"
echo "----------------------------------------"
if command -v lsof &> /dev/null; then
    PORT_USAGE=$(lsof -i :18789 2>/dev/null)
    if [ -z "$PORT_USAGE" ]; then
        echo -e "${RED}⚠️  警告：端口 18789 没有被占用！${NC}"
        echo "OpenClaw Gateway 可能没有启动"
    else
        PORT_COUNT=$(echo "$PORT_USAGE" | grep LISTEN | wc -l)
        echo "监听端口 18789 的进程数量: $PORT_COUNT"
        echo "$PORT_USAGE"
        
        if [ $PORT_COUNT -gt 1 ]; then
            echo -e "${RED}⚠️  警告：多个进程监听同一端口！${NC}"
        fi
    fi
else
    # macOS 或没有 lsof 的系统
    netstat -an | grep 18789
fi
echo ""

# 4. 检查钉钉 Stream 连接
echo "【4】检查钉钉 Stream 连接"
echo "----------------------------------------"
STREAM_COUNT=0
if command -v lsof &> /dev/null; then
    STREAM_CONN=$(lsof -i -n | grep -E "api.dingtalk.com|stream.*dingtalk" 2>/dev/null)
    if [ -z "$STREAM_CONN" ]; then
        echo -e "${YELLOW}⚠️  未检测到钉钉 Stream 连接${NC}"
    else
        STREAM_COUNT=$(echo "$STREAM_CONN" | wc -l | tr -d ' ')
        echo "钉钉 Stream 连接数量: $STREAM_COUNT"
        echo "$STREAM_CONN"
        
        if [ "$STREAM_COUNT" -gt 1 ]; then
            echo -e "${RED}⚠️  警告：检测到多个钉钉 Stream 连接！${NC}"
            echo -e "${YELLOW}这可能导致消息被分发到不同的连接${NC}"
        fi
    fi
else
    netstat -an | grep ESTABLISHED | grep -E "dingtalk|443"
fi
echo ""

# 5. 检查配置文件
echo "【5】检查 OpenClaw 配置"
echo "----------------------------------------"
CONFIG_FILE="$HOME/.openclaw/openclaw.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "配置文件位置: $CONFIG_FILE"
    
    # 检查是否有多个 dingtalk 账号配置
    ACCOUNT_COUNT=$(grep -o '"accountId"' "$CONFIG_FILE" | wc -l)
    echo "配置的钉钉账号数量: $ACCOUNT_COUNT"
    
    if [ $ACCOUNT_COUNT -gt 1 ]; then
        echo -e "${YELLOW}⚠️  检测到多个钉钉账号配置${NC}"
        echo "账号列表："
        grep -A 1 '"accountId"' "$CONFIG_FILE" | grep -v "^--$"
    fi
else
    echo -e "${RED}⚠️  配置文件不存在: $CONFIG_FILE${NC}"
fi
echo ""

# 6. 检查日志文件
echo "【6】检查最近的日志"
echo "----------------------------------------"
LOG_DIR="$HOME/.openclaw/logs"
if [ -d "$LOG_DIR" ]; then
    echo "日志目录: $LOG_DIR"
    
    # 查找最新的日志文件
    LATEST_LOG=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
    if [ -n "$LATEST_LOG" ]; then
        echo "最新日志文件: $LATEST_LOG"
        echo ""
        echo "最近 20 条日志："
        tail -20 "$LATEST_LOG"
        echo ""
        
        # 检查是否有重复消息的警告
        DUPLICATE_COUNT=$(grep -c "检测到重复消息" "$LATEST_LOG" 2>/dev/null || echo 0)
        if [ $DUPLICATE_COUNT -gt 0 ]; then
            echo -e "${YELLOW}⚠️  检测到 $DUPLICATE_COUNT 条重复消息警告${NC}"
        fi
        
        # 检查是否有连接断开的日志
        DISCONNECT_COUNT=$(grep -c -i "disconnect\|connection.*close" "$LATEST_LOG" 2>/dev/null || echo 0)
        if [ $DISCONNECT_COUNT -gt 0 ]; then
            echo -e "${YELLOW}⚠️  检测到 $DISCONNECT_COUNT 次连接断开${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  未找到日志文件${NC}"
    fi
else
    echo -e "${RED}⚠️  日志目录不存在: $LOG_DIR${NC}"
fi
echo ""

# 7. 检查系统资源
echo "【7】检查系统资源"
echo "----------------------------------------"
echo "内存使用情况："
free -h 2>/dev/null || vm_stat | head -5
echo ""
echo "磁盘使用情况："
df -h | grep -E "/$|/home"
echo ""

# 8. 总结和建议
echo "=========================================="
echo "诊断总结"
echo "=========================================="
echo ""

if [ $OPENCLAW_COUNT -gt 1 ]; then
    echo -e "${RED}❌ 问题：检测到多个 OpenClaw 进程${NC}"
    echo "   建议：执行以下命令停止所有进程，然后重新启动一个"
    echo "   pkill -f openclaw"
    echo "   openclaw gateway start"
    echo ""
fi

if [ "$STREAM_COUNT" -gt 1 ] 2>/dev/null; then
    echo -e "${RED}❌ 问题：检测到多个钉钉 Stream 连接${NC}"
    echo "   建议：这会导致消息被分发到不同的连接，造成丢消息"
    echo "   请确保只有一个 OpenClaw 实例在运行"
    echo ""
fi

echo -e "${GREEN}✅ 诊断完成${NC}"
echo ""
echo "如果问题仍然存在，请将此诊断结果发送给开发者"
