# Profunda Chat

DS-Chat 的个人自用版本：把 DeepSeek 网页版前端（[deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，MIT）接上本地网关，实现「模型 token 走 OpenCode Go 订阅、联网搜索与附件解析走 DeepSeek 官方接口」的双轨路由。

## 结构

```
server.mjs                 本地网关：静态托管 + /api/* 路由
gateway/hybrid.mjs         混合执行：OCGO 生成 + 官方搜索/抓取
gateway/attachments.mjs    附件中转：上传字节缓存 → base64 / 文本
chat-demo/                 官方前端源码（已按本项目的需要修改）
scripts/                   启动、停止、构建与快捷方式脚本
assets/                    图标
```

## 启动

双击 `scripts\DS-Chat.vbs`（无窗口），或 `bash scripts/start.sh`。网关默认监听 `http://127.0.0.1:8090`。

| 脚本 | 作用 |
| --- | --- |
| `scripts\DS-Chat.vbs` | 静默启动（不弹控制台）并打开浏览器 |
| `scripts\launch.ps1` | 后台拉起网关、等待健康检查、打开页面 |
| `scripts\start.ps1` | 前台运行网关，自动从用户环境变量注入密钥 |
| `scripts\start.sh` | 同上，Git Bash 用 |
| `scripts\stop.ps1` | 停止网关（只结束命令行含 `server.mjs` 的进程） |
| `scripts\build.sh` | 构建前端产物 |
| `scripts\make-shortcut.ps1` | 创建桌面 / 开机启动快捷方式（`-Startup`） |

配置见 `.env.local.example`，密钥只存在 `config/providers.json`（不入库）。

## 文档

调研与实现文档只保存在本地 `docs/`（含真实使用细节，不入库）。

## 上游对照

上游历史保留在 `.upstream/chat-demo.git`（不纳入版本库），基于 `5d5dd75`（v0.1.1）。对比改动：

```bash
git --git-dir=.upstream/chat-demo.git --work-tree=chat-demo diff
```
