/**
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getPiModelOptions } from '@/blocks/utils'
import { resolvePiModelId } from '@/providers/pi-providers'
import { getProviderFromModel } from '@/providers/utils'
import { useProvidersStore } from '@/stores/providers/store'

const originalBaseModels = useProvidersStore.getState().providers.base.models
const originalOpenRouterModels = useProvidersStore.getState().providers.openrouter.models
const originalLiteLlmModels = useProvidersStore.getState().providers.litellm.models

/**
 * WizVille patch: every model picker is restricted to the LiteLLM gateway, and
 * Pi's pinned catalog cannot know what a self-hosted gateway advertises, so
 * LiteLLM is declared gateway-backed in `PI_PROVIDER_CONFIGS`. Keep these
 * assertions on every merge — they are the tripwire for both halves of the
 * patch: the gateway restriction in `buildModelOptions` and the gateway
 * short-circuit in `resolvePiModelId`. The upstream pinned-catalog coverage
 * they displace is skipped below.
 */
describe('Pi model options under the LiteLLM restriction', () => {
  beforeAll(() => {
    const store = useProvidersStore.getState()
    store.setProviderModels('base', ['claude-sonnet-4-6', 'gpt-5.4'])
    store.setProviderModels('openrouter', ['openrouter/openai/gpt-5'])
    store.setProviderModels('litellm', [
      'litellm/gpt-5.4-mini',
      'litellm/claude-sonnet-4-6',
      'litellm/some-self-hosted-model',
    ])
  })

  afterAll(() => {
    const store = useProvidersStore.getState()
    store.setProviderModels('base', originalBaseModels)
    store.setProviderModels('openrouter', originalOpenRouterModels)
    store.setProviderModels('litellm', originalLiteLlmModels)
  })

  it('offers the gateway catalog, including models absent from the pinned list', () => {
    const modelIds = getPiModelOptions().map(({ id }) => id)

    expect(modelIds).toContain('litellm/gpt-5.4-mini')
    expect(modelIds).toContain('litellm/claude-sonnet-4-6')
    expect(modelIds).toContain('litellm/some-self-hosted-model')
  })

  it('offers nothing outside the gateway', () => {
    const modelIds = getPiModelOptions().map(({ id }) => id)

    expect(modelIds.every((id) => id.startsWith('litellm/'))).toBe(true)
  })

  it('resolves gateway models to their provider-relative id', () => {
    expect(resolvePiModelId('litellm', 'litellm/gpt-5.4-mini')).toBe('gpt-5.4-mini')
  })

  it('rejects an unprefixed id for a gateway provider', () => {
    expect(resolvePiModelId('litellm', 'gpt-5.4-mini')).toBeUndefined()
    expect(resolvePiModelId('litellm', 'litellm/')).toBeUndefined()
  })
})

/**
 * Upstream's catalog-filtering coverage. It needs non-LiteLLM providers to reach
 * the model picker, which the LiteLLM-gateway restriction above removes. Re-enable
 * this block if this deployment ever stops routing every model through LiteLLM.
 */
describe.skip('Pi model options', () => {
  beforeAll(() => {
    const store = useProvidersStore.getState()
    store.setProviderModels('base', [
      'claude-sonnet-4-6',
      'claude-opus-4-1',
      'claude-sonnet-4-0',
      'gpt-5.4',
      'cerebras/zai-glm-4.7',
      'glm-5.1',
      'glm-4.5-air',
    ])
    store.setProviderModels('openrouter', [
      'openrouter/openai/gpt-5',
      'openrouter/openrouter/fusion',
    ])
  })

  afterAll(() => {
    const store = useProvidersStore.getState()
    store.setProviderModels('base', originalBaseModels)
    store.setProviderModels('openrouter', originalOpenRouterModels)
  })

  it("only exposes models present in Pi's pinned catalog", () => {
    const options = getPiModelOptions()

    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      const providerId = getProviderFromModel(option.id)
      expect(resolvePiModelId(providerId, option.id), option.id).toBeDefined()
    }
  })

  it('keeps current models and excludes retired catalog entries', () => {
    const modelIds = getPiModelOptions().map(({ id }) => id)

    expect(modelIds).toContain('claude-sonnet-4-6')
    expect(modelIds).not.toContain('claude-opus-4-1')
    expect(modelIds).not.toContain('claude-sonnet-4-0')
  })

  it('keeps persisted and selectable models available', () => {
    const modelIds = getPiModelOptions().map(({ id }) => id)

    expect(modelIds).toContain('cerebras/zai-glm-4.7')
    expect(modelIds).toContain('glm-5.1')
    expect(modelIds).toContain('glm-4.5-air')
  })

  it("does not apply OpenRouter capability filters beyond Pi's catalog", () => {
    const modelIds = getPiModelOptions().map(({ id }) => id)

    expect(modelIds).toContain('openrouter/openai/gpt-5')
    expect(modelIds).toContain('openrouter/openrouter/fusion')
  })
})
