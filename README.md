# Loon AI / PubMed 优化配置

本仓库包含：

- `Loon_AI_PubMed_Optimized.conf`：完整 Loon 配置。
- `scripts/ai-node-check.js`：AI 节点实测脚本。

## 作用

1. `AI智能优选` 不再根据节点名称中的 GPT / Gemini / 高速 / 专线判断可用性。
2. 脚本会让候选节点实际访问 OpenAI API 和 ChatGPT，优先选择低抖动、适合 Codex 长连接的节点。
3. 定时守护只在当前 AI 节点失效时切换，避免频繁换节点主动造成 Codex 重连。
4. PubMed 使用 `https://pubmed.ncbi.nlm.nih.gov/robots.txt` 作为测速目标，不再用 Google gstatic 延迟替代 PubMed 链路质量。
5. 中国大陆域名优先直连，Apple 生态直连，GitHub 使用高速节点池。

## Loon 远程脚本

配置已经引用：

`https://raw.githubusercontent.com/quillamio/loon/main/scripts/ai-node-check.js`

## 重要：仓库可见性

Loon 直接下载 `raw.githubusercontent.com` 远程脚本时不会携带你的 GitHub 登录状态。若本仓库保持 Private，上面的远程脚本地址通常无法直接读取。

因此若要做到“不添加本地脚本、只导入配置即可使用”，请把这个仓库设为 **Public**。

仓库公开后可以使用以下地址：

- 完整配置：`https://raw.githubusercontent.com/quillamio/loon/main/Loon_AI_PubMed_Optimized.conf`
- AI 检测脚本：`https://raw.githubusercontent.com/quillamio/loon/main/scripts/ai-node-check.js`

## 首次使用

1. 将仓库设为 Public。
2. 在 Loon 中导入 `Loon_AI_PubMed_Optimized.conf`。
3. 更新远程资源。
4. 手动运行一次 `AI节点全量检测`。
5. 查看通知中的可用节点数量、平均延迟和抖动，并确认 `AI智能优选` 已切换到通过实测的节点。
