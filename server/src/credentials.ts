import * as fs from "node:fs"
import * as path from "node:path"
import type { Credentials } from "./types.js"

export const DEEPSEEK_CONFIG_DIR =
  process.env.DEEPSEEK_CONFIG_DIR || path.join(process.cwd(), "server/.deepseek")

const CRED_FILE = path.join(DEEPSEEK_CONFIG_DIR, "credentials.json")

export function saveCredentials(cred: Credentials): void {
  fs.mkdirSync(DEEPSEEK_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CRED_FILE, JSON.stringify(cred, null, 2))
}

export function loadCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CRED_FILE)) return null
    return JSON.parse(fs.readFileSync(CRED_FILE, "utf-8")) as Credentials
  } catch {
    return null
  }
}

export function loadCredentialsFromPath(dirPath: string): Credentials | null {
  try {
    const filePath = path.join(dirPath, "credentials.json")
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Credentials
  } catch {
    return null
  }
}

export async function verifyCredentials(
  cred: Credentials
): Promise<{ valid: boolean; email?: string }> {
  try {
    const res = await fetch("https://chat.deepseek.com/api/v0/users/current", {
      headers: {
        Cookie: cred.cookie,
        "User-Agent": cred.userAgent,
        Accept: "application/json",
        Referer: "https://chat.deepseek.com/",
        Origin: "https://chat.deepseek.com",
      },
      signal: AbortSignal.timeout(15000),
    })
    if (res.ok) {
      const data: any = await res.json()
      const email = data?.data?.biz_data?.email || data?.data?.email || ""
      return { valid: true, email }
    }
    return { valid: false }
  } catch {
    return { valid: false }
  }
}

export async function ensureCredentials(
  log: (msg: string) => void
): Promise<Credentials> {
  let cred = loadCredentials()
  if (!cred || !cred.bearer || !cred.cookie) {
    if (cred && !cred.bearer) {
      log("凭证文件损坏")
    } else {
      log("凭证缺失")
    }
    throw new Error(
      "未找到有效凭据。请先运行 CLI 登录：\n" +
        "  cd deepseek-web-cli-v3/cli && npx tsx login.ts\n" +
        "  或设置 DEEPSEEK_CONFIG_DIR 指向包含 credentials.json 的目录"
    )
  }

  const { valid, email } = await verifyCredentials(cred)
  if (!valid) {
    log("凭证已过期")
    throw new Error(
      "凭据已过期。请重新运行 CLI 登录：\n" +
        "  cd deepseek-web-cli-v3/cli && npx tsx login.ts"
    )
  }

  if (email) log(`凭据有效 (${email})`)
  return cred
}
