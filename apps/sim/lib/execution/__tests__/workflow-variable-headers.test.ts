/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildWorkflowVariableHeaders,
  MAX_WORKFLOW_VARIABLE_HEADER_VALUE_LENGTH,
} from '@/lib/execution/workflow-variable-headers'

/** One entry as `ExecutionContext.workflowVariables` holds it: keyed by id, name inside. */
function variable(id: string, name: string, value: unknown) {
  return { [id]: { id, name, type: 'plain', value } }
}

describe('buildWorkflowVariableHeaders', () => {
  it('strips the prefix and converts underscores to dashes', () => {
    expect(
      buildWorkflowVariableHeaders({
        ...variable('var-1', 'HTTP_CONTEXT_UUID', 'ctx-123'),
        ...variable('var-2', 'HTTP_X_TENANT_ID', 'tenant-9'),
        ...variable('var-3', 'HTTP_TRACE', 'abc'),
      })
    ).toEqual({
      'Context-Uuid': 'ctx-123',
      'X-Tenant-Id': 'tenant-9',
      Trace: 'abc',
    })
  })

  it('forwards only variables that opt in', () => {
    expect(
      buildWorkflowVariableHeaders({
        ...variable('var-1', 'HTTP_CONTEXT_UUID', 'ctx-123'),
        ...variable('var-2', 'apiToken', 'secret-value'),
        ...variable('var-3', 'http_context_uuid', 'lowercase-is-not-opt-in'),
        ...variable('var-4', 'MY_HTTP_THING', 'not-a-prefix'),
      })
    ).toEqual({ 'Context-Uuid': 'ctx-123' })
  })

  it('reads a bare name-to-value map as well as id-keyed entries', () => {
    expect(buildWorkflowVariableHeaders({ HTTP_CONTEXT_UUID: 'ctx-123' })).toEqual({
      'Context-Uuid': 'ctx-123',
    })
  })

  it('renders scalars and drops values with no single-line form', () => {
    expect(
      buildWorkflowVariableHeaders({
        ...variable('var-1', 'HTTP_COUNT', 42),
        ...variable('var-2', 'HTTP_ENABLED', false),
        ...variable('var-3', 'HTTP_OBJECT', { nested: true }),
        ...variable('var-4', 'HTTP_LIST', ['a']),
        ...variable('var-5', 'HTTP_MISSING', null),
        ...variable('var-6', 'HTTP_BLANK', '   '),
        ...variable('var-7', 'HTTP_NOT_FINITE', Number.POSITIVE_INFINITY),
      })
    ).toEqual({ Count: '42', Enabled: 'false' })
  })

  it('drops a value that would splice in a second header', () => {
    expect(
      buildWorkflowVariableHeaders(variable('var-1', 'HTTP_CONTEXT', 'ctx\r\nX-Injected: evil'))
    ).toEqual({})
  })

  it('drops a name that cannot form a header', () => {
    expect(
      buildWorkflowVariableHeaders({
        ...variable('var-1', 'HTTP_', 'empty-remainder'),
        ...variable('var-2', 'HTTP_WITH SPACE', 'spaced'),
        ...variable('var-3', 'HTTP_WITH:COLON', 'coloned'),
        ...variable('var-4', 'HTTP_ACCENTUÉ', 'accented'),
      })
    ).toEqual({})
  })

  it('caps a long value instead of dropping it', () => {
    const long = 'x'.repeat(MAX_WORKFLOW_VARIABLE_HEADER_VALUE_LENGTH + 50)
    const headers = buildWorkflowVariableHeaders(variable('var-1', 'HTTP_CONTEXT', long))

    expect(headers.Context).toHaveLength(MAX_WORKFLOW_VARIABLE_HEADER_VALUE_LENGTH)
  })

  it('returns nothing for a run with no variables', () => {
    expect(buildWorkflowVariableHeaders(undefined)).toEqual({})
    expect(buildWorkflowVariableHeaders({})).toEqual({})
  })
})
