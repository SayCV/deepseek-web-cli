# DeepSeek Web CLI v3

基于 DeepSeek 网页版私有 API 的双子项目——单文件交互式 REPL + OpenAI 兼容 HTTP 中转服务。无需 API Key，零 Token 消耗。

> ⚠️ 仅供体验和学习：基于网页私有接口逆向实现，随时可能被封禁或变更，请勿用于生产环境。

---

## 项目结构

```
deepseek-web-cli-v3/
├── cli/                       # 子项目 A：单文件交互式 REPL
│   ├── chat.ts                # 约 3100 行，自包含
│   ├── tool.md                # 工具使用规范
│   ├── Test/
│   │   ├── test.test.ts       # 87 项自动化测试
│   │   ├── TEST_PLAN.md       # 完整手动测试方案
│   │   └── test11/22/33/      # 测试 fixture 目录
│   ├── credentials.json       # 登录凭证（gitignored）
│   └── .deepseek/             # 运行时提示词和会话（gitignored）
│
└── server/                    # 子项目 B：OpenAI 兼容 HTTP API
    ├── bin/deepseek-openai.ts # HTTP 服务入口
    ├── deepseek-openai.sh     # 管理脚本（start/stop/restart/status/logs）
    ├── src/
    │   ├── types.ts           # 类型定义
    │   ├── credentials.ts     # 凭据管理
    │   ├── deepseek-client.ts # API 客户端 + PoW + SSE 解析
    │   ├── openai-server.ts   # HTTP 中转服务
    │   └── openai-stream.ts   # DeepSeek → OpenAI SSE 格式转换
    ├── .gitignore
    └── .deepseek/             # 运行时凭证和数据（gitignored）
```

两个子项目完全独立，零共享代码，各自运行。

---

## chat.ts — 单文件交互式 REPL

单文件自包含，包含登录、REPL、SSE 解析、API 客户端、PoW 求解、工具执行（5 个内置工具）、Hashline 编辑引擎、会话持久化、提示词体系。

### 前置条件

- **[Node.js](https://nodejs.org) 22+** 或 **[bun](https://bun.sh)** 运行时
- **[tsx](https://tsx.is)** — TypeScript 执行器（`npm install -g tsx`）
- **Chrome 浏览器**（仅首次登录时需要，带 `--remote-debugging-port=9222`）
- **playwright-core**（CDP 连接 Chrome 获取凭证，仅首次登录时需要：`npm install playwright-core`）
- Android Termux 额外：`android-tools` + `adb forward tcp:9222 localabstract:chrome_devtools_remote`

### 快速开始

```bash
# 1. 安装依赖（仅首次）
npm install -g tsx                          # 全局安装，之后 tsx 命令随处可用
npm install playwright-core                 # CDP 登录，仅首次需要

# 2. 启动 REPL（三种方式，任选其一）
./cli/chat.ts                               # 直接执行（需要 tsx 全局安装，chat.ts 自带 shebang）
tsx ./cli/chat.ts                           # 用 tsx 命令显式执行
bun run ./cli/chat.ts                       # 或使用 bun（npm install -g bun）
```

> 首次运行时会触发登录流程；凭证过期后自动重新登录，或在 REPL 中 `/reauth`。
>
> 如果 `./cli/chat.ts` 报 `tsx: command not found`，说明 tsx 未全局安装或不在 PATH 中，改用 `npx tsx ./cli/chat.ts`。

凭证缺失或过期时自动通过 Chrome DevTools Protocol 捕获 cookie 和 bearer token，保存到 `cli/credentials.json`。

### Android Termux 额外步骤

```bash
pkg install android-tools
# 开启无线调试后，使用 adb pair 配对，然后 adb connect IP:端口
# 转发 Chrome 调试端口
adb forward tcp:9222 localabstract:chrome_devtools_remote
# 验证转发可用
curl -s http://127.0.0.1:9222/json/version
```

### 首次登录流程

1. 启动带远程调试端口的 Chrome：
   - 桌面端：以 `--remote-debugging-port=9222` 参数启动 Chrome
   - Android：确保已通过 `adb forward tcp:9222 localabstract:chrome_devtools_remote` 转发端口
2. 运行 `./cli/chat.ts`，脚本自动检测登录态：
   - 已有有效登录态 → 自动捕获凭证
   - 无有效登录态 → 打开 DeepSeek 页面提示手动登录，完成后自动捕获
3. 凭证保存至 `cli/credentials.json`（gitignored）

> 凭证可能在一段时间后过期，届时运行 `./cli/chat.ts` 会自动重新登录，或在 REPL 中执行 `/reauth`。

### 命令速查

**会话管理**

| 命令 | 说明 |
|------|------|
| `/new [标题]` | 创建新会话 |
| `/load [id]` | 切换会话（无参数时交互式选择） |
| `/ls, /list` | 列出所有本地会话 |
| `/del [id\|--all]` | 交互式删除 / 指定删除 / 全删 |
| `/parent, /p <id>` | 手动覆盖续接点 |
| `/fork, /f [id] [标题]` | 分叉新会话 |
| `/save, /s` | 手动保存 |
| `/history [-r N] [-a] [-id <id>]` | 查看历史 |

**云端会话管理 (`/cloud`, `/c`)**

| 命令 | 说明 |
|------|------|
| `/c` | 列出云端所有会话 |
| `/c <N>` | 加载云端会话到本地（含完整历史） |
| `/c -d <N>\|all` | 删除单个 / 全部云端会话（需确认） |
| `/c -p <N>` | 置顶 / 取消置顶 |
| `/c -r <N> <标题>` | 重命名 |
| `/c -s <N>` | 分享最近一轮为链接 |
| `/c -sl` | 查看所有已分享链接 |
| `/c -us <N>` | 取消分享 |

**提示词管理**

| 命令 | 说明 |
|------|------|
| `/system, /sys` | 查看提示词状态 |
| `  -c` | 清除局部（回退到全局） |
| `  -f <path> [-l]` | 加载提示词（-l 为局部） |
| `/reinject, /rj [-new\|-keep]` | 重新注入提示词 |

**模式切换**

| 命令 | 说明 |
|------|------|
| `/think [on\|off]` | 切换深度思考模式 |
| `/search [on\|off]` | 切换联网搜索 |
| `/model, /m [flash\|pro\|vision]` | 切换模型 |
| `/upload, /up <path>` | 上传文件 |
| `/tool, /t [on\|off\|-l]` | 工具模式开关 / 列表 |
| `/raw` | 切换原始 SSE（调试用） |

**系统**

| 命令 | 说明 |
|------|------|
| `/?, /h` | 帮助 |
| `/quit, /q` | 退出 |
| `/clear` | 清屏 |
| `/cd <path>` | 切换工作目录 |
| `/pwd` | 当前工作目录 |
| `/auth [-s]` | 查看 / 验证凭证状态 |
| `/reauth` | 重新登录 |
| `!<cmd>` | Shell 透传 |

### 提示词体系

在工作目录下创建 `.deepseek/` 目录（gitignored），支持四类提示词文件：

```
.deepseek/
├── system.md           # 局部（优先级最高）
├── system-all.md       # 全局（局部不存在时生效）
├── tool.md             # 工具补充提示词
├── think.md            # 深度思考提示词
└── sessions/           # 会话存档目录
```

### 内置工具（5 个）

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容（输出带 hashline 标注） |
| `write` | 写入文件（自动清洗 hashline 标注）[需确认] |
| `edit` | 行级精确编辑（hashline ref 引用，扁平参数）[需确认] |
| `exec` | 执行系统命令 [需确认] |
| `web_fetch` | 抓取 HTTP/HTTPS URL 内容 |

**路径沙箱安全**：所有文件操作限定在工作目录内，拒绝 `../` 越界访问。

---

## Server — OpenAI 兼容 HTTP API

纯协议中转服务，将 OpenAI 格式请求翻译为 DeepSeek 私有 API 调用，返回标准 SSE 流。接收 `/v1/chat/completions` 请求。支持 OpenAI tool calling 协议（通过 prompt 注入实现）。

### 前置条件

- 有效的凭证（先通过 CLI 登录一次，复制 `credentials.json` 到 `server/.deepseek/`）
- [bun](https://bun.sh) 运行时
- 需在项目根目录下运行（或设置 `DEEPSEEK_CONFIG_DIR` 环境变量）

### 快速开始

```bash
# 1. 准备凭证（先通过 CLI 登录一次）
mkdir -p server/.deepseek
cp cli/credentials.json server/.deepseek/credentials.json

# 2. 前台启动服务（默认 127.0.0.1:8899）
npx tsx server/bin/deepseek-openai.ts serve
npx tsx server/bin/deepseek-openai.ts serve --port 18899     # 自定义端口

# 3. 或使用 bun 效率更高
bun run ./server/bin/deepseek-openai.ts serve

# 4. 或后台运行（管理脚本，自动检测 bun/tsx）
bash server/deepseek-openai.sh start      # 后台启动
bash server/deepseek-openai.sh status     # 查看运行状态
bash server/deepseek-openai.sh restart    # 重启
bash server/deepseek-openai.sh stop       # 停止
bash server/deepseek-openai.sh logs       # 查看实时日志

# 后台启动支持 HOST 和 PORT 环境变量
PORT=18899 bash server/deepseek-openai.sh start
HOST=0.0.0.0 PORT=8899 bash server/deepseek-openai.sh start

# 5. 开启调试日志（记录每轮请求/响应详情）
bash server/deepseek-openai.sh start --debug
bash server/deepseek-openai.sh restart --debug
# 也支持前台启动
npx tsx server/bin/deepseek-openai.ts serve --debug
bun run ./server/bin/deepseek-openai.ts serve --debug
```


### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/models` | 模型列表（deepseek-flash, deepseek-pro） |
| POST | `/v1/chat/completions` | OpenAI 兼容聊天接口（支持 stream） |

### 使用示例

```bash
curl -s -N http://127.0.0.1:8899/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-local" \
  -d '{
    "model": "deepseek-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 客户端配置

Server 实现了标准 OpenAI API 协议，任何支持自定义 API 地址的客户端都可以直接使用。

**OpenCode**

1. 创建项目级 `opencode.json`（在项目根目录）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "deepseek-local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DeepSeek Local",
      "options": {
        "baseURL": "http://127.0.0.1:8899/v1"
      },
      "models": {
        "deepseek-flash": {
          "name": "DeepSeek Flash"
        },
        "deepseek-pro": {
          "name": "DeepSeek Pro"
        }
      }
    }
  }
}
```

2. 在 OpenCode 中执行 `/connect`，选择 **Other**，输入 provider id `deepseek-local`，API key 填任意非空字符串（如 `sk-local`，Server 不做校验）。

启动 OpenCode 前注意：
- 确保 port 与 Server 一致
- 如果多个项目共用同一个 Server，可将上述配置写入 `~/.config/opencode/opencode.jsonc`

**NextChat / LobeChat / ChatBox**
在设置中添加自定义 API 端点 `http://127.0.0.1:8899/v1`，API Key 填任意值，选择 `deepseek-flash` 或 `deepseek-pro`。

**Python (OpenAI SDK)**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="sk-local")
stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

### 设计原则

- **多会话隔离**：按 authKey + 指纹（SHA256 哈希）双层路由，同一用户可同时保持多个独立对话
- **增量提示**：利用 DeepSeek parentMessageId 记忆机制，首轮发送完整上下文（system + tools），后续仅发送增量（工具调用 + 结果 + 用户消息），大幅减少 token 消耗
- **会话持久化**：`server/.deepseek/sessions.json` 保存 authKey → fingerprint → sessionId 映射，重启后直接续接
- **One-shot 检测**：无工具的简短请求（如标题生成）自动创建临时房间，完成后清理云端会话
- **自动恢复**：网页端删除对话后 chatWithRetry 自动重建房间
- **Prompt 注入工具**：将 OpenAI tools 转为 prompt 注入，从响应解析 `tool_json` 还原为 `tool_calls`；同时透传 DeepSeek 原生 DSML 工具调用

### 工具调用机制

DeepSeek 网页版 API 没有原生 tool calling 接口，Server 采用与 CLI 相同的 prompt 注入方案：

```
客户端发送                                  Server 转换
┌─────────────────────────┐               ┌─────────────────────────┐
│ tools: [{                │   注入到       │ ## 可用工具             │
│   type:"function",      │  ──→ prompt ──→ │ [{"name":"read",       │
│   function:{            │               │   "parameters":{        │
│     name:"read",        │               │     "path":"string"}}]  │
│     parameters:{...}    │               │ ...                     │
│ }}]                     │               │ 只回复 tool_json 代码块  │
└─────────────────────────┘               └─────────────────────────┘
                                                      │
                                                      ▼
                                              DeepSeek 模型响应
                                               ```tool_json
                                               {"tool":"read",
                                                "parameters":{
                                                  "path":"/etc/host"}}
                                               ```
                                                      │
                                                      ▼
                                              解析还原为 OpenAI 格式
                                              choices[0].delta.tool_calls
```

任何支持 OpenAI 协议的客户端都可通过此机制使用工具调用。

> ⚠️ 依赖于 DeepSeek 网页模型理解 `tool_json` 格式，非官方 API，可能存在不稳定性。

### CLI 工作原理

```
用户输入 → REPL 解析（/命令 / !透传 / 消息）
               │
          ChatSession.send()
               │
          PromptBuilder 组装提示词
               │
          DeepSeekClient.chat()（PoW + API 请求）
               │
          SSE 流 ← chat.deepseek.com
               │
          StreamParser 解析（text/thinking/title/tool_call）
               │
          终端输出
```

核心模块（均在 `cli/chat.ts` 单文件内）：

- **ChatSession**：会话管理、消息发送、工具调用循环（最大 10 次）、模型/搜索/思考开关
- **StreamParser**：SSE 流解析器，处理文本/思考/工具调用/标题/引用链接/hint 事件/clear_response，支持 DSML 标签格式
- **DeepSeekClient**：无状态 API 客户端，封装 PoW、HTTP 请求、文件上传
- **SessionStore**：会话 JSON 文件持久化
- **ToolRegistry/ToolExecutor**：工具注册与执行（含用户确认机制）
- **Hashline 核心**：行级 SHA1 哈希标注、ref 解析、编辑冲突检测、fileRev 版本校验、safeReapply 自动重定位

### 工具调用机制

CLI **不使用 DeepSeek 原生工具调用 API**（传 `tools=undefined`），而是采用 **prompt 注入 + 文本解析** 方案。

**完整流程：**

```
1. 注册工具 → registerBuiltinTools() 注册 5 个工具到 ToolRegistry

2. 提示词注入（仅首轮）
   ┌─────────────────────────────────────────────┐
   │ [systemPrompt]       ← .deepseek/system.md  │
   │ [thinkInjectionPrompt] ← 思考模式开时注入    │
   │ [toolsPrompt]        ← buildToolPrompt()     │
   │ [toolMdContent]      ← .deepseek/tool.md     │
   │ [skillMdContent]     ← .deepseek/skill.md    │
   │                                             │
   │ User: 用户消息                               │
   └─────────────────────────────────────────────┘

3. 模型生成响应（纯文本，无原生 tool_call）

4. StreamParser 解析 → extractToolCall() 提取 tool_json

5. ToolExecutor 执行工具 → 返回结果

6. 结果回传 → <tool_response> 作为新 prompt → 下一轮循环（最多 10 次）
```

**工具提示词实际内容（buildToolPrompt 输出）：**

```
## 可用工具
[{"name":"read","description":"从给定路径读取文件内容。","parameters":{"path":"string"}},...]

示例: 要给数字5加1，返回:
```tool_json
{"tool":"plus_one","parameters":{"number":"5"}}
```
plus_one 只是格式示例，不是真实工具。
需要调用真实工具时，只回复 tool_json 代码块，不要附加说明。
```

**正确调用格式：**

```tool_json
{"tool":"read","parameters":{"path":"src/main.ts"}}
```

```tool_json
{"tool":"edit","parameters":{
  "filePath": "src/main.ts",
  "op": "replace",
  "ref": "#HL 3#C78#E90",
  "content": "新内容",
  "fileRev": "A1B2C3D4"
}}
```

```tool_json
{"tool":"write","parameters":{"path":"src/new.ts","content":"文件内容"}}
```

```tool_json
{"tool":"exec","parameters":{"command":"ls -la"}}
```

```tool_json
{"tool":"web_fetch","parameters":{"url":"https://example.com"}}
```

**解析器支持两种格式：**
- **Fenced**：````tool_json { ... } ```（推荐）
- **Bare**：直接在文本中的 `{"tool":"...","parameters":{...}}`

**自定义工具提示词：** 在 `.deepseek/tool.md` 中添加详细工具使用说明（如 `cli/Test/test33/.deepseek/tool.md` 有 150 行示例），会在首轮注入时拼接到提示词中。

**工具参数对照表：**

| 工具 | 参数名 | 说明 |
|------|--------|------|
| `read` | `path` | 文件路径 |
| `write` | `path`, `content` | 文件路径, 写入内容 |
| `edit` | `filePath`, `op`, `ref`, `endRef?`, `content`, `fileRev`, `safeReapply` | 文件路径, 操作类型, 起始行引用, 结束行引用(可选), 新内容, 版本指纹, 自动重定位 |
| `exec` | `command` | Shell 命令 |
| `web_fetch` | `url` | HTTP/HTTPS URL |

---

## Server 工作原理

```
OpenAI 客户端 (curl/OpenCode/SDK)
    │ POST /v1/chat/completions
    ▼
openai-server.ts     ← 按 authKey 隔离用户，按对话指纹隔离会话
    │                   将 tools 转换为 prompt 注入
    ▼
deepseek-client.ts   ← API 客户端（PoW + 流式聊天）
    │
    ▼
chat.deepseek.com    ← 原始 SSE 流
    │
    ▼
openai-server.ts     ← 解析响应中的 tool_json 代码块
    │                   还原为 OpenAI tool_calls 格式
    ▼
openai-stream.ts     ← 格式转换（DeepSeek SSE → OpenAI SSE）
    │
    ▼
OpenAI 客户端        ← 标准 SSE 流返回
```

核心模块（`server/src/` 5 个文件）：

- **openai-server.ts**：HTTP 服务器。按 authKey + 指纹双层路由实现多会话隔离，支持增量提示、one-shot 检测与清理。将 tools 转为 prompt 注入，解析 tool_json + DSML 原生工具调用。支持会话持久化与自动恢复
- **deepseek-client.ts**：DeepSeek Web API 客户端，PoW 求解 + 流式聊天 + 文件上传（782 行）
- **openai-stream.ts**：SSE 格式转换器，DeepSeek `ParseEvent` → OpenAI `data: {...}\n\n`
- **credentials.ts**：凭据加载/验证（cookie + bearer + userAgent）
- **types.ts**：所有类型定义

**设计原则**：按 authKey + 指纹双层路由实现多会话隔离（同一用户可并行多个独立对话），会话信息持久化到 `sessions.json` 支持重启续接。首轮完整上下文 + 后续增量提示，显著降低 token 消耗。网页 API 无原生 tool calling，通过 prompt 注入 + tool_json/DSML 双通道解析实现。网页端删对话后自动重建。one-shot 请求自动清理云端会话。

---

## Hashline 文件编辑安全机制

内联了 [opencode-hashline](https://github.com/AngDrew/opencode-hashline) 的核心能力，为 `read` / `write` / `edit` 工具提供行级哈希校验。

### 工作流程

```
模型调用 read foo.ts
  → 返回 <hashline-file> 包裹的标注内容，每行带 #HL N#hash#anchor|
  → #HL REV:xxxxxxxx 为文件版本指纹

模型调用 edit { filePath, op: "replace", ref: "#HL 3#A4F#9BC", content: "...", fileRev: "xxxxxxxx" }
  → 读文件现场计算 rev，与 fileRev 对比
  → 解析 refs，校验每行的 hash 和 anchor 是否匹配
  → 检测操作间是否有重叠冲突
  → 从后往前按 splice 顺序应用改动
  → 写入文件，清除 rev 缓存

模型调用 write { content: "..." }
  → 自动清洗 content 中混入的 #HL 前缀和 wrapper 标签
  → 写入文件，清除 rev 缓存
```

### 四种操作

| 操作 | 说明 |
|------|------|
| `replace` | 替换 ref 行（传 endRef 则替换范围） |
| `delete` | 删除 ref 行（传 endRef 则删除范围） |
| `insert_before` | 在 ref 行之前插入内容 |
| `insert_after` | 在 ref 行之后插入内容 |

### 安全机制

| 机制 | 说明 |
|------|------|
| 行哈希校验 | 每个 ref 携带行内容 SHA1 哈希（3-4 字符），不匹配时拒绝编辑 |
| 锚点哈希校验 | ref 带 anchor 时还校验前后邻行内容，防同内容行误定位 |
| fileRev 版本锁 | 8 位 SHA1 文件版本指纹，读写之间文件被修改则拒绝编辑 |
| 重叠检测 | 批量操作中，删除/替换范围有重叠时拒绝执行 |
| safeReapply | 开启后 hash 匹配但行号移动时自动重新定位（仅当恰好一个候选时） |

---

## 测试

```bash
# 方式一：全局安装 tsx 后直接运行
tsx --test cli/Test/test.test.ts

# 方式二：使用 npx
npx tsx --test cli/Test/test.test.ts

# 手动测试方案
cat cli/Test/TEST_PLAN.md
```

测试覆盖：哈希函数、标注输出、ref 解析、编辑操作、冲突检测、fileRev 校验、标注清洗、会话持久化、环境发现、工具调用解析（fenced/bare 格式）、路径沙箱、web_fetch、边界情况等 15 个维度。无需凭证或网络连接。

---

## 技术实现

- **PoW 反爬**：嵌入 WASM 模块（base64 内联）计算 DeepSeekHashV1 / SHA256
- **CDP 登录**：Chrome DevTools Protocol 自动捕获 cookie 和 bearer token
- **SSE 解析**：从 OpenClaw Zero Token 移植 tagBuffer 状态机，支持 thinking/text/tool_call 标签
- **JSON 工具调用**：```tool_json 代码块（fenced）和内联 JSON（bare）两种格式解析
- **Hashline 安全编辑**：行级 SHA1 哈希标注、ref 解析、编辑冲突检测、fileRev 版本校验
- **路径沙箱**：resolveWorkspacePath 限定文件操作于工作目录内

---

## 参考与致谢

- OpenClaw Zero Token — https://github.com/linuxhsj/openclaw-zero-token/
- ds2api — https://github.com/CJackHwang/ds2api
- opencode-hashline — https://github.com/AngDrew/opencode-hashline
- DeepSeek — 免费网页对话服务
