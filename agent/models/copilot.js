// ─────────────────────────────────────────────
// MODEL ADAPTER: GitHub Copilot
//
// OWNER: Agent: Brain & Models (Role 4)
//
// Same contract as azure.js — complete({ messages, tools }) -> assistantMessage —
// so it drops straight into the agent loop. The only differences are the base URL,
// the integration-id header, and using the model name as-is (no Azure deployment).
// ─────────────────────────────────────────────
const OpenAI = require('openai')
const { callWithRetry } = require('./azure')

const COPILOT_BASE_URL = 'https://api.githubcopilot.com'
const DEFAULT_INTEGRATION_ID = 'copilot-developer-cli'

function getCopilotToken() {
  const token = process.env.COPILOT_TOKEN
  if (!token) throw new Error('Set COPILOT_TOKEN')
  return token
}

function createCopilotModel({ model, token, integrationId = DEFAULT_INTEGRATION_ID } = {}) {
  if (!model) throw new Error('createCopilotModel: missing model name.')

  const client = new OpenAI({
    baseURL: COPILOT_BASE_URL,
    apiKey: token || getCopilotToken(),
    defaultHeaders: {
      'Copilot-Integration-Id': integrationId,
      'Editor-Version': 'CopilotCLI/1.0'
    },
    maxRetries: 0
  })

  return {
    name: model,
    async complete({ messages, tools }) {
      const params = { messages, model }
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

module.exports = { createCopilotModel, getCopilotToken }
