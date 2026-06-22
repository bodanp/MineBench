// ─────────────────────────────────────────────
// MODEL ADAPTER: Azure OpenAI
//
// OWNER: Agent: Brain & Models (Role 4)
//
// A "model" is anything exposing:  complete({ messages, tools }) -> assistantMessage
// Keeping this behind one interface is what lets us swap mini / 4.1 / 4o and MEASURE
// the difference — the core "is it the model or the tools?" question.
// ─────────────────────────────────────────────
const { AzureOpenAI } = require('openai')
const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// Retry transient API failures (429 rate limits, 5xx, dropped connections) with exponential
// backoff + jitter so one hiccup doesn't kill a whole benchmark run. Honors Retry-After.
async function callWithRetry(fn, { retries = 6, baseMs = 1000, maxMs = 60000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const status = e?.status ?? e?.response?.status
      const code = e?.code ?? e?.cause?.code
      const transient = status === 429 || status === 408 || (status >= 500 && status < 600) ||
        /Connection|Timeout/i.test(e?.name || '') ||
        ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN'].includes(code)
      if (!transient || attempt >= retries) throw e

      const headers = e?.headers || e?.response?.headers || {}
      const hget = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k])
      const afterMs = Number(hget('retry-after-ms'))
      const afterS = Number(hget('retry-after'))
      const wait = afterMs > 0 ? afterMs
        : afterS > 0 ? afterS * 1000
        : Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random())
      console.warn(`Azure API ${status || code || 'error'} — retrying in ${(wait / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`)
      await sleep(wait)
    }
  }
}

function createAzureModel({ endpoint, apiKey, deployment, apiVersion = '2024-10-21', useEntra = false } = {}) {
  if (!endpoint) throw new Error('createAzureModel: missing endpoint (AZURE_OPENAI_ENDPOINT).')
  if (!deployment) throw new Error('createAzureModel: missing deployment (AZURE_OPENAI_DEPLOYMENT).')

  let client
  if (useEntra) {
    const credential = new DefaultAzureCredential()
    const azureADTokenProvider = getBearerTokenProvider(credential, 'https://cognitiveservices.azure.com/.default')
    client = new AzureOpenAI({ endpoint, azureADTokenProvider, apiVersion, deployment, maxRetries: 0 })
  } else {
    if (!apiKey) throw new Error('createAzureModel: missing apiKey (AZURE_OPENAI_API_KEY) for key auth.')
    client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment, maxRetries: 0 })
  }

  return {
    name: deployment,
    async complete({ messages, tools }) {
      const params = { messages, model: deployment }
      if (tools && tools.length) {
        params.tools = tools
        params.tool_choice = 'auto'
        params.parallel_tool_calls = false   // one action per step — matches the agent loop
      }
      const res = await callWithRetry(() => client.chat.completions.create(params))
      return res.choices[0].message
    }
  }
}

module.exports = { createAzureModel, callWithRetry }
