# Profunda Chat

DS-Chat 的个人自用版本：把 DeepSeek 网页版前端（[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，MIT）接上本地网关，实现「模型 token 走 OpenCode Go 订阅、联网搜索与附件解析走 DeepSeek 官方接口」的双轨路由。

## 结构

```
server.mjs                 本地网关：静态托管 + /api/* 路由
gateway/hybrid.mjs         混合执行：OCGO 生成 + 官方搜索/抓取
gateway/attachments.mjs    附件中转：上传字节缓存 → base64 / 文本
chat-demo/                 官方前端源码（已按本项目的需要修改）
tools/  assets/            辅助脚本、图标
DS-Chat.vbs launch.ps1 …   Windows 启动脚本
```

## 启动

双击 `DS-Chat.vbs`（无窗口），或 `bash start.sh`。网关默认监听 `http://127.0.0.1:8090`。

配置见 `.env.local.example`，密钥只存在 `config/providers.json`（不入库）。

## 文档

调研与实现文档只保存在本地 `docs/`（含真实使用细节，不入库）。

## 上游对照

上游历史保留在 `.upstream/chat-demo.git`（不纳入版本库），基于 `5d5dd75`（v0.1.1）。对比改动：

```bash
git --git-dir=.upstream/chat-demo.git --work-tree=chat-demo diff
```
