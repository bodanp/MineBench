// ─────────────────────────────────────────────
// MODEL REGISTRY — resolve a model name to a ready-to-use model object.
//
// OWNER: Agent: Brain & Models (Role 4)
//
// Routing:
//   - `copilot/<model>`            -> Copilot proxy, explicit (always wins).
//   - claude* / gemini* / grok* /
//     o1* / o3* / o4*              -> Copilot proxy, AUTO (these are not Azure deployments,
//                                     so `--model claude-opus-4.8` works without the prefix).
//   - everything else (gpt-*, …)   -> Azure deployment via AZURE_OPENAI_*.
//
// Why the auto-route exists: this Azure resource only hosts GPT deployments. Sending a
// Claude/Gemini name to Azure 404s ("deployment does not exist"), which surfaces as an
// llm_error on the first step — the bot connects, applies setup, then immediately leaves.
// ─────────────────────────────────────────────
const { createAzureModel } = require('./azure')
const { createCopilotModel } = require('./copilot')

// Model families served ONLY by the Copilot proxy here (never Azure deployments).
const COPILOT_MODEL_PREFIXES = ['claude', 'gemini', 'grok', 'o1', 'o3', 'o4']

function isCopilotFamily(name) {
  const n = name.toLowerCase()
  return COPILOT_MODEL_PREFIXES.some(p => n.startsWith(p))
}

function resolveModel(modelName) {
  // Normalize: trim whitespace and strip stray leading dashes (e.g. a mis-pasted "-claude-…").
  if (typeof modelName === 'string') modelName = modelName.trim().replace(/^-+/, '')

  // Explicit override always wins.
  if (modelName && modelName.startsWith('copilot/')) {
    return createCopilotModel({ model: modelName.slice('copilot/'.length) })
  }

  // Auto-route Copilot-only model families so the prefix is optional.
  if (modelName && isCopilotFamily(modelName)) {
    return createCopilotModel({ model: modelName })
  }

  // Default: treat the name as an Azure deployment.
  const deployment = modelName || process.env.AZURE_OPENAI_DEPLOYMENT
  return createAzureModel({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    useEntra: process.env.USE_ENTRA === 'true'
  })
}

module.exports = { resolveModel, createAzureModel, createCopilotModel, isCopilotFamily }
