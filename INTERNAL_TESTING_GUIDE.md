# 钉钉连接器 v0.8.0 内测指南

## 📋 内测方案

### 方案一：一键安装脚本（推荐）

**适用场景**：快速体验新功能，无需手动配置

```bash
# 执行一键安装脚本
curl -fsSL https://raw.githubusercontent.com/DingTalk-Real-AI/dingtalk-openclaw-connector/feat/migrate-to-openclaw-sdk/install-beta.sh | bash
```

**脚本功能**：
- ✅ 自动备份当前配置
- ✅ 克隆升级分支代码
- ✅ 安装依赖
- ✅ 卸载旧版本并安装新版本
- ✅ 重启 Gateway
- ✅ 提供回滚指引

---

### 方案二：手动安装

**适用场景**：需要自定义配置或调试

```bash
# 1. 克隆升级分支
git clone --single-branch --branch feat/migrate-to-openclaw-sdk \
    https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector.git \
    dingtalk-openclaw-connector-beta

# 2. 进入目录并安装依赖
cd dingtalk-openclaw-connector-beta
npm install

# 3. 安装插件（本地开发模式）
openclaw plugins install -l .

# 4. 重启 Gateway
openclaw gateway restart
```

---

### 方案三：直接从 Git 安装

**适用场景**：不想克隆代码，直接安装

```bash
openclaw plugins install \
    https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector.git#feat/migrate-to-openclaw-sdk

# 重启 Gateway
openclaw gateway restart
```

---

## 🔍 验证安装

### 检查插件状态

```bash
openclaw plugins list
```

应该看到：
```
✓ dingtalk-connector (enabled)
```

### 检查配置

```bash
openclaw config show channels.dingtalk-connector
```

### 测试连接

```bash
# 发送测试消息
# 在钉钉中向机器人发送任意消息，查看是否正常响应
```

---

## 🐛 问题排查

### 问题 1：插件加载失败

**症状**：`openclaw plugins list` 显示插件未加载

**解决方案**：
```bash
# 查看日志
openclaw logs --tail 100

# 检查配置语法
openclaw config validate

# 重新安装
openclaw plugins uninstall dingtalk-connector
openclaw plugins install -l .
```

### 问题 2：配置不兼容

**症状**：启动后报错配置验证失败

**解决方案**：
```bash
# 查看详细错误
openclaw config validate

# 参考升级指南修改配置
cat README_UPGRADE.md
```

### 问题 3：多账号不生效

**症状**：配置了多个账号但只有一个生效

**解决方案**：
```bash
# 检查 bindings 配置
openclaw config show bindings

# 确保每个账号都有对应的 binding
openclaw config edit
```

---

## 🔄 回滚方案

### 方式一：使用备份恢复

```bash
# 恢复配置（备份文件名在安装时显示）
cp ~/.openclaw/openclaw.json.backup.YYYYMMDD_HHMMSS ~/.openclaw/openclaw.json

# 安装旧版本
openclaw plugins uninstall dingtalk-connector
openclaw plugins install @dingtalk-real-ai/dingtalk-connector@latest

# 重启 Gateway
openclaw gateway restart
```

### 方式二：切换回主分支

```bash
cd dingtalk-openclaw-connector-beta
git checkout main
openclaw plugins install -l .
openclaw gateway restart
```

---

## 📊 内测反馈

### 反馈渠道

- **GitHub Issues**：https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues
- **钉钉群**：[内测群链接]
- **邮件**：[邮箱地址]

### 反馈内容模板

```
### 问题描述
[简要描述问题]

### 复现步骤
1. 
2. 
3. 

### 期望行为
[期望的结果]

### 实际行为
[实际的结果]

### 环境信息
- OpenClaw 版本：
- 操作系统：
- Node.js 版本：
- 钉钉连接器版本：v0.8.0-beta

### 配置信息
[提供相关配置，敏感信息请脱敏]

### 日志
[提供相关日志]
```

---

## 📝 测试清单

### 基础功能测试

- [ ] 单聊消息接收和发送
- [ ] 群聊消息接收和发送
- [ ] AI Card 流式响应
- [ ] 媒体上传（图片、视频、音频、文件）
- [ ] 文档 API 功能

### 新功能测试

- [ ] 多账号配置和切换
- [ ] 安全策略（dmPolicy、groupPolicy）
- [ ] SecretInput 模式（env/file/exec）
- [ ] 白名单功能（allowFrom、groupAllowFrom）
- [ ] @ 机器人响应控制（requireMention）

### 兼容性测试

- [ ] 旧配置无需修改即可使用
- [ ] 配置验证错误提示清晰
- [ ] 多账号 bindings 正确匹配

### 性能测试

- [ ] 消息响应时间
- [ ] 并发消息处理
- [ ] 长时间运行稳定性

---

## ⚠️ 注意事项

1. **备份配置**：升级前务必备份配置文件
2. **测试环境**：建议先在测试环境验证，再在生产环境使用
3. **版本锁定**：内测版本可能不稳定，生产环境请等待正式版本
4. **及时反馈**：遇到问题请及时反馈，帮助改进

---

## 📅 内测时间表

- **内测开始**：2026-03-13
- **内测结束**：待定
- **正式发布**：待定

---

## 📞 联系方式

如有任何问题，请联系：
- **技术支持**：[联系方式]
- **产品经理**：[联系方式]
- **开发团队**：[联系方式]
