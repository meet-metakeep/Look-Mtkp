import type { VercelRequest, VercelResponse } from '@vercel/node'

const JUPITER_ULTRA_BASE_URL = 'https://api.jup.ag/ultra/v1'

const getApiKey = () =>
  process.env.JUPITER_ULTRA_API_KEY ?? process.env.VITE_JUPITER_ULTRA_API_KEY

const forwardResponse = async (upstream: Response, res: VercelResponse) => {
  const body = await upstream.text()
  const contentType = upstream.headers.get('content-type') ?? 'application/json'
  res.status(upstream.status).setHeader('Content-Type', contentType).send(body || '{}')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).end()
  }

  const apiKey = getApiKey()
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: 'Jupiter Ultra API key missing. Set JUPITER_ULTRA_API_KEY in Vercel env.' })
  }

  const { inputMint, outputMint, amount, taker } = req.query
  const missing = ['inputMint', 'outputMint', 'amount', 'taker'].filter((key) => {
    const value = req.query[key]
    if (Array.isArray(value)) {
      return value.length === 0
    }
    return !value
  })

  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required parameter(s): ${missing.join(', ')}` })
  }

  try {
    const params = new URLSearchParams({
      inputMint: String(inputMint),
      outputMint: String(outputMint),
      amount: String(amount),
      taker: String(taker),
    })

    const target = `${JUPITER_ULTRA_BASE_URL}/order?${params.toString()}`
    const upstream = await fetch(target, {
      headers: {
        'x-api-key': apiKey,
      },
    })

    await forwardResponse(upstream, res)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Jupiter order request failed.'
    res.status(500).json({ error: message })
  }
}

