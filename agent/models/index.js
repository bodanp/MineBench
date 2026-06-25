// ─────────────────────────────────────────────
// MODEL REGISTRY — resolve a model name to a ready-to-use model object.
//
// OWNER: Agent: Brain & Models (Role 4)
//
// v1: every model name is an Azure deployment using the single AZURE_OPENAI_* config.
//     `--model gpt-4.1` just swaps the deployment name.
// TODO (Role 4): map specific model names to their own endpoint/key (the .env already
//     has GPT41_MINI_* / NANO_* blocks) so different deployments/resources can be compared.
// ─────────────────────────────────────────────
const { createAzureModel } = require('./azure')
const { createCopilotModel } = require('./copilot')

function resolveModel(modelName) {
  if (modelName && modelName.startsWith('copilot/')) {
    return createCopilotModel({ model: modelName.slice('copilot/'.length) })
  }

  const deployment = modelName || process.env.AZURE_OPENAI_DEPLOYMENT
  return createAzureModel({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    useEntra: process.env.USE_ENTRA === 'true'
  })
}

module.exports = { resolveModel, createAzureModel, createCopilotModel }
