import * as http from "node:http"
import * as path from "node:path"
import * as fs from "node:fs"
import * as crypto from "node:crypto"
import { loadCredentials } from "./credentials.js"
import { DeepSeekClient, StreamParser, ParseEvent } from "./deepseek-client.js"
import { createOpenAIStream } from "./openai-stream.js"
import type { Credentials, ToolDefinition } from "./types.js"

let DEBUG = false
function debugLog(...args: any[]) {
  if (DEBUG) console.log(...args)
}

export interface StartServerOptions {
  port?: number
  host?: string
  credentials?: Credentials
  debug?: boolean
}

interface ConversationState {
  client: DeepSeekClient
  sessionId: string
  parentMessageId: number | null
}

const sessions = new Map<string, Map<string, ConversationState>>()

const SESSIONS_FILE = path.join(
  process.env.DEEPSEEK_CONFIG_DIR || path.join(path.dirname(new URL(import.meta.url).pathname), ".."),
  ".deepseek", "sessions.json"
)

function saveSessions() {
  try {
    const dir = path.dirname(SESSIONS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const data: Record<string, Record<string, { sessionId: string; parentMessageId: number | null }>> = {}
    for (const [authKey, conversations] of sessions) {
      const authData: Record<string, { sessionId: string; parentMessageId: number | null }> = {}
      for (const [fingerprint, conv] of conversations) {
        authData[fingerprint] = { sessionId: conv.sessionId, parentMessageId: conv.parentMessageId }
      }
      data[authKey] = authData
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data))
  } catch {}
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"))
    for (const [authKey, authData] of Object.entries(data)) {
      const conversations = new Map<string, ConversationState>()
      const record = authData as Record<string, any>
      for (const [fingerprint, conv] of Object.entries(record)) {
        conversations.set(fingerprint, {
          client: null as any,
          sessionId: (conv as any).sessionId,
          parentMessageId: (conv as any).parentMessageId ?? null,
        })
      }
      sessions.set(authKey, conversations)
    }
  } catch {}
}

// ━━━━━━━━━━━━━ Tool Prompt Injection ━━━━━━━━━━━━━
// DeepSeek web API does not natively support OpenAI-compatible tool calls.
// Instead we inject tool definitions into the prompt and parse the
// response text for ```tool_json { ... }``` code blocks.

const FENCED_TOOL_JSON_REGEX = /```tool_json\s*\n?\s*(\{[\s\S]*\})\s*\n?\s*```/

interface ExtractedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

function convertOpenAITools(tools: any[]): { name: string; description: string; parameters: Record<string, string> }[] {
  return tools.map(t => {
    const fn = t.function || t
    const params: Record<string, string> = {}
    if (fn.parameters?.properties) {
      for (const [key, val] of Object.entries(fn.parameters.properties as Record<string, any>)) {
        params[key] = (val as any).type || "string"
      }
    }
    return { name: fn.name, description: fn.description, parameters: params }
  })
}

function buildToolPrompt(tools: { name: string; description: string; parameters: Record<string, string> }[]): string {
  const compact = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
  return [
    "## 可用工具",
    JSON.stringify(compact),
    "调用工具时，只回复以下格式的代码块，不要附加任何说明文字：",
    "```tool_json",
    '{"tool":"工具名","parameters":{参数对象}}',
    "```",
  ].join("\n")
}

function extractToolCallsFromText(text: string): ExtractedToolCall[] {
  const results: ExtractedToolCall[] = []
  const fenced = text.match(FENCED_TOOL_JSON_REGEX)
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1])
      if (parsed.tool && typeof parsed.parameters === "object") {
        results.push({
          id: "call_" + randomStr(24),
          name: parsed.tool,
          arguments: parsed.parameters as Record<string, unknown>,
        })
      }
    } catch {}
  }
  return results
}

function stripToolJson(text: string): string | null {
  const idx = text.indexOf("```tool_json")
  if (idx === -1) return text
  const before = text.substring(0, idx).trim()
  const endIdx = text.indexOf("```", idx + 12)
  const after = endIdx !== -1 ? text.substring(endIdx + 3).trim() : ""
  const result = (before + " " + after).trim()
  return result || null
}

const AVAILABLE_MODELS = [
  { id: "deepseek-flash", object: "model", created: 1735689600, owned_by: "deepseek" },
  { id: "deepseek-pro", object: "model", created: 1735689600, owned_by: "deepseek" },
]

function modelToType(model: string): string {
  const lower = model.toLowerCase()
  if (lower === "deepseek-pro") return "expert"
  return "default"
}

function idToModelName(id: string): string {
  return id === "deepseek-flash" ? "deepseek-flash" : "deepseek-pro"
}

async function getOrCreateClient(creds: Credentials, authKey: string): Promise<DeepSeekClient> {
  const conversations = sessions.get(authKey)
  if (conversations) {
    for (const conv of conversations.values()) {
      if (conv.client) return conv.client
    }
  }
  return new DeepSeekClient(creds)
}

async function chatWithRetry(
  client: DeepSeekClient,
  authKey: string,
  fingerprint: string,
  creds: Credentials,
  rebuildPrompt: () => string,
  ...args: Parameters<DeepSeekClient["chat"]>
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await client.chat(...args)
  } catch {
    const newClient = new DeepSeekClient(creds)
    const newSessionId = await newClient.createChatSession()
    const conversations = sessions.get(authKey)
    if (conversations) {
      conversations.set(fingerprint, {
        client: newClient,
        sessionId: newSessionId,
        parentMessageId: null,
      })
      saveSessions()
    }
    args[0] = newSessionId
    args[1] = null
    args[2] = rebuildPrompt()
    return newClient.chat(...args)
  }
}

function updateParentMessageId(
  authKey: string,
  fingerprint: string,
  parentMessageId: number,
): void {
  const conv = sessions.get(authKey)?.get(fingerprint)
  if (conv) {
    conv.parentMessageId = parentMessageId
    saveSessions()
  }
}

function extractMessageId(events: ParseEvent[]): number | null {
  for (const event of events) {
    if (event.type === "message_id") return event.id
  }
  return null
}

async function collectEvents(
  parser: StreamParser,
  stream: ReadableStream<Uint8Array>,
): Promise<ParseEvent[]> {
  const events: ParseEvent[] = []
  for await (const event of parser.parse(stream)) {
    events.push(event)
  }
  return events
}

function randomStr(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

let roundCounter = 0

export function cleanupSession(sessionId: string): void {
  for (const [authKey, conversations] of sessions) {
    for (const [fingerprint, conv] of conversations) {
      if (conv.sessionId === sessionId) {
        conversations.delete(fingerprint)
        if (conversations.size === 0) sessions.delete(authKey)
        return
      }
    }
  }
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<http.Server> {
  const port = options.port ?? 8899
  const host = options.host ?? "127.0.0.1"
  DEBUG = options.debug ?? false

  let creds: Credentials

  if (options.credentials) {
    creds = options.credentials
  } else {
    const loaded = loadCredentials()
    if (!loaded) {
      console.error(
        "未找到有效凭据。请先运行 CLI 登录。",
      )
      process.exit(1)
    }
    creds = loaded
  }

  loadSessions()

  const server = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = new URL(req.url || "/", `http://${host}:${port}`)
      const method = req.method || "GET"

      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

      if (method === "OPTIONS") {
        res.writeHead(204)
        res.end()
        return
      }

      if (url.pathname === "/v1/models" || url.pathname === "/api/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: AVAILABLE_MODELS,
          }),
        )
        return
      }

      if (
        url.pathname === "/v1/chat/completions" &&
        method === "POST"
      ) {
        const authKey = req.headers.authorization || "default"
        const loadedCreds = loadCredentials()
        if (!loadedCreds) {
          res.writeHead(401, { "Content-Type": "application/json" })
          res.end(
            JSON.stringify({
              error: {
                message: "Unauthorized: no credentials found",
                type: "authentication_error",
              },
            }),
        )
        if (isOneShot) client.deleteSession(sessionId).catch(() => {})
        return
        }
        creds = loadedCreds

        const bodyChunks: Buffer[] = []
        for await (const chunk of req) {
          bodyChunks.push(chunk)
        }
        const bodyStr = Buffer.concat(bodyChunks).toString()
        let body: any
        try {
          body = JSON.parse(bodyStr)
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { message: "Invalid JSON" } }))
          return
        }

        const roundNum = ++roundCounter
        const msgCount = (body.messages || []).length
        debugLog(`\n${"━".repeat(60)}`)
        debugLog(`[ROUND ${roundNum}] NEW REQUEST  model=${body.model || "?"}  messages=${msgCount}`)
        debugLog(`${"━".repeat(60)}`)

        const model = body.model || "deepseek-chat"
        const modelType = modelToType(model)
        const thinkingEnabled = modelType === "expert"

        const normalizedTools = body.tools?.length ? convertOpenAITools(body.tools) : []

        let systemPrompt = ""
        let lastUserContent = ""
        let assistantContent = ""
        let toolResults = ""
        let currentAssistant = ""
        let currentTools = ""
        for (const msg of body.messages || []) {
          if (msg.role === "system") {
            systemPrompt += msg.content + "\n"
          } else if (msg.role === "user") {
            lastUserContent = msg.content
            currentAssistant = ""
            currentTools = ""
          } else if (msg.role === "assistant") {
            if (msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                const line = `[调用 ${tc.function?.name || "unknown"}(${tc.function?.arguments})]\n`
                assistantContent += line
                currentAssistant += line
              }
            }
          } else if (msg.role === "tool") {
            const block = `[工具返回]\n${msg.content}\n`
            toolResults += block
            currentTools += block
          }
        }

        const isOneShot = normalizedTools.length === 0 && !systemPrompt.includes("opencode")

        let client: DeepSeekClient
        let sessionId: string
        let fingerprint = ""

        if (isOneShot) {
          client = new DeepSeekClient(creds)
          sessionId = await client.createChatSession()
        } else {
          const firstUser = (body.messages || []).find((m: any) => m.role === "user")
          fingerprint = crypto.createHash("sha256").update(authKey + "::" + (firstUser?.content || "")).digest("hex").slice(0, 16)

          client = await getOrCreateClient(creds, authKey)

          const conversations = sessions.get(authKey) || new Map()
          sessions.set(authKey, conversations)

          const hasAssistantMessages = (body.messages || []).some(
            (m: any) => m.role === "assistant"
          )

          let convState = conversations.get(fingerprint)
          if (!convState || !hasAssistantMessages) {
            sessionId = await client.createChatSession()
            convState = { client, sessionId, parentMessageId: null }
            conversations.set(fingerprint, convState)
            saveSessions()
          }

          sessionId = conversations.get(fingerprint)!.sessionId
        }

        const isFirstMessage = isOneShot || !sessions.get(authKey)?.get(fingerprint)?.parentMessageId

        if (!isFirstMessage) {
          assistantContent = currentAssistant
          toolResults = currentTools
        }

        if (isOneShot) {
          debugLog(`[REQ] Session: (one-shot)  sessionId: ${sessionId.slice(0, 12)}...`)
        } else {
          const curConv = sessions.get(authKey)!.get(fingerprint)!
          debugLog(`[REQ] Session: ${curConv.sessionId.slice(0, 12)}...  fingerprint: ${fingerprint.slice(0, 8)}  parentMsgId: ${curConv.parentMessageId ?? "(null/首条)"}`)
        }

        let prompt = ""
        if (isFirstMessage) {
          prompt = systemPrompt
          if (normalizedTools.length > 0) {
            prompt += "\n" + buildToolPrompt(normalizedTools) + "\n"
          }
        }
        if (assistantContent) prompt += assistantContent
        if (toolResults) prompt += toolResults
        if (lastUserContent && (isFirstMessage || !assistantContent)) {
          prompt += "用户: " + lastUserContent + "\n"
        }

        debugLog(`[REQ] Prompt mode: ${isFirstMessage ? "FULL (含 system + tools)" : "INCREMENTAL (仅增量)"}`)
        if (isFirstMessage) {
          debugLog("[REQ] ━━━━━━━━━━━━━ SYSTEM PROMPT ━━━━━━━━━━━━━")
          debugLog(systemPrompt || "(无)")
          debugLog("[REQ] ━━━━━━━━━━━━━ TOOL DEFINITIONS ━━━━━━━━━━━━━")
          debugLog(normalizedTools.length > 0 ? buildToolPrompt(normalizedTools) : "(无)")
        }
        debugLog("[REQ] ━━━━━━━━━━━━━ ACTUAL PROMPT SENT ━━━━━━━━━━━━━")
        debugLog(prompt || "(空)")
        debugLog("[REQ] ━━━━━━━━━━━━━ END ━━━━━━━━━━━━━")

        const recoveryPrompt = (() => {
          let p = systemPrompt
          if (normalizedTools.length > 0) p += "\n" + buildToolPrompt(normalizedTools) + "\n"
          for (const msg of body.messages || []) {
            if (msg.role === "user") {
              p += "用户: " + msg.content + "\n"
            } else if (msg.role === "assistant") {
              if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                  p += `[调用 ${tc.function?.name || "unknown"}(${tc.function?.arguments})]\n`
                }
              } else if (msg.content) {
                p += "助手: " + msg.content + "\n"
              }
            } else if (msg.role === "tool") {
              p += `[工具返回]\n${msg.content}\n`
            }
          }
          return p
        })();

        const isStream = body.stream !== false

        if (isStream) {
          const parser = new StreamParser()
          const dsStream = isOneShot
            ? await client.chat(
                sessionId, null, prompt, thinkingEnabled, false, modelType, [], undefined, undefined,
              )
            : await chatWithRetry(
                client, authKey, fingerprint, creds, () => recoveryPrompt,
                sessionId, sessions.get(authKey)?.get(fingerprint)?.parentMessageId ?? null,
                prompt, thinkingEnabled, false, modelType, [], undefined, undefined,
              )

          const rawEvents = parser.parse(dsStream)

          const events = (async function* () {
            if (normalizedTools.length > 0) {
              const allEvents: ParseEvent[] = []
              for await (const event of rawEvents) {
                if (event.type === "message_id") {
                  updateParentMessageId(authKey, fingerprint, event.id)
                }
                allEvents.push(event)
              }
              let fullText = ""
              const nativeToolCalls: ParseEvent[] = []
              for (const e of allEvents) {
                if (e.type === "text_delta") fullText += e.content
                if (e.type === "tool_call_start" || e.type === "tool_call_delta" || e.type === "tool_call_end") {
                  nativeToolCalls.push(e)
                }
              }
              const foundToolCalls = extractToolCallsFromText(fullText)
              if (foundToolCalls.length > 0) {
                const cleaned = stripToolJson(fullText)
                if (cleaned) yield { type: "text_delta", content: cleaned } as ParseEvent
                for (const tc of foundToolCalls) {
                  yield { type: "tool_call_start", id: tc.id, name: tc.name } as ParseEvent
                  yield { type: "tool_call_end", id: tc.id, name: tc.name, arguments: tc.arguments } as ParseEvent
                }
              } else if (nativeToolCalls.length > 0) {
                for (const e of allEvents) {
                  if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "tool_call_start" || e.type === "tool_call_delta" || e.type === "tool_call_end") {
                    yield e
                  }
                }
              } else {
                for (const e of allEvents) {
                  if (e.type === "text_delta" || e.type === "thinking_delta") {
                    yield e
                  }
                }
              }
              debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ STREAM RESPONSE ━━━━━━━━━━━━━`)
              debugLog(`Text: ${fullText || "(无)"}`)
              if (nativeToolCalls.length > 0) debugLog(`Native tool calls: ${nativeToolCalls.length}`)
              debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ END ━━━━━━━━━━━━━`)
              yield { type: "end" } as ParseEvent
            } else {
              let streamText = ""
              for await (const event of rawEvents) {
                if (event.type === "message_id") {
                  updateParentMessageId(authKey, fingerprint, event.id)
                }
                if (event.type === "text_delta") streamText += event.content
                yield event
              }
              debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ STREAM RESPONSE ━━━━━━━━━━━━━`)
              debugLog(`Text: ${streamText || "(无)"}`)
              debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ END ━━━━━━━━━━━━━`)
            }
          })()

          const openaiStream = createOpenAIStream(events, {
            model: idToModelName(model),
            includeToolCalls: true,
          })

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          })

          const reader = openaiStream.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              res.write(value)
            }
          } catch (err: any) {
            const errorPayload = JSON.stringify({
              error: { message: err.message, type: "server_error" },
            })
            res.write(`data: ${errorPayload}\n\n`)
            res.write("data: [DONE]\n\n")
          }
          res.end()
          if (isOneShot) client.deleteSession(sessionId).catch(() => {})
          return
        }

        const parser = new StreamParser()
        const dsStream = isOneShot
          ? await client.chat(
              sessionId, null, prompt, thinkingEnabled, false, modelType, [], undefined, undefined,
            )
          : await chatWithRetry(
              client, authKey, fingerprint, creds, () => recoveryPrompt,
              sessionId, sessions.get(authKey)?.get(fingerprint)?.parentMessageId ?? null,
              prompt, thinkingEnabled, false, modelType, [], undefined, undefined,
            )

        const events = await collectEvents(parser, dsStream)

        let content = ""
        const toolCalls: any[] = []
        for (const event of events) {
          if (event.type === "text_delta") content += event.content
          if (event.type === "tool_call_end") {
            toolCalls.push({
              id: event.id,
              type: "function",
              function: {
                name: event.name,
                arguments: JSON.stringify(event.arguments),
              },
            })
          }
          if (event.type === "message_id") {
            updateParentMessageId(authKey, event.id)
          }
        }

        if (toolCalls.length === 0 && normalizedTools.length > 0) {
          const foundToolCalls = extractToolCallsFromText(content)
          if (foundToolCalls.length > 0) {
            for (const tc of foundToolCalls) {
              toolCalls.push({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.arguments),
                },
              })
            }
            content = stripToolJson(content) || null
          }
        }

        debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ RESPONSE ━━━━━━━━━━━━━`)
        debugLog(`Text: ${content || "(无)"}`)
        if (toolCalls.length > 0) debugLog(`Tool calls: ${JSON.stringify(toolCalls)}`)
        debugLog(`\n[ROUND ${roundNum}] ━━━━━━━━━━━━━ END ━━━━━━━━━━━━━`)

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            id: "chatcmpl-" + randomStr(29),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: toolCalls.length > 0 ? null : content,
                  tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
                },
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
          }),
        )
        return
      }

      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "Not found" } }))
    },
  )

  return new Promise<http.Server>((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, host, () => {
      console.log(`DeepSeek OpenAI API 服务已启动`)
      console.log(`  地址: http://${host}:${port}`)
      console.log(`  API:  http://${host}:${port}/v1/chat/completions`)
      console.log(`  模型: http://${host}:${port}/v1/models`)
      resolve(server)
    })
  })
}
