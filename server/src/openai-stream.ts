import type { ParseEvent } from "./deepseek-client.js"

export interface OpenAIStreamOptions {
  model: string
  includeToolCalls: boolean
}

export function createOpenAIStream(
  events: AsyncGenerator<ParseEvent>,
  options: OpenAIStreamOptions,
): ReadableStream<Uint8Array> {
  const chatId = "chatcmpl-" + randomId()
  const created = Math.floor(Date.now() / 1000)

  const encoder = new TextEncoder()

  let finished = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const firstChunk = buildSSE({
        id: chatId,
        object: "chat.completion.chunk",
        created,
        model: options.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      })
      controller.enqueue(encoder.encode(firstChunk))

      try {
        for await (const event of events) {
          if (finished) break

          switch (event.type) {
            case "text_delta": {
              controller.enqueue(
                encoder.encode(
                  buildTextDelta(chunkPayload()),
                ),
              )
              const chunk = chunkPayload()
              chunk.choices[0].delta.content = event.content
              controller.enqueue(encoder.encode(buildSSE(chunk)))
              break
            }

            case "thinking_delta": {
              const chunk = chunkPayload()
              chunk.choices[0].delta.reasoning_content = event.content
              controller.enqueue(encoder.encode(buildSSE(chunk)))
              break
            }

            case "tool_call_start": {
              // start 跳过，由 tool_call_end 整体发出
              break
            }

            case "tool_call_delta": {
              // delta 跳过，由 tool_call_end 整体发出
              break
            }

            case "tool_call_end": {
              if (!options.includeToolCalls) break
              const callId = event.id || "call_" + randomId()
              const chunk = chunkPayload()
              chunk.choices[0].delta.tool_calls = [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: {
                    name: event.name,
                    arguments: JSON.stringify(event.arguments),
                  },
                },
              ]
              controller.enqueue(encoder.encode(buildSSE(chunk)))
              break
            }

            case "end": {
              const chunk = chunkPayload()
              chunk.choices[0].delta = {} as any
              chunk.choices[0].finish_reason = "stop"
              controller.enqueue(encoder.encode(buildSSE(chunk)))
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              finished = true
              break
            }

            case "error": {
              const chunk = chunkPayload()
              chunk.choices[0].delta = {} as any
              chunk.choices[0].finish_reason = "error"
              controller.enqueue(encoder.encode(buildSSE(chunk)))
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              finished = true
              break
            }

            default:
              break
          }
        }

        if (!finished) {
          const chunk = chunkPayload()
          chunk.choices[0].delta = {} as any
          chunk.choices[0].finish_reason = "stop"
          controller.enqueue(encoder.encode(buildSSE(chunk)))
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        }
      } catch (err: any) {
        const errorPayload = JSON.stringify({
          error: { message: err.message, type: "server_error" },
        })
        controller.enqueue(encoder.encode(`data: ${errorPayload}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      } finally {
        controller.close()
      }
    },
  })

  function chunkPayload(): any {
    return {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: {} as Record<string, unknown>,
          finish_reason: null,
        },
      ],
    }
  }
}

function buildSSE(obj: object): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function buildTextDelta(chunk: any): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function randomId(length = 29): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}
