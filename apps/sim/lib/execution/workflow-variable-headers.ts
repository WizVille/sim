/**
 * Workflow-variable passthrough headers.
 *
 * A workflow variable named `HTTP_<NAME>` rides along on every outbound call the run makes —
 * tool HTTP requests (the API block included) and MCP tool calls — as the header `<NAME>` with
 * `_` turned into `-`. So `HTTP_CONTEXT_UUID` arrives as `Context-Uuid`, which Rack exposes back
 * as `HTTP_CONTEXT_UUID`: the same round trip as `X-Sim-Execution-Id` in
 * `@/lib/execution/execution-identity`, which is the sibling of this module.
 *
 * Opting in is the naming convention and nothing else. A variable the user did not prefix is
 * never sent, because these headers reach third-party APIs.
 */

import { createLogger } from '@sim/logger'
import { isPlainRecord } from '@sim/utils/object'
import { truncate } from '@sim/utils/string'

const logger = createLogger('WorkflowVariableHeaders')

/** Marks a workflow variable as destined for outbound request headers. */
export const WORKFLOW_VARIABLE_HEADER_PREFIX = 'HTTP_'

/** Maximum accepted length of a forwarded header value. */
export const MAX_WORKFLOW_VARIABLE_HEADER_VALUE_LENGTH = 1024

/**
 * Header names are restricted to unreserved token characters. `_` is a legal token character
 * but nginx drops such headers by default (`underscores_in_headers off`), so the prefix-stripped
 * name has its underscores converted rather than passed through.
 */
const SAFE_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/

/** Control characters, which includes the CR/LF that would splice in a second header. */
const UNSAFE_HEADER_VALUE_PATTERN = /[\u0000-\u001F\u007F]/

/**
 * Derives the wire header name, or `undefined` when the variable does not opt in or the
 * remainder cannot be a header name. Matching the prefix is case-sensitive: `http_foo` is a
 * variable someone named in lower case, not a request to publish it.
 *
 * `HTTP_CONTEXT_UUID` becomes `Context-Uuid`. Header names are case-insensitive on the wire, so
 * the title case is purely for legibility in a log or a proxy trace — it matches how the sibling
 * `X-Sim-Execution-Id` is spelled rather than shouting the variable's own screaming snake case.
 */
function toHeaderName(variableName: string): string | undefined {
  const trimmed = variableName.trim()
  if (!trimmed.startsWith(WORKFLOW_VARIABLE_HEADER_PREFIX)) return undefined

  const dashed = trimmed.slice(WORKFLOW_VARIABLE_HEADER_PREFIX.length).replaceAll('_', '-')
  if (!dashed || !SAFE_HEADER_NAME_PATTERN.test(dashed)) {
    logger.warn('Dropping workflow variable whose name cannot form a header', {
      length: trimmed.length,
    })
    return undefined
  }
  return dashed
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-')
}

/**
 * Renders a variable value for a header, or `undefined` when it has no single-line
 * representation. Objects and arrays are dropped rather than JSON-encoded: a structured value
 * in a header is a footgun for the receiver, and silently flattening one hides the mistake.
 */
function toHeaderValue(value: unknown, headerName: string): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined
  }
  if (typeof value === 'boolean') return String(value)
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (UNSAFE_HEADER_VALUE_PATTERN.test(trimmed)) {
    logger.warn(`Dropping unsafe ${headerName} workflow variable value`, {
      length: trimmed.length,
    })
    return undefined
  }
  return truncate(trimmed, MAX_WORKFLOW_VARIABLE_HEADER_VALUE_LENGTH, '')
}

/**
 * Reads the name and value of one entry of `ExecutionContext.workflowVariables`.
 *
 * The record is keyed by variable id and holds whole `{ id, name, type, value }` entries, but
 * `normalizeWorkflowVariables` passes any plain record through untouched — so a legacy or
 * imported snapshot can present a bare name-to-value map, and both shapes have to resolve.
 */
function readVariableEntry(key: string, entry: unknown): { name: string; value: unknown } {
  if (isPlainRecord(entry) && typeof entry.name === 'string') {
    return { name: entry.name, value: entry.value }
  }
  return { name: key, value: entry }
}

/**
 * Builds the outbound header map from a run's workflow variables, omitting every variable that
 * does not opt in or whose name or value is unusable.
 */
export function buildWorkflowVariableHeaders(
  workflowVariables: Record<string, unknown> | undefined
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!isPlainRecord(workflowVariables)) return headers

  for (const [key, entry] of Object.entries(workflowVariables)) {
    const { name, value } = readVariableEntry(key, entry)
    const headerName = toHeaderName(name)
    if (!headerName) continue

    const headerValue = toHeaderValue(value, headerName)
    if (headerValue !== undefined) headers[headerName] = headerValue
  }

  return headers
}
