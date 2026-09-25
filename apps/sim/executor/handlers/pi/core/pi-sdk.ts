import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { ModelRuntime, ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { isRecordLike } from '@sim/utils/object'
import { env } from '@/lib/core/config/env'
import type { PiToolSpec } from '@/executor/handlers/pi/core/backend'
import { createScrubbedPiError, scrubPiSecrets } from '@/executor/handlers/pi/core/redaction'
import { getConversationModelLimits } from '@/providers/conversation-model'
import { getThinkingCapability, isKnownModelId } from '@/providers/models'
import type { PiSupportedProvider } from '@/providers/pi-provider-configs'

/** The Pi SDK module, loaded dynamically so it stays externalized from the bundle. */
export type PiSdk = typeof import('@earendil-works/pi-coding-agent')

let sdkPromise: Promise<PiSdk> | undefined

/** Loads the Pi SDK while preserving Next.js standalone dependency tracing. */
export function loadPiSdk(): Promise<PiSdk> {
  if (!sdkPromise) {
    sdkPromise = import('@earendil-works/pi-coding-agent').catch((error) => {
      sdkPromise = undefined
      throw error
    })
  }
  return sdkPromise
}

function isToolArguments(value: unknown): value is Record<string, unknown> {
  return isRecordLike(value)
}

/**
 * Converts a backend-neutral {@link PiToolSpec} into a Pi `ToolDefinition`, redacting transport
 * credentials from thrown and reported tool errors. Successful tool output is ordinary model
 * content and stays verbatim; Sim-secret projection is owned by the tool adapter's provenance.
 *
 * A spec's `isError` is rethrown rather than reported in the result: Pi derives a call's error state
 * solely from whether `execute` threw, so a resolved failure would reach the model as a successful
 * tool call whose text happens to describe a failure. Throwing also matches Pi's own `bash`, which
 * throws on a non-zero exit with the output appended, so the failure text survives either way.
 *
 * Shared by both host-side backends: Local Dev converts its SSH, Sim, and search tools here, and
 * Review Code converts its search tool here alongside the review tools it builds directly.
 */
export function toPiTool(sdk: PiSdk, spec: PiToolSpec, secrets: readonly string[]): ToolDefinition {
  return sdk.defineTool({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    // Pi only renders a guideline that survives onto the active ToolDefinition, so dropping this
    // would silently leave a tool's trusted guidance unreachable.
    ...(spec.promptGuidelines ? { promptGuidelines: spec.promptGuidelines } : {}),
    execute: async (_toolCallId, params) => {
      if (!isToolArguments(params)) throw new Error('Pi tool arguments must be an object')
      const result = await spec.execute(params).catch((error) => {
        throw createScrubbedPiError(error, secrets, 'Pi tool failed')
      })
      // Some providers reject an empty text block, and a spec is free to report a failure with none.
      if (result.isError) throw new Error(scrubPiSecrets(result.text, secrets) || 'Pi tool failed')
      return { content: [{ type: 'text', text: result.text }], details: {} }
    },
  })
}

/** Creates a host-only Pi model runtime without reading credentials or models from disk. */
export function createPiModelRuntime(sdk: PiSdk): Promise<ModelRuntime> {
  return sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
}

/**
 * Limits for a gateway model Sim's catalog does not know. Deliberately below
 * what a current model offers: Pi compacts the context and caps its output from
 * these numbers, so overstating them makes the gateway reject a request
 * mid-run, while understating them only costs some headroom.
 */
const GATEWAY_FALLBACK_CONTEXT_WINDOW = 128_000
const GATEWAY_FALLBACK_MAX_TOKENS = 16_384

/**
 * Declares a gateway-backed provider's selected model on the runtime.
 *
 * WizVille patch: this deployment routes every model through its own LiteLLM
 * gateway, whose catalog is unknowable to the Pi SDK's pinned list, so
 * `getModel` would resolve nothing. Registering the one model the run asked for
 * is enough — Pi only needs the definition it is about to stream against, and
 * the gateway rejects an id it does not serve. Keep this on every merge.
 *
 * Cost is zeroed because Sim prices the run itself from the Sim catalog ID; a
 * second price here would only be a number Pi displays.
 *
 * @throws when the deployment has not configured a base URL for the gateway.
 */
export function registerPiGatewayModel(
  modelRuntime: ModelRuntime,
  providerId: PiSupportedProvider,
  piProviderId: string,
  modelId: string
): void {
  const baseUrl = getPiGatewayBaseUrl(providerId)
  if (!baseUrl) {
    throw new Error(
      `Pi provider "${providerId}" is gateway-backed but no base URL is configured for it`
    )
  }

  const catalogId = resolveGatewayCatalogId(modelId)
  const limits = catalogId
    ? getConversationModelLimits(catalogId)
    : { contextWindow: GATEWAY_FALLBACK_CONTEXT_WINDOW, outputTokens: GATEWAY_FALLBACK_MAX_TOKENS }

  modelRuntime.registerProvider(piProviderId, {
    name: providerId,
    baseUrl,
    api: 'openai-completions',
    models: [
      {
        id: modelId,
        name: modelId,
        reasoning: catalogId !== undefined && getThinkingCapability(catalogId) !== null,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: limits.contextWindow,
        maxTokens: limits.outputTokens,
      },
    ],
  })
}

/**
 * Maps a gateway model ID onto Sim's catalog so its real limits and reasoning
 * support can be read. A LiteLLM deployment names its models after the upstream
 * vendor IDs, so most match directly; a version spelled with a dot
 * (`claude-sonnet-4.6`) matches Sim's dashed ID instead.
 */
function resolveGatewayCatalogId(modelId: string): string | undefined {
  return [modelId, modelId.replace(/\./g, '-')].find(isKnownModelId)
}

/**
 * OpenAI-compatible endpoint backing a gateway provider. `/v1` matches the path
 * Sim's own LiteLLM provider posts to, so both callers reach the same gateway.
 */
function getPiGatewayBaseUrl(providerId: PiSupportedProvider): string | undefined {
  if (providerId !== 'litellm') return undefined
  const configured = env.LITELLM_BASE_URL?.replace(/\/$/, '')
  return configured ? `${configured}/v1` : undefined
}

/** Resolves only model definitions that the installed Pi SDK declares exactly. */
export function resolvePiSdkModel(modelRuntime: ModelRuntime, provider: string, modelId: string) {
  return modelRuntime.getModel(provider, modelId)
}

/**
 * Creates an isolated resource-discovery boundary for untrusted repositories. No project
 * files, extensions, skills, prompt templates, themes, or settings are loaded.
 */
export function createSealedPiResourceLoader(sdk: PiSdk, systemPrompt: string): ResourceLoader {
  const extensions = {
    extensions: [],
    errors: [],
    runtime: sdk.createExtensionRuntime(),
  }

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}
