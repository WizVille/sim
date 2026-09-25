/**
 * @vitest-environment node
 */
import { resetEnvMock, setEnv } from '@sim/testing'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PiSdk } from '@/executor/handlers/pi/core/pi-sdk'
import {
  createSealedPiResourceLoader,
  registerPiGatewayModel,
} from '@/executor/handlers/pi/core/pi-sdk'

describe('createSealedPiResourceLoader', () => {
  it('exposes no discovered prompt sources or repository resources', async () => {
    const extensionRuntime = { marker: 'runtime' }
    const sdk = {
      createExtensionRuntime: vi.fn(() => extensionRuntime),
    } as unknown as PiSdk

    const loader = createSealedPiResourceLoader(sdk, 'sealed system prompt')

    expect(loader.getExtensions()).toEqual({
      extensions: [],
      errors: [],
      runtime: extensionRuntime,
    })
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] })
    expect(loader.getSystemPrompt()).toBe('sealed system prompt')
    expect(loader.getAppendSystemPrompt()).toEqual([])
    await expect(loader.reload()).resolves.toBeUndefined()
  })
})

/**
 * WizVille patch: Pi runs gateway models that its pinned catalog has never
 * heard of. Keep this on every merge — without the registration `getModel`
 * returns undefined and every Pi run fails.
 */
describe('registerPiGatewayModel', () => {
  beforeAll(() => {
    setEnv({ LITELLM_BASE_URL: 'https://gateway.test/' })
  })

  afterAll(resetEnvMock)

  function createRuntime() {
    const registerProvider = vi.fn()
    return { registerProvider, modelRuntime: { registerProvider } as never }
  }

  it('declares the requested model against the gateway endpoint', () => {
    const { registerProvider, modelRuntime } = createRuntime()

    registerPiGatewayModel(modelRuntime, 'litellm', 'litellm', 'gpt-5.4')

    expect(registerProvider).toHaveBeenCalledWith('litellm', {
      name: 'litellm',
      baseUrl: 'https://gateway.test/v1',
      api: 'openai-completions',
      models: [
        expect.objectContaining({
          id: 'gpt-5.4',
          name: 'gpt-5.4',
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      ],
    })
  })

  it("reads limits from Sim's catalog, matching a dotted gateway ID", () => {
    const { registerProvider, modelRuntime } = createRuntime()

    registerPiGatewayModel(modelRuntime, 'litellm', 'litellm', 'claude-sonnet-4.6')

    const [model] = registerProvider.mock.calls[0][1].models
    expect(model.contextWindow).toBeGreaterThan(128_000)
    expect(model.reasoning).toBe(true)
  })

  it('falls back to conservative limits for a model the catalog does not know', () => {
    const { registerProvider, modelRuntime } = createRuntime()

    registerPiGatewayModel(modelRuntime, 'litellm', 'litellm', 'some-self-hosted-model')

    const [model] = registerProvider.mock.calls[0][1].models
    expect(model).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384, reasoning: false })
  })

  it('refuses to register when no gateway base URL is configured', () => {
    setEnv({ LITELLM_BASE_URL: '' })
    const { modelRuntime } = createRuntime()

    expect(() => registerPiGatewayModel(modelRuntime, 'litellm', 'litellm', 'gpt-5.4')).toThrow(
      /no base URL is configured/
    )

    setEnv({ LITELLM_BASE_URL: 'https://gateway.test/' })
  })
})
