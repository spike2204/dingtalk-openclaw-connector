# Release Notes - v0.8.3

## 🎉 新版本亮点 / Highlights

本次更新修复了三个问题：多 Agent 路由在 `sharedMemoryAcrossConversations` 配置下的路由错误、发送图片时的异常问题，以及修复了发送人昵称和群名称未正确传递给 AI 的问题。

This release fixes three issues: incorrect multi-Agent routing when `sharedMemoryAcrossConversations` is enabled, an image sending failure, and sender nickname and group name not being correctly passed to the AI.

## 🐛 修复 / Fixes

- **多 Agent 路由与 sharedMemoryAcrossConversations 冲突 / Multi-Agent Routing Conflict with sharedMemoryAcrossConversations**  
  修复了配置 `sharedMemoryAcrossConversations: true` 时，多群分配不同 Agent 的 bindings 全部路由到同一个 Agent 的问题。根因是路由匹配错误地使用了 `sessionPeerId`（已被覆盖为 `accountId`）而非真实的 peer 标识。修复后，路由匹配使用专用的 `peerId` 字段（不受会话隔离配置影响），session 构建使用 `sessionPeerId`，两者职责严格分离。  
  Fixed an issue where all bindings routing different groups to different Agents would resolve to the same Agent when `sharedMemoryAcrossConversations: true` was configured. The root cause was that routing matched against `sessionPeerId` (overridden to `accountId`) instead of the real peer identifier. After the fix, routing uses the dedicated `peerId` field (unaffected by session isolation config), while session construction uses `sessionPeerId`, with strict separation of responsibilities.

- **发送图片失败 / Image Sending Failure**  
  修复了发送图片时出现异常的问题。([#316](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues/316))  
  Fixed an issue where sending images would fail with an error. ([#316](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/issues/316))

- **发送人昵称与群名称未正确传递给 AI / Sender Nickname and Group Name Not Passed to AI**  
  修复了会话上下文中 `SenderName` 字段错误传入用户 ID（而非昵称）、`GroupSubject` 字段错误传入群 ID（而非群名称）的问题。修复后，AI 能正确获取发送人的钉钉昵称和所在群的名称，有助于 AI 更好地理解对话场景。  
  Fixed an issue where the `SenderName` field in the session context was incorrectly set to the user ID instead of the display name, and `GroupSubject` was set to the group ID instead of the group title. After the fix, the AI correctly receives the sender's DingTalk nickname and the group name, enabling better contextual understanding.

## 📥 安装升级 / Installation & Upgrade

```bash
# 通过 npm 安装最新版本 / Install latest version via npm
openclaw plugins install @dingtalk-real-ai/dingtalk-connector

# 或升级现有版本 / Or upgrade existing version
openclaw plugins update dingtalk-connector

# 通过 Git 安装 / Install via Git
openclaw plugins install https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector.git
```

## 🔗 相关链接 / Related Links

- [完整变更日志 / Full Changelog](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/CHANGELOG.md)
- [使用文档 / Documentation](https://github.com/DingTalk-Real-AI/dingtalk-openclaw-connector/blob/main/README.md)

---

**发布日期 / Release Date**：2026-03-23  
**版本号 / Version**：v0.8.3  
**兼容性 / Compatibility**：OpenClaw Gateway 0.4.0+