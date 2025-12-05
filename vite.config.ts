import { defineConfig, loadEnv } from 'vite'
import type { Connect } from 'vite'
import { createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'

const JUPITER_ULTRA_BASE_URL = 'https://api.jup.ag/ultra/v1'

/// @notice Reads the POST body from a Connect middleware request.
const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> =>
  await new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data.toString()) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })

/// @notice Registers the MoonPay signature endpoint for dev/preview servers.
const registerMoonPaySignatureEndpoint = (middlewares: Connect.Server, secret?: string) => {
  middlewares.use('/api/sign-moonpay', async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }

    if (!secret) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'MoonPay secret key is not configured on the server.' }))
      return
    }

    try {
      const body = await readBody(req)
      const url = typeof body.url === 'string' ? body.url : undefined

      if (!url) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Missing url in MoonPay signature payload.' }))
        return
      }

      const queryString = new URL(url).search
      const signature = createHmac('sha256', secret).update(queryString).digest('base64')

      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ signature }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MoonPay signature generation failed.'
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: message }))
    }
  })
}

/// @notice Writes a JSON response with the provided status code.
const sendJson = (res: ServerResponse, status: number, payload: Record<string, unknown>) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

/// @notice Pipes the upstream Jupiter response back to the client.
const forwardJupiterResponse = async (
  upstream: Awaited<ReturnType<typeof fetch>>,
  res: ServerResponse,
) => {
  const body = await upstream.text()
  const contentType = upstream.headers.get('content-type') ?? 'application/json'
  res.statusCode = upstream.status
  res.setHeader('Content-Type', contentType)
  res.end(body || '{}')
}

/// @notice Registers the Jupiter Ultra proxy endpoints for order/execute.
const registerJupiterUltraEndpoints = (middlewares: Connect.Server, apiKey?: string) => {
  const ensureApiKey = (res: ServerResponse): string | undefined => {
    if (!apiKey) {
      sendJson(res, 500, {
        error: 'Jupiter Ultra API key is not configured on the server. Set JUPITER_ULTRA_API_KEY in your env.',
      })
      return undefined
    }
    return apiKey
  }

  middlewares.use('/api/jupiter/order', async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.setHeader('Allow', 'GET')
      res.end()
      return
    }

    const key = ensureApiKey(res)
    if (!key) return

    try {
      const url = new URL(req.url ?? '', 'http://localhost')
      const requiredParams = ['inputMint', 'outputMint', 'amount', 'taker'] as const
      for (const param of requiredParams) {
        if (!url.searchParams.get(param)) {
          sendJson(res, 400, { error: `Missing required parameter: ${param}` })
          return
        }
      }

      const target = `${JUPITER_ULTRA_BASE_URL}/order${url.search}`
      const upstream = await fetch(target, {
        method: 'GET',
        headers: { 'x-api-key': key },
      })
      await forwardJupiterResponse(upstream, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Jupiter order request failed.'
      sendJson(res, 500, { error: message })
    }
  })

  middlewares.use('/api/jupiter/execute', async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end()
      return
    }

    const key = ensureApiKey(res)
    if (!key) return

    try {
      const body = await readBody(req)
      const signedTransaction = typeof body.signedTransaction === 'string' ? body.signedTransaction : undefined
      const requestId = typeof body.requestId === 'string' ? body.requestId : undefined

      if (!signedTransaction || !requestId) {
        sendJson(res, 400, {
          error: 'signedTransaction and requestId are required in the Jupiter execute payload.',
        })
        return
      }

      const upstream = await fetch(`${JUPITER_ULTRA_BASE_URL}/execute`, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ signedTransaction, requestId }),
      })
      await forwardJupiterResponse(upstream, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Jupiter execute request failed.'
      sendJson(res, 500, { error: message })
    }
  })
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const moonPaySecret = env.MOONPAY_SECRET_KEY ?? env.VITE_MOONPAY_SECRET_KEY
  const jupiterApiKey = env.JUPITER_ULTRA_API_KEY ?? env.VITE_JUPITER_ULTRA_API_KEY

  return {
    plugins: [
      react(),
      {
        name: 'moonpay-signature-endpoint',
        configureServer(server) {
          registerMoonPaySignatureEndpoint(server.middlewares, moonPaySecret)
        },
        configurePreviewServer(server) {
          registerMoonPaySignatureEndpoint(server.middlewares, moonPaySecret)
        },
      },
      {
        name: 'jupiter-ultra-server-endpoints',
        configureServer(server) {
          registerJupiterUltraEndpoints(server.middlewares, jupiterApiKey)
        },
        configurePreviewServer(server) {
          registerJupiterUltraEndpoints(server.middlewares, jupiterApiKey)
        },
      },
    ],
  }
})
