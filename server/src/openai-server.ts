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
}

const clientStates = new Map<string, ClientState>()

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
  }
  clientStates.set(authKey, state)

  return { client, sessionId }
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

async function handleChatCompletion(
  creds: Credentials,
  body: any,
  authKey: string,
): Promise<http.ServerResponse> {
  const stream = body.stream !== false
  const tools = body.tools || body.toolsSchema
  const modelType = modelToType(body.model || "deepseek-chat")

  const { client, sessionId } = await getOrCreateSession(creds, authKey)
  const state = clientStates.get(authKey)!

  const toolRegistry = new ToolRegistry()
  registerBuiltinTools(toolRegistry)

  const toolExecutor = new ToolExecutor(toolRegistry)
  const thinkingEnabled = modelType === "expert"

  const maxToolIterations = 10
  let prompt = ""
  let lastMessageId: number | null = null

  for (const msg of body.messages) {
    if (msg.role === "system") {
      prompt += msg.content + "\n"
    } else if (msg.role === "tool") {
      prompt += `\n[工具结果: ${msg.tool_call_id}]\n${msg.content}\n`
    } else if (msg.role === "assistant") {
      prompt += msg.content || ""
    } else if (msg.role === "user") {
      prompt += msg.content || ""
    }
  }

  let finalStream: ReadableStream<Uint8Array> | null = null
  let allToolCalls: ParseEvent[] = []

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    const parser = new StreamParser()
    const dsStream = await client.chat(
      sessionId,
      state.parentMessageId,
      prompt,
      thinkingEnabled,
      false,
      modelType,
      [],
      undefined,
      body.tools,
    )

    const events = await collectEvents(parser, dsStream)

    const toolCalls: ParseEvent[] = []
    let hasToolCalls = false

    for (const event of events) {
      if (event.type === "tool_call_end") {
        hasToolCalls = true
        toolCalls.push(event)
      }
      if (event.type === "message_id") {
        lastMessageId = event.id
      }
    }

    if (!hasToolCalls) {
      finalStream = await client.chat(
        sessionId,
        state.parentMessageId,
        prompt,
        thinkingEnabled,
        false,
        modelType,
        [],
        undefined,
        body.tools,
      )
      allToolCalls = events.filter(
        (e) => e.type === "tool_call_end" || e.type === "tool_call_start",
      )
      break
    }

    for (const tc of toolCalls) {
      if (tc.type !== "tool_call_end") continue
      try {
        const result = await toolExecutor.execute(
          tc.name,
          tc.arguments,
        )
        prompt += `\n[工具结果: ${tc.name}]\n${result}\n`
      } catch (err: any) {
        prompt += `\n[工具错误: ${tc.name}]\n${err.message}\n`
      }
    }

    if (iteration === maxToolIterations - 1) {
      const lastParser = new StreamParser()
      finalStream = await client.chat(
        sessionId,
        state.parentMessageId,
        prompt,
        thinkingEnabled,
        false,
        modelType,
        [],
        undefined,
        body.tools,
      )
    }
  }

  if (lastMessageId) {
    updateParentMessageId(authKey, lastMessageId)
  }

  if (stream) {
    const lastParser = new StreamParser()
    const eventSource = lastParser.parse(finalStream!)

    if (allToolCalls.length > 0) {
      const includeToolCalls = true
      const openaiStream = createOpenAIStream(
        eventSource,
        { model: body.model || "deepseek-chat", includeToolCalls },
      )
      const reader = openaiStream.getReader()
      const responseStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
        },
      })
      const buf = await collectStream(responseStream)
      return createResponse(200, { "Content-Type": "text/event-stream" }, buf)
    }

    const includeToolCalls = true
    const openaiStream = createOpenAIStream(
      eventSource,
      { model: body.model || "deepseek-chat", includeToolCalls },
    )
    const reader = openaiStream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    const buf = Buffer.concat(chunks)
    return createResponse(200, { "Content-Type": "text/event-stream" }, buf)
  }

  const parser = new StreamParser()
  const events = await collectEvents(parser, finalStream!)

  let content = ""
  for (const event of events) {
    if (event.type === "text_delta") content += event.content
  }

  const responseBody = JSON.stringify({
    id: "chatcmpl-" + randomStr(29),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model || "deepseek-chat",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  })

  return createResponse(
    200,
    { "Content-Type": "application/json" },
    Buffer.from(responseBody),
  )
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function createResponse(
  status: number,
  headers: Record<string, string>,
  body: Buffer,
): http.ServerResponse {
  const res = new http.ServerResponse(
    null as any,
  ) as http.ServerResponse & { _status: number; _headers: Record<string, string>; _body: Buffer }
  ;(res as any)._status = status
  ;(res as any)._headers = headers
  ;(res as any)._body = body
  return res
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

        const { client, sessionId } = await getOrCreateSession(
          creds,
          authKey,
        )

        let prompt = ""
        for (const msg of body.messages || []) {
          if (msg.role === "system") {
            prompt += msg.content + "\n"
          } else if (msg.role === "user") {
            prompt += msg.content + "\n"
          } else if (msg.role === "assistant") {
            if (msg.content) prompt += msg.content + "\n"
          } else if (msg.role === "tool") {
            prompt += `[工具结果: ${msg.tool_call_id}] ${msg.content}\n`
          }
        }

        const isStream = body.stream !== false

        if (isStream) {
          const parser = new StreamParser()
          const dsStream = await client.chat(
            sessionId,
            clientStates.get(authKey)?.parentMessageId ?? null,
            prompt,
            thinkingEnabled,
            false,
            modelType,
            [],
            undefined,
            body.tools,
          )

          const openaiStream = createOpenAIStream(parser.parse(dsStream), {
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
        const dsStream = await client.chat(
          sessionId,
          clientStates.get(authKey)?.parentMessageId ?? null,
          prompt,
          thinkingEnabled,
          false,
          modelType,
          [],
          undefined,
          body.tools,
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
