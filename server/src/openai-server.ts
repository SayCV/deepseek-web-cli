import * as http from "node:http"
import { loadCredentials } from "./credentials.js"
import { DeepSeekClient, StreamParser, ParseEvent } from "./deepseek-client.js"
import { createOpenAIStream } from "./openai-stream.js"
import type { Credentials, ToolDefinition } from "./types.js"

export interface StartServerOptions {
  port?: number
  host?: string
  credentials?: Credentials
}

interface ClientState {
  client: DeepSeekClient
  sessionId: string
  parentMessageId: number | null
  fingerprint: string
}

const clientStates = new Map<string, ClientState>()

// ==================== Tool Prompt Injection ====================
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

async function getOrCreateSession(
  creds: Credentials,
  authKey: string,
): Promise<{ client: DeepSeekClient; sessionId: string }> {
  let state = clientStates.get(authKey)
  if (state && state.client) {
    return { client: state.client, sessionId: state.sessionId }
  }

  const client = new DeepSeekClient(creds)
  const sessionId = await client.createChatSession()

  state = {
    client,
    sessionId,
    parentMessageId: null,
    fingerprint: "",
  }
  clientStates.set(authKey, state)

  return { client, sessionId }
}

async function chatWithRetry(
  client: DeepSeekClient,
  authKey: string,
  creds: Credentials,
  rebuildPrompt: () => string,
  ...args: Parameters<DeepSeekClient["chat"]>
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await client.chat(...args)
  } catch {
    const newClient = new DeepSeekClient(creds)
    const newSessionId = await newClient.createChatSession()
    clientStates.set(authKey, {
      client: newClient,
      sessionId: newSessionId,
      parentMessageId: null,
      fingerprint: "",
    })
    args[0] = newSessionId
    args[1] = null
    args[2] = rebuildPrompt()
    return newClient.chat(...args)
  }
}

function updateParentMessageId(
  authKey: string,
  parentMessageId: number,
): void {
  const state = clientStates.get(authKey)
  if (state) {
    state.parentMessageId = parentMessageId
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

export function cleanupSession(sessionId: string): void {
  const keysToDelete: string[] = []
  for (const [key, state] of clientStates) {
    if (state.sessionId === sessionId) {
      keysToDelete.push(key)
    }
  }
  for (const key of keysToDelete) {
    clientStates.delete(key)
  }
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<http.Server> {
  const port = options.port ?? 8899
  const host = options.host ?? "127.0.0.1"

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

      if (url.pathname === "/health" || url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: "ok" }))
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

        const model = body.model || "deepseek-chat"
        const modelType = modelToType(model)
        const thinkingEnabled = modelType === "expert"

        const { client, sessionId: origSessionId } = await getOrCreateSession(
          creds,
          authKey,
        )

        const normalizedTools = body.tools?.length ? convertOpenAITools(body.tools) : []

        let systemPrompt = ""
        let lastUserContent = ""
        let history = ""
        let assistantContent = ""
        let toolResults = ""
        for (const msg of body.messages || []) {
          if (msg.role === "system") {
            systemPrompt += msg.content + "\n"
          } else if (msg.role === "user") {
            lastUserContent = msg.content
            if (history) history += "\n"
            history += "用户: " + msg.content
          } else if (msg.role === "assistant") {
            if (msg.tool_calls) {
              for (const tc of msg.tool_calls) {
                assistantContent += `[调用 ${tc.function?.name || "unknown"}(${tc.function?.arguments})]\n`
              }
            } else if (msg.content) {
              if (history) history += "\n"
              history += "助手: " + msg.content
            }
          } else if (msg.role === "tool") {
            toolResults += `[工具返回]\n${msg.content}\n`
          }
        }

        const hasAssistantMessages = (body.messages || []).some(
          (m: any) => m.role === "assistant"
        )
        const firstUser = (body.messages || []).find((m: any) => m.role === "user")
        const fingerprint = (systemPrompt.slice(0, 100) + "|||" + (firstUser?.content || "")).slice(0, 200)
        const existingState = clientStates.get(authKey)
        const needsNewSession =
          !existingState ||
          !hasAssistantMessages ||
          existingState.fingerprint !== fingerprint

        if (needsNewSession) {
          const newSessionId = await client.createChatSession()
          clientStates.set(authKey, {
            client,
            sessionId: newSessionId,
            parentMessageId: null,
            fingerprint,
          })
        }

        const { sessionId } = clientStates.get(authKey)!
        const initialWithHistory = needsNewSession && hasAssistantMessages

        const buildPrompt = (withHistory: boolean) => {
          let p = systemPrompt
          if (normalizedTools.length > 0) {
            p += "\n" + buildToolPrompt(normalizedTools) + "\n"
          }
          if (withHistory && history) {
            p += "\n--- 对话历史 ---\n" + history + "\n---\n"
          } else if (!withHistory && lastUserContent) {
            p += lastUserContent + "\n"
          }
          if (assistantContent) p += assistantContent
          if (toolResults) p += toolResults
          return p
        }

        const isStream = body.stream !== false

        if (isStream) {
          const parser = new StreamParser()
          const dsStream = await chatWithRetry(
            client,
            authKey,
            creds,
            () => buildPrompt(true),
            sessionId,
            clientStates.get(authKey)?.parentMessageId ?? null,
            buildPrompt(initialWithHistory),
            thinkingEnabled,
            false,
            modelType,
            [],
            undefined,
            undefined,
          )

          const rawEvents = parser.parse(dsStream)

          const events = (async function* () {
            if (normalizedTools.length > 0) {
              const allEvents: ParseEvent[] = []
              for await (const event of rawEvents) {
                if (event.type === "message_id") {
                  updateParentMessageId(authKey, event.id)
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
              yield { type: "end" } as ParseEvent
            } else {
              for await (const event of rawEvents) {
                if (event.type === "message_id") {
                  updateParentMessageId(authKey, event.id)
                }
                yield event
              }
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
          return
        }

        const parser = new StreamParser()
        const dsStream = await chatWithRetry(
          client,
          authKey,
          creds,
          () => buildPrompt(true),
          sessionId,
          clientStates.get(authKey)?.parentMessageId ?? null,
          buildPrompt(initialWithHistory),
          thinkingEnabled,
          false,
          modelType,
          [],
          undefined,
          undefined,
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
      console.log(
        `DeepSeek OpenAI API 服务已启动`,
      )
      console.log(`  地址: http://${host}:${port}`)
      console.log(`  API:  http://${host}:${port}/v1/chat/completions`)
      console.log(`  模型: http://${host}:${port}/v1/models`)
      console.log(`  健康: http://${host}:${port}/health`)
      resolve(server)
    })
  })
}
