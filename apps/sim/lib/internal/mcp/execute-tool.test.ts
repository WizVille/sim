/**
 * @vitest-environment node
 */
import type { WorkflowExecutionDelegatedPrincipal } from '@sim/auth/principal'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BillingAttributionSnapshot } from '@/lib/billing/core/billing-attribution'
import type { InternalToolOperationContext } from '@/lib/internal/tool-operations/types'

const mocks = vi.hoisted(() => ({
  createPrincipal: vi.fn(),
  executeUseCase: vi.fn(),
}))

vi.mock('@/lib/internal/principals/executor', () => ({
  createExecutorPrincipalFromExecutionContext: mocks.createPrincipal,
}))
vi.mock('@/lib/mcp/application/execute-tool', () => ({
  executeMcpToolUseCase: { execute: mocks.executeUseCase },
  McpToolsNotAllowedError: class McpToolsNotAllowedError extends Error {},
}))

import { executeMcpTool } from '@/lib/internal/mcp/execute-tool'

const PRINCIPAL: WorkflowExecutionDelegatedPrincipal = {
  kind: 'delegated',
  serviceId: 'executor',
  subjectUserId: 'user-1',
  workspaceId: 'workspace-1',
  delegationId: 'delegation-1',
  audience: 'sim:mcp-servers',
  issuedAt: new Date('2026-08-27T00:00:00.000Z'),
  expiresAt: new Date('2099-08-27T00:05:00.000Z'),
  delegationContext: { kind: 'workflow_execution', workflowId: 'workflow-1' },
}
const NESTED_HUMAN_PRINCIPAL: WorkflowExecutionDelegatedPrincipal = {
  kind: 'delegated',
  serviceId: 'executor',
  workspaceId: 'workspace-1',
  delegationId: 'delegation-nested-human',
  audience: 'sim:mcp-servers',
  issuedAt: new Date('2026-08-27T00:00:00.000Z'),
  expiresAt: new Date('2099-08-27T00:05:00.000Z'),
  delegationContext: {
    kind: 'workflow_execution',
    workflowId: 'workflow-1',
    principal: { kind: 'session', userId: 'user-origin', sessionId: 'session-origin' },
  },
}
const BILLING = {
  actorUserId: 'user-1',
  workspaceId: 'workspace-1',
  organizationId: null,
  billedAccountUserId: 'user-1',
  billingEntity: { type: 'user', id: 'user-1' },
  billingPeriod: { start: '2026-08-01', end: '2026-09-01' },
  payerSubscription: null,
} as unknown as BillingAttributionSnapshot
const CONTEXT: InternalToolOperationContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-1',
  billingAttribution: BILLING,
  callChain: ['workflow-parent'],
}

describe('executeMcpTool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createPrincipal.mockResolvedValue(PRINCIPAL)
    mocks.executeUseCase.mockResolvedValue({
      success: true,
      output: { content: [{ type: 'text', text: 'done' }] },
    })
  })

  it('parses direct block arguments and invokes the authorized use case', async () => {
    const response = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: { arguments: '{"query":"sim"}', _context: { ignored: true } },
      headers: new Headers(),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      data: {
        success: true,
        output: { content: [{ type: 'text', text: 'done' }] },
      },
    })
    expect(mocks.createPrincipal).toHaveBeenCalledWith({
      context: CONTEXT,
      audience: 'sim:mcp-servers',
    })
    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({
        workspaceId: 'workspace-1',
        serverId: 'mcp-server',
        toolName: 'lookup',
        arguments: { query: 'sim' },
        callChain: ['workflow-parent'],
      }),
    })
  })

  it('filters framework parameters for Agent-originated arguments', async () => {
    await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: { query: 'sim', serverId: 'untrusted', _context: { workspaceId: 'foreign' } },
      headers: new Headers(),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({ arguments: { query: 'sim' } }),
    })
  })

  it('re-reads the execution identity headers for the use case', async () => {
    await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: { arguments: '{"query":"sim"}' },
      headers: new Headers({
        'X-Sim-Workflow-Id': 'workflow-1',
        'X-Sim-Block-Id': 'block-1',
        'X-Sim-Execution-Id': 'execution-1',
        'X-Sim-Unrelated': 'ignored',
      }),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({
        passthroughHeaders: {
          'X-Sim-Workflow-Id': 'workflow-1',
          'X-Sim-Block-Id': 'block-1',
          'X-Sim-Execution-Id': 'execution-1',
        },
      }),
    })
  })

  it("turns the run's HTTP_ workflow variables into passthrough headers", async () => {
    await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: { arguments: '{"query":"sim"}' },
      headers: new Headers({ 'X-Sim-Block-Id': 'block-1' }),
      context: {
        ...CONTEXT,
        workflowVariables: {
          'var-1': { id: 'var-1', name: 'HTTP_CONTEXT_UUID', type: 'plain', value: 'ctx-123' },
          'var-2': { id: 'var-2', name: 'apiToken', type: 'plain', value: 'secret-value' },
        },
      },
      requestId: 'request-1',
    })

    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({
        passthroughHeaders: { 'Context-Uuid': 'ctx-123', 'X-Sim-Block-Id': 'block-1' },
      }),
    })
  })

  it('falls back to the variables carried on an Agent-originated input', async () => {
    await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {
        arguments: '{"query":"sim"}',
        workflowVariables: { HTTP_CONTEXT_UUID: 'ctx-123' },
      },
      headers: new Headers(),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({
        passthroughHeaders: { 'Context-Uuid': 'ctx-123' },
      }),
    })
  })

  it('forwards the caller credential and keeps it out of the tool arguments', async () => {
    await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: { query: 'sim', _mcpAuthorization: 'sk-caller-key' },
      headers: new Headers(),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(mocks.executeUseCase).toHaveBeenCalledWith({
      principal: PRINCIPAL,
      input: expect.objectContaining({
        arguments: { query: 'sim' },
        forwardedAuthorization: 'Bearer sk-caller-key',
      }),
    })
  })

  it('preserves an explicit credential scheme and ignores an empty one', async () => {
    const cases = [
      { credential: 'Bearer already-prefixed', expected: 'Bearer already-prefixed' },
      { credential: 'basic dXNlcjpwYXNz', expected: 'basic dXNlcjpwYXNz' },
      { credential: '  sk-padded  ', expected: 'Bearer sk-padded' },
      { credential: '   ', expected: undefined },
      { credential: '', expected: undefined },
    ]

    for (const { credential, expected } of cases) {
      mocks.executeUseCase.mockClear()

      await executeMcpTool({
        toolId: 'mcp-server-lookup',
        input: { arguments: '{"query":"sim"}', _mcpAuthorization: credential },
        headers: new Headers(),
        context: CONTEXT,
        requestId: 'request-1',
      })

      expect(mocks.executeUseCase).toHaveBeenCalledWith({
        principal: PRINCIPAL,
        input: expect.objectContaining({ forwardedAuthorization: expected }),
      })
    }
  })

  it('treats an untouched block arguments field as no arguments', async () => {
    for (const emptyArguments of [null, undefined, '', '   ']) {
      mocks.executeUseCase.mockClear()

      const response = await executeMcpTool({
        toolId: 'mcp-server-get_user_context',
        input: { server: 'mcp-server', tool: 'get_user_context', arguments: emptyArguments },
        headers: new Headers(),
        context: CONTEXT,
        requestId: 'request-1',
      })

      expect(response.status).toBe(200)
      expect(mocks.executeUseCase).toHaveBeenCalledWith({
        principal: PRINCIPAL,
        input: expect.objectContaining({ toolName: 'get_user_context', arguments: {} }),
      })
    }
  })

  it('rejects block arguments that cannot represent an argument record', async () => {
    for (const badArguments of [42, ['sim'], '[1,2]', '"sim"']) {
      mocks.executeUseCase.mockClear()

      const response = await executeMcpTool({
        toolId: 'mcp-server-lookup',
        input: { arguments: badArguments },
        headers: new Headers(),
        context: CONTEXT,
        requestId: 'request-1',
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        success: false,
        error: 'Invalid request format',
      })
      expect(mocks.executeUseCase).not.toHaveBeenCalled()
    }
  })

  it('fails closed without trusted workspace or billing context', async () => {
    const missingWorkspace = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {},
      headers: new Headers(),
      context: { ...CONTEXT, workspaceId: undefined },
      requestId: 'request-1',
    })
    expect(missingWorkspace.status).toBe(400)
    expect(await missingWorkspace.json()).toMatchObject({
      error: 'Missing workspaceId in execution context for MCP tool lookup',
    })

    const missingBilling = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {},
      headers: new Headers(),
      context: { ...CONTEXT, billingAttribution: undefined },
      requestId: 'request-1',
    })
    expect(missingBilling.status).toBe(400)
    expect(await missingBilling.json()).toMatchObject({
      error: 'Missing billing attribution in execution context for MCP tool lookup',
    })
    expect(mocks.createPrincipal).not.toHaveBeenCalled()
  })

  it('preserves provider tool errors without retrying the operation', async () => {
    mocks.executeUseCase.mockResolvedValueOnce({ success: false, error: 'Provider rejected input' })

    const response = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {},
      headers: new Headers(),
      context: CONTEXT,
      requestId: 'request-1',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, error: 'Provider rejected input' })
    expect(mocks.executeUseCase).toHaveBeenCalledOnce()
  })

  it('throws cancellation before and after submitted work', async () => {
    const before = new AbortController()
    before.abort(new DOMException('cancelled', 'AbortError'))
    await expect(
      executeMcpTool({
        toolId: 'mcp-server-lookup',
        input: {},
        headers: new Headers(),
        context: CONTEXT,
        requestId: 'request-1',
        signal: before.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.executeUseCase).not.toHaveBeenCalled()

    const after = new AbortController()
    mocks.executeUseCase.mockImplementationOnce(async () => {
      after.abort(new DOMException('cancelled', 'AbortError'))
      return { success: true, output: {} }
    })
    await expect(
      executeMcpTool({
        toolId: 'mcp-server-lookup',
        input: {},
        headers: new Headers(),
        context: CONTEXT,
        requestId: 'request-1',
        signal: after.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.executeUseCase).toHaveBeenCalledOnce()
  })

  it('imports resolved-secret provenance into the isolated tool registry', async () => {
    const importCrossingProvenance = vi.fn().mockResolvedValue(true)
    const mergeToolCallRegistry = vi.fn()
    const fork = { importCrossingProvenance }
    const registry = {
      forkForToolCall: vi.fn(() => fork),
      mergeToolCallRegistry,
    }

    const response = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {},
      headers: new Headers(),
      context: {
        ...CONTEXT,
        resolvedSecretTraceRegistry: registry as never,
      },
      requestId: 'request-1',
    })

    expect(response.status).toBe(200)
    expect(importCrossingProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1, complete: true }),
      expect.objectContaining({ success: true }),
      { trusted: true, origin: 'tool.mcp-server-lookup' }
    )
    expect(mergeToolCallRegistry).toHaveBeenCalledWith(fork)
  })

  it('scopes provenance to the trusted nested human without inventing an actor', async () => {
    mocks.createPrincipal.mockResolvedValueOnce(NESTED_HUMAN_PRINCIPAL)
    mocks.executeUseCase.mockImplementationOnce(async ({ input }) => {
      input.onResolvedSecretTraceProvenance?.({
        version: 1,
        complete: true,
        entries: [],
        scope: { userId: 'user-origin', workspaceId: 'workspace-1' },
      })
      return { success: true, output: {} }
    })
    const importCrossingProvenance = vi.fn().mockResolvedValue(true)
    const fork = { importCrossingProvenance }
    const registry = {
      forkForToolCall: vi.fn(() => fork),
      mergeToolCallRegistry: vi.fn(),
    }

    const response = await executeMcpTool({
      toolId: 'mcp-server-lookup',
      input: {},
      headers: new Headers(),
      context: {
        ...CONTEXT,
        userId: undefined,
        resolvedSecretTraceRegistry: registry as never,
      },
      requestId: 'request-1',
    })

    expect(response.status).toBe(200)
    expect(mocks.executeUseCase).toHaveBeenCalledWith(
      expect.objectContaining({ principal: NESTED_HUMAN_PRINCIPAL })
    )
    expect(importCrossingProvenance).toHaveBeenCalledWith(
      expect.objectContaining({
        complete: true,
        scope: { userId: 'user-origin', workspaceId: 'workspace-1' },
      }),
      expect.objectContaining({ success: true }),
      { trusted: true, origin: 'tool.mcp-server-lookup' }
    )
  })
})
