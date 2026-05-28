export interface Credentials {
  cookie: string
  bearer: string
  userAgent: string
}

export interface MessageRecord {
  role: "user" | "assistant"
  content: string
  timestamp: number
  messageId?: number
  parentMessageId: number | null
}

export interface SessionState {
  id: string
  title: string
  parentMessageId: number | null
  messages: MessageRecord[]
  forkedFrom?: string
  thinkEnabled: boolean
  searchEnabled: boolean
  modelType: string
  pendingFileIds: string[]
  createdAt: number
  updatedAt: number
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string }>
}

export interface ParsedToolCall {
  tool: string
  parameters: Record<string, unknown>
}

export interface HlOperation {
  op: "replace" | "delete" | "insert_before" | "insert_after" | "replace_range" | "set_file"
  ref?: string
  startRef?: string
  endRef?: string
  content?: string
}

export interface ResolvedChange {
  spliceStart: number
  deleteCount: number
  insertLines: string[]
  order: number
  label: string
}

// OpenAI API types
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  name?: string
  tool_call_id?: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  tools?: Array<{
    type: "function"
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
}

export type AiMessage = { role: "user" | "assistant"; content: string }
