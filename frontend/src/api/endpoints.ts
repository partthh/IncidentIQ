/**
 * Typed endpoint bindings — one function per backend operation the dashboard uses.
 *
 * Grouping them here keeps URL strings out of components and makes the set of calls
 * the dashboard can make reviewable in one file.
 */

import { request, type Query } from './client'
import type {
  AnalysisDetail,
  AnalysisSummary,
  AssigneeOption,
  IncidentDetail,
  IncidentSummary,
  LoginResponse,
  MetricsSummary,
  PageResponse,
  QueueHealth,
  QueueResponse,
  RawResponse,
  ServiceView,
  TimelineResponse,
  UserView,
} from './types'

// ---------------------------------------------------------------- auth

export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', { method: 'POST', body: { email, password } })
}

export function me(): Promise<UserView> {
  return request<UserView>('/auth/me')
}

// ---------------------------------------------------------------- incidents

export interface IncidentFilter extends Query {
  status?: string
  severity?: string
  serviceId?: string
  assignedTo?: string
  unassigned?: boolean
  search?: string
  activeOnly?: boolean
  sort?: string
  ascending?: boolean
}

export function listIncidents(
  filter: IncidentFilter,
  page: number,
  size: number,
): Promise<PageResponse<IncidentSummary>> {
  return request<PageResponse<IncidentSummary>>('/incidents', {
    query: { ...filter, page, size },
  })
}

export function getIncident(id: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${id}`)
}

export function getIncidentByReference(reference: string): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/by-reference/${encodeURIComponent(reference)}`)
}

export function getTimeline(
  incidentId: string,
  afterSequence?: number,
  limit = 200,
): Promise<TimelineResponse> {
  return request<TimelineResponse>(`/incidents/${incidentId}/timeline`, {
    query: { afterSequence, limit },
  })
}

export function assignableUsers(): Promise<AssigneeOption[]> {
  return request<AssigneeOption[]>('/incidents/assignable-users')
}

/**
 * Mutating calls.
 *
 * Each sends `If-Match` with the version the dashboard currently holds. That is what
 * turns "someone else changed this" into a 409 the UI can explain, instead of a
 * silent overwrite: the dashboard never resolves an incident it never saw the state of.
 */

export function acknowledge(incidentId: string, expectedVersion: number): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${incidentId}/acknowledge`, {
    method: 'POST',
    body: {},
    ifMatch: expectedVersion,
  })
}

export function startInvestigating(incidentId: string, expectedVersion: number): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${incidentId}/investigate`, {
    method: 'POST',
    body: {},
    ifMatch: expectedVersion,
  })
}

export function assign(
  incidentId: string,
  assigneeId: string | null,
  expectedVersion: number,
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${incidentId}/assignment`, {
    method: 'POST',
    body: { assignee: assigneeId ? { id: assigneeId } : null },
    ifMatch: expectedVersion,
  })
}

export function addNote(
  incidentId: string,
  body: string,
  expectedVersion: number,
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${incidentId}/notes`, {
    method: 'POST',
    body: { body },
    ifMatch: expectedVersion,
  })
}

export function resolve(
  incidentId: string,
  rootCause: string,
  preventiveActions: string,
  expectedVersion: number,
): Promise<IncidentDetail> {
  return request<IncidentDetail>(`/incidents/${incidentId}/resolve`, {
    method: 'POST',
    body: { rootCause, preventiveActions },
    ifMatch: expectedVersion,
  })
}

/**
 * Requests an AI investigation.
 *
 * Returns 202 with a queued job, not an answer. The UI must not treat the response as
 * a result — that is the whole reason the work happens on the queue.
 */
export function requestAiInvestigation(incidentId: string, note?: string): Promise<QueueResponse> {
  return request<QueueResponse>(`/incidents/${incidentId}/investigations`, {
    method: 'POST',
    body: { note: note ?? null },
  })
}

// ---------------------------------------------------------------- analyses

export function listAnalyses(
  incidentId: string,
  page = 0,
  size = 10,
): Promise<PageResponse<AnalysisSummary>> {
  return request<PageResponse<AnalysisSummary>>(`/incidents/${incidentId}/analyses`, {
    query: { page, size },
  })
}

/** Newest analysis, or undefined when the incident has never been investigated. */
export function latestAnalysis(incidentId: string): Promise<AnalysisDetail | undefined> {
  return request<AnalysisDetail | undefined>(`/incidents/${incidentId}/analyses/latest`, {
    allowNotFound: true,
  })
}

/** ADMIN only. The server narrows this; a viewer gets 403, not an empty result. */
export function rawResponse(analysisId: string): Promise<RawResponse> {
  return request<RawResponse>(`/analyses/${analysisId}/raw-response`)
}

export function queueHealth(): Promise<QueueHealth> {
  return request<QueueHealth>('/metrics/queue')
}

// ---------------------------------------------------------------- other

export function metricsSummary(): Promise<MetricsSummary> {
  return request<MetricsSummary>('/metrics/summary')
}

export function listServices(): Promise<ServiceView[]> {
  return request<ServiceView[]>('/services')
}