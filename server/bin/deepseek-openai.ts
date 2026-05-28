#!/usr/bin/env node
import { startServer } from "../src/openai-server.js"

function readArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

async function main() {
  const command = process.argv[2] || "serve"

  if (command === "serve") {
    const host = readArg("--host", process.env.HOST || "127.0.0.1")
    const port = Number(readArg("--port", process.env.PORT || "8899"))
    await startServer({ host, port })
    return
  }

  console.error(`Unknown command: ${command}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
