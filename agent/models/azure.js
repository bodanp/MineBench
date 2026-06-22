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

function createAzureModel({ endpoint, apiKey, deployment, apiVersion = '2024-10-21', useEntra = false } = {}) {
  if (!endpoint) throw new Error('createAzureModel: missing endpoint (AZURE_OPENAI_ENDPOINT).')
  if (!deployment) throw new Error('createAzureModel: missing deployment (AZURE_OPENAI_DEPLOYMENT).')

  let client
  if (useEntra) {
    const credential = new DefaultAzureCredential()
    const azureADTokenProvider = getBearerTokenProvider(credential, 'https://cognitiveservices.azure.com/.default')
    client = new AzureOpenAI({ endpoint, azureADTokenProvider, apiVersion, deployment })
  } else {
    if (!apiKey) throw new Error('createAzureModel: missing apiKey (AZURE_OPENAI_API_KEY) for key auth.')
    client = new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment })
  }

  return {
    name: deployment,
    async complete({ messages, tools }) {
      const res = await client.chat.completions.create({
        messages,
        tools,
        tool_choice: 'auto',
        model: deployment
      })
      return res.choices[0].message
    }
  }
}

module.exports = { createAzureModel }
