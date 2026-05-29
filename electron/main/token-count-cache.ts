/**
 * Token Count Cache Proxy
 * 白名单模式：仅放行 /v1/messages 主 API，其余请求全部本地处理，不穿透到上游
 */
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'

const CACHE = new Map<string, { input_tokens: number; timestamp: number }>()
const CACHE_TTL = 10 * 60 * 1000 // 10分钟过期

function bodyHash(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex')
}

/**
 * 基于字符类型的加权 token 估算
 * - ASCII（英文、数字、符号）：约 4 字符/token
 * - 中日韩字符（CJK）：约 1.5 字符/token
 * - 其他 Unicode（表情、符号等）：约 2 字符/token
 */
function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (code < 128) {
      // ASCII（英文、数字、符号）
      tokens += 0.25
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK 统一汉字
      tokens += 0.67
    } else if (
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af)    // 韩文
    ) {
      // 日文/韩文
      tokens += 0.67
    } else {
      // 其他 Unicode（表情、特殊符号等）
      tokens += 0.5
    }
  }
  return Math.max(1, Math.round(tokens))
}

export function createTokenCountProxy(targetBaseUrl: string): Promise<{ port: number; url: string }> {
  const targetUrl = new URL(targetBaseUrl)
  const isHttps = targetUrl.protocol === 'https:'
  const httpModule = isHttps ? https : http

  const agent = isHttps
    ? new https.Agent({ keepAlive: true, maxSockets: 10 })
    : new http.Agent({ keepAlive: true, maxSockets: 10 })

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      res.end()
      return
    }

    const urlPath = req.url || '/'
    // ★ 白名单规则：
    // 1. POST /v1/messages（不含 count_tokens）→ 放行到上游
    // 2. GET /v1/models → 放行到上游（模型验证）
    // 3. 其余请求 → 本地处理，不穿透
    const isMessages = req.method === 'POST' && urlPath.startsWith('/v1/messages') && !urlPath.includes('/count_tokens')
    const isModels = req.method === 'GET' && urlPath.startsWith('/v1/models')
    const shouldPassThrough = isMessages || isModels

    if (!shouldPassThrough) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')

        if (urlPath.includes('/count_tokens')) {
          const hash = bodyHash(body)
          const cached = CACHE.get(hash)
          const estimated = estimateTokens(body)
          let tokens = estimated
          if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[Proxy] CACHE_HIT | tokens=${cached.input_tokens} | body=${body.length}B`)
            tokens = cached.input_tokens
          } else {
            CACHE.set(hash, { input_tokens: estimated, timestamp: Date.now() })
            console.log(`[Proxy] COUNT_TOKENS | tokens=${estimated} | body=${body.length}B`)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ input_tokens: tokens }))
        } else {
          console.log(`[Proxy] BLOCKED | ${req.method} ${urlPath} | body=${body.length}B`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ blocked: true }))
        }
      })
      return
    }

    // ★ 放行：POST /v1/messages → 流式透传到上游
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      console.log(`[Proxy] → PASS | POST ${urlPath} | body=${body.length}B`)

      const upstream = httpModule.request({
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        // ★ 拼接 baseUrl 的 pathname 前缀（如 /anthropic、/coding/anthropic）
        path: targetUrl.pathname.replace(/\/$/, '') + urlPath,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.hostname },
        agent,
        timeout: 120000,
      }, (upRes) => {
        res.writeHead(upRes.statusCode || 200, upRes.headers)
        upRes.on('data', (chunk: Buffer) => res.write(chunk))
        upRes.on('end', () => res.end())
      })

      upstream.on('timeout', () => {
        upstream.destroy()
        console.warn('[Proxy] Timeout:', urlPath)
        res.writeHead(504)
        res.end(JSON.stringify({ error: 'timeout' }))
      })

      upstream.on('error', (err: Error) => {
        console.error('[Proxy] Upstream error:', err.message)
        if (!res.headersSent) {
          res.writeHead(502)
          res.end(JSON.stringify({ error: 'upstream error' }))
        }
      })

      if (body) upstream.write(body)
      upstream.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      console.log(`[Proxy] 127.0.0.1:${addr.port} → ${targetBaseUrl} (whitelist: /v1/messages only)`)
      resolve({ port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
    server.on('error', reject)
  })
}
