import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { resolvePrincipalSubject } from '@sim/auth/principal'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { isPlainRecord } from '@sim/utils/object'
import {
  capExecutionTimeoutMs,
  getAsyncExecutionTimeoutForBillingAttribution,
  getRemainingExecutionMs,
} from '@/lib/core/execution-limits'
import { asOrchestrationError, statusForOrchestrationError } from '@/lib/core/orchestration/types'
import { extractExecutionIdentityHeaders } from '@/lib/execution/execution-identity'
import { buildWorkflowVariableHeaders } from '@/lib/execution/workflow-variable-headers'
import { createExecutorPrincipalFromExecutionContext } from '@/lib/internal/principals/executor'
import {
  classifyInternalToolIdentityFault,
  internalToolIdentityFaultMessage,
  internalToolIdentityFaultStatus,
} from '@/lib/internal/tool-operations/identity-faults'
import type { InternalToolOperationHandler } from '@/lib/internal/tool-operations/types'
import { MCP_SERVER_DELEGATION_AUDIENCE } from '@/lib/mcp/application/authorization'
import { executeMcpToolUseCase, McpToolsNotAllowedError } from '@/lib/mcp/application/execute-tool'
import { McpOauthRedirectRequired } from '@/lib/mcp/oauth'
import { McpOauthAuthorizationRequiredError } from '@/lib/mcp/types'
import { categorizeError, parseMcpToolId } from '@/lib/mcp/utils'
import {
  ResolvedSecretTraceProvenanceAccumulator,
  type ResolvedSecretTraceRegistry,
} from '@/executor/utils/resolved-secret-trace-registry'

const logger = createLogger('McpInternalOperation')

/** The Agent block's own credential, carried alongside the tool parameters. */
const MCP_AUTHORIZATION_PARAMETER = '_mcpAuthorization'

const MCP_SYSTEM_PARAMETERS = new Set([
  'serverId',
  'serverUrl',
  'toolName',
  'serverName',
  '_context',
  'envVars',
  'workflowVariables',
  'blockData',
  'blockNameMapping',
  '_toolSchema',
  MCP_AUTHORIZATION_PARAMETER,
])

/**
 * The credential the caller forwards to servers that opt in with the
 * `X-Sim-Forward: authorization` marker. A bare key is promoted to a `Bearer` credential;
 * an explicit `Bearer`/`Basic` scheme is preserved as typed.
 */
function parseForwardedAuthorization(input: unknown): string | undefined {
  if (!isPlainRecord(input)) return undefined
  const value = input[MCP_AUTHORIZATION_PARAMETER]
  if (typeof value !== 'string') return undefined

  const credential = value.trim()
  if (!credential) return undefined
  return /^(bearer|basic)\s/i.test(credential) ? credential : `Bearer ${credential}`
}

function parseArguments(input: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(input)) return null
  if (!Object.hasOwn(input, 'arguments')) {
    return Object.fromEntries(
      Object.entries(input).filter(([name]) => !MCP_SYSTEM_PARAMETERS.has(name))
    )
  }

  const value = input.arguments
  /**
   * The MCP block always serializes its `arguments` field once a tool is selected, and a
   * field the user never edited holds `null` — which is every tool that declares no
   * parameters. An explicitly empty value means "no arguments", not a malformed request.
   * It must not fall through to the branch above either: that one forwards the block's own
   * routing fields (`server`, `tool`) as tool arguments.
   */
  if (value == null) return {}
  if (typeof value !== 'string') return isPlainRecord(value) ? value : null
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return isPlainRecord(parsed) ? parsed : null
  } catch (error) {
    logger.warn('Failed to parse MCP arguments JSON', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      argumentsLength: value.length,
    })
    return {}
  }
}

async function createResponse(
  body: Record<string, unknown>,
  status: number,
  provenance: ResolvedSecretTraceProvenanceAccumulator | undefined,
  registry: ResolvedSecretTraceRegistry | undefined,
  toolId: string
): Promise<Response> {
  if (!provenance || !registry) return Response.json(body, { status })
  const targetRegistry = registry.forkForToolCall()
  const imported = await targetRegistry.importCrossingProvenance(
    provenance.exportProvenance(),
    body,
    { trusted: true, origin: `tool.${toolId}` }
  )
  if (!imported) {
    return Response.json(
      { success: false, error: 'Internal tool response metadata could not be verified' },
      { status: 502, statusText: 'Bad Gateway' }
    )
  }
  registry.mergeToolCallRegistry(targetRegistry)
  return Response.json(body, { status })
}

export const executeMcpTool: InternalToolOperationHandler = async (request) => {
  request.signal?.throwIfAborted()
  let serverId: string
  let toolName: string
  try {
    ;({ serverId, toolName } = parseMcpToolId(request.toolId))
  } catch (error) {
    return Response.json(
      { success: false, error: getErrorMessage(error, 'Invalid MCP tool ID') },
      { status: 400 }
    )
  }

  if (!request.context.workspaceId) {
    return Response.json(
      {
        success: false,
        error: `Missing workspaceId in execution context for MCP tool ${toolName}`,
      },
      { status: 400 }
    )
  }
  if (!request.context.billingAttribution) {
    return Response.json(
      {
        success: false,
        error: `Missing billing attribution in execution context for MCP tool ${toolName}`,
      },
      { status: 400 }
    )
  }
  const args = parseArguments(request.input)
  if (!args)
    return Response.json({ success: false, error: 'Invalid request format' }, { status: 400 })

  let provenance: ResolvedSecretTraceProvenanceAccumulator | undefined
  try {
    const principal = await createExecutorPrincipalFromExecutionContext({
      context: request.context,
      audience: MCP_SERVER_DELEGATION_AUDIENCE,
    })
    request.signal?.throwIfAborted()
    const subject = resolvePrincipalSubject(principal)
    provenance =
      request.context.resolvedSecretTraceRegistry && subject?.kind === 'sim_user'
        ? new ResolvedSecretTraceProvenanceAccumulator({
            userId: subject.userId,
            workspaceId: request.context.workspaceId,
          })
        : undefined
    const policyTimeoutMs = getAsyncExecutionTimeoutForBillingAttribution(
      request.context.billingAttribution
    )
    const timeoutMs = capExecutionTimeoutMs(
      policyTimeoutMs,
      getRemainingExecutionMs(request.signal)
    )
    const result = await executeMcpToolUseCase.execute({
      principal,
      input: {
        workspaceId: request.context.workspaceId,
        serverId,
        toolName,
        arguments: args,
        forwardedAuthorization: parseForwardedAuthorization(request.input),
        passthroughHeaders: {
          ...buildWorkflowVariableHeaders(
            request.context.workflowVariables ??
              (isPlainRecord(request.input)
                ? (request.input.workflowVariables as Record<string, unknown> | undefined)
                : undefined)
          ),
          ...extractExecutionIdentityHeaders(request.headers),
        },
        callChain: request.context.callChain,
        timeoutMs,
        signal: request.signal,
        onResolvedSecretTraceProvenance: provenance
          ? (value) => provenance?.record(value)
          : undefined,
      },
    })
    request.signal?.throwIfAborted()
    const body = result.success
      ? { success: true, data: { success: true, output: result.output } }
      : { success: false, error: result.error }
    return createResponse(
      body,
      result.success ? 200 : 400,
      provenance,
      request.context.resolvedSecretTraceRegistry,
      request.toolId
    )
  } catch (error) {
    request.signal?.throwIfAborted()
    const identityFault = classifyInternalToolIdentityFault(error)
    if (identityFault) {
      return Response.json(
        { success: false, error: internalToolIdentityFaultMessage(identityFault) },
        { status: internalToolIdentityFaultStatus(identityFault) }
      )
    }
    if (error instanceof McpToolsNotAllowedError) {
      return createResponse(
        { success: false, error: error.message },
        403,
        provenance,
        request.context.resolvedSecretTraceRegistry,
        request.toolId
      )
    }
    if (
      error instanceof McpOauthAuthorizationRequiredError ||
      error instanceof McpOauthRedirectRequired ||
      error instanceof UnauthorizedError
    ) {
      const oauthServerId =
        error instanceof McpOauthAuthorizationRequiredError ? error.serverId : serverId
      return createResponse(
        {
          success: false,
          error: 'OAuth re-authorization required',
          code: 'reauth_required',
          serverId: oauthServerId,
        },
        401,
        provenance,
        request.context.resolvedSecretTraceRegistry,
        request.toolId
      )
    }

    const orchestrationError = asOrchestrationError(error)
    if (orchestrationError) {
      const message =
        orchestrationError.code === 'not_found' &&
        orchestrationError.message !== 'Tool not found on the specified server'
          ? 'Resource not found'
          : orchestrationError.message
      return createResponse(
        { success: false, error: message },
        statusForOrchestrationError(orchestrationError.code),
        provenance,
        request.context.resolvedSecretTraceRegistry,
        request.toolId
      )
    }

    const categorized = categorizeError(error)
    if (categorized.status === 408) provenance?.markIncomplete('mcp-tool-execution-timeout')
    logger.error('MCP tool execution failed', {
      error: getErrorMessage(error),
      requestId: request.requestId,
      serverId,
      toolName,
    })
    return createResponse(
      { success: false, error: categorized.message },
      categorized.status,
      provenance,
      request.context.resolvedSecretTraceRegistry,
      request.toolId
    )
  }
}
