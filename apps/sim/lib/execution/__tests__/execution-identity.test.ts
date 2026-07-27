/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  buildExecutionIdentityHeaders,
  extractExecutionIdentityHeaders,
  MAX_IDENTITY_VALUE_LENGTH,
  SIM_BLOCK_ID_HEADER,
  SIM_EXECUTION_ID_HEADER,
  SIM_WORKFLOW_ID_HEADER,
} from '@/lib/execution/execution-identity'

describe('execution-identity', () => {
  describe('header names', () => {
    it('uses the X-Sim-* convention', () => {
      expect(SIM_WORKFLOW_ID_HEADER).toBe('X-Sim-Workflow-Id')
      expect(SIM_BLOCK_ID_HEADER).toBe('X-Sim-Block-Id')
      expect(SIM_EXECUTION_ID_HEADER).toBe('X-Sim-Execution-Id')
    })
  })

  describe('buildExecutionIdentityHeaders', () => {
    it('emits all three headers when present', () => {
      expect(
        buildExecutionIdentityHeaders({
          workflowId: 'wf-1',
          blockId: 'block-1',
          executionId: 'exec-1',
        })
      ).toEqual({
        [SIM_WORKFLOW_ID_HEADER]: 'wf-1',
        [SIM_BLOCK_ID_HEADER]: 'block-1',
        [SIM_EXECUTION_ID_HEADER]: 'exec-1',
      })
    })

    it('accepts UUID identifiers', () => {
      const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
      expect(buildExecutionIdentityHeaders({ workflowId: uuid })).toEqual({
        [SIM_WORKFLOW_ID_HEADER]: uuid,
      })
    })

    it('omits missing and empty identifiers', () => {
      expect(
        buildExecutionIdentityHeaders({
          workflowId: 'wf-1',
          blockId: '   ',
          executionId: undefined,
        })
      ).toEqual({ [SIM_WORKFLOW_ID_HEADER]: 'wf-1' })
    })

    it('returns an empty map when nothing is provided', () => {
      expect(buildExecutionIdentityHeaders({})).toEqual({})
    })

    it('trims surrounding whitespace', () => {
      expect(buildExecutionIdentityHeaders({ blockId: '  block-1  ' })).toEqual({
        [SIM_BLOCK_ID_HEADER]: 'block-1',
      })
    })

    it('drops values containing CR/LF', () => {
      expect(buildExecutionIdentityHeaders({ blockId: 'block-1\r\nX-Injected: evil' })).toEqual({})
    })

    it('drops values with unsafe characters', () => {
      expect(buildExecutionIdentityHeaders({ workflowId: 'wf 1' })).toEqual({})
      expect(buildExecutionIdentityHeaders({ workflowId: 'wf,1' })).toEqual({})
      expect(buildExecutionIdentityHeaders({ workflowId: 'wf/1' })).toEqual({})
    })

    it('truncates overlong values without a suffix', () => {
      const long = 'a'.repeat(MAX_IDENTITY_VALUE_LENGTH + 50)
      const headers = buildExecutionIdentityHeaders({ executionId: long })
      expect(headers[SIM_EXECUTION_ID_HEADER]).toBe('a'.repeat(MAX_IDENTITY_VALUE_LENGTH))
    })
  })

  describe('extractExecutionIdentityHeaders', () => {
    it('round-trips built headers', () => {
      const identity = { workflowId: 'wf-1', blockId: 'block-1', executionId: 'exec-1' }
      const built = buildExecutionIdentityHeaders(identity)
      expect(extractExecutionIdentityHeaders(new Headers(built))).toEqual(built)
    })

    it('returns an empty map when no identity headers are present', () => {
      expect(
        extractExecutionIdentityHeaders(new Headers({ 'content-type': 'application/json' }))
      ).toEqual({})
    })

    it('revalidates inbound values instead of trusting them', () => {
      const headers = new Headers()
      headers.set(SIM_WORKFLOW_ID_HEADER, 'wf 1')
      headers.set(SIM_BLOCK_ID_HEADER, 'block-1')
      expect(extractExecutionIdentityHeaders(headers)).toEqual({
        [SIM_BLOCK_ID_HEADER]: 'block-1',
      })
    })
  })
})
