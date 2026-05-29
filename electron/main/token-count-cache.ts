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
    const isMessages = req.method === 'POST' && urlPath.startsWith('/v1/messages') && !urlPath.includes('/count_tokens')

    // ★ 白名单规则：
    // 1. POST /v1/messages（不含 count_tokens）→ 放行到上游
    // 2. 其余所有请求 → 本地处理，不穿透
    if (!isMessages) {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8')

        if (urlPath.includes('/count_tokens')) {
          const hash = bodyHash(body)
          const cached = CACHE.get(hash)
          const estimated = Math.max(1, Math.round(body.length / 2.5))
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
        path: urlPath,
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
