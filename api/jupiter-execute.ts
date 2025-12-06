import type { VercelRequest, VercelResponse } from '@vercel/node'

const JUPITER_ULTRA_BASE_URL = 'https://api.jup.ag/ultra/v1'

const getApiKey = () =>
  process.env.JUPITER_ULTRA_API_KEY ?? process.env.VITE_JUPITER_ULTRA_API_KEY

const forwardResponse = async (upstream: Response, res: VercelResponse) => {
  const body = await upstream.text()
  const contentType = upstream.headers.get('content-type') ?? 'application/json'
  res.status(upstream.status).setHeader('Content-Type', contentType).send(body || '{}')
}

const parseBody = (req: VercelRequest) => {
  if (req.body && typeof req.body === 'object') {
    return req.body
  }

  if (typeof req.body === 'string') {
    return JSON.parse(req.body)
  }

  return {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).end()
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Jupiter Ultra API key missing. Set JUPITER_ULTRA_API_KEY in Vercel env.' })
  }

  try {
    const body = parseBody(req)
    const signedTransaction =
      typeof body.signedTransaction === 'string' ? body.signedTransaction : undefined
    const requestId = typeof body.requestId === 'string' ? body.requestId : undefined

    if (!signedTransaction || !requestId) {
      return res
        .status(400)
        .json({ error: 'signedTransaction and requestId are required in the execute payload.' })
    }

    const upstream = await fetch(`${JUPITER_ULTRA_BASE_URL}/execute`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ signedTransaction, requestId }),
    })

    await forwardResponse(upstream, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jupiter execute request failed.'
    res.status(500).json({ error: message })
  }
}


