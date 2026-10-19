import type { Config } from '../config.ts'
import { type Endpoint, type LlmInput, type LlmResult, llm } from './llm.ts'

export * from './llm.ts'
export type { UsageMeta } from './usage.ts'

export function endpointFromConfig(config: Config): Endpoint {
  return {
    name: 'llm',
    baseUrl: config.llmBaseUrl.toString(),
    apiKey: config.llmApiKey,
    model: config.llmModel,
    capability: config.llmCapability,
  }
}

// The one llm() for the app, bound to the configured endpoint.
export function llmFromConfig(config: Config) {
  const endpoint = endpointFromConfig(config)
  return <T = unknown>(input: Omit<LlmInput, 'endpoint'>): Promise<LlmResult<T>> =>
    llm<T>({ ...input, endpoint })
}
