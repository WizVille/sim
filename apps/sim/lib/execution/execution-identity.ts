/**
 * Execution identity headers.
 *
 * Sim attaches the originating workflow, block and execution IDs to outbound
 * requests it makes on behalf of a running workflow (remote MCP servers, the
 * LiteLLM gateway) so downstream systems can attribute and trace the call.
 *
 * These differ from `X-Sim-Via` (see `@/lib/execution/call-chain`), which is a
 * loop-detection chain rather than an attribution signal.
 */

import { createLogger } from '@sim/logger'
import { truncate } from '@sim/utils/string'

const logger = createLogger('ExecutionIdentity')

export const SIM_WORKFLOW_ID_HEADER = 'X-Sim-Workflow-Id'
export const SIM_BLOCK_ID_HEADER = 'X-Sim-Block-Id'
export const SIM_EXECUTION_ID_HEADER = 'X-Sim-Execution-Id'

export const EXECUTION_IDENTITY_HEADERS = [
  SIM_WORKFLOW_ID_HEADER,
  SIM_BLOCK_ID_HEADER,
  SIM_EXECUTION_ID_HEADER,
] as const

/** Maximum accepted length of an identity header value. */
export const MAX_IDENTITY_VALUE_LENGTH = 200

/**
 * Identifier charset accepted in an identity header value. Deliberately narrow:
 * these values are written into outbound HTTP headers sent to third parties, so
 * anything outside the shape of a Sim identifier (UUIDs, short IDs, legacy
 * block slugs) is dropped rather than sanitized in place.
 */
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:@-]+$/

export interface ExecutionIdentity {
  workflowId?: string
  blockId?: string
  executionId?: string
}

/**
 * Normalizes a single identity value. Returns `undefined` when the value is
 * absent, empty, or contains characters that are unsafe to place in a header
 * (control characters, CR/LF, separators).
 */
function normalizeIdentityValue(
  value: string | null | undefined,
  headerName: string
): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (!SAFE_IDENTIFIER_PATTERN.test(trimmed)) {
    logger.warn(`Dropping unsafe ${headerName} value`, { length: trimmed.length })
    return undefined
  }

  return truncate(trimmed, MAX_IDENTITY_VALUE_LENGTH, '')
}

/**
 * Builds the outbound identity header map, omitting any identifier that is
 * missing or unsafe.
 */
export function buildExecutionIdentityHeaders(identity: ExecutionIdentity): Record<string, string> {
  const headers: Record<string, string> = {}

  const workflowId = normalizeIdentityValue(identity.workflowId, SIM_WORKFLOW_ID_HEADER)
  if (workflowId) headers[SIM_WORKFLOW_ID_HEADER] = workflowId

  const blockId = normalizeIdentityValue(identity.blockId, SIM_BLOCK_ID_HEADER)
  if (blockId) headers[SIM_BLOCK_ID_HEADER] = blockId

  const executionId = normalizeIdentityValue(identity.executionId, SIM_EXECUTION_ID_HEADER)
  if (executionId) headers[SIM_EXECUTION_ID_HEADER] = executionId

  return headers
}

/**
 * Re-reads the identity headers from an inbound request so an internal hop can
 * forward them further. Values are revalidated, never trusted as-is.
 */
export function extractExecutionIdentityHeaders(headers: Headers): Record<string, string> {
  return buildExecutionIdentityHeaders({
    workflowId: headers.get(SIM_WORKFLOW_ID_HEADER) ?? undefined,
    blockId: headers.get(SIM_BLOCK_ID_HEADER) ?? undefined,
    executionId: headers.get(SIM_EXECUTION_ID_HEADER) ?? undefined,
  })
}
