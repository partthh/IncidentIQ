/**
 * TypeScript mirrors of the backend's read models.
 *
 * Every shape here corresponds to a record or view class in the Java source. When
 * the wire contract changes, this file is the place it shows up first — and because
 * the compiler checks the dashboard against it, a change cannot silently drift.
 *
 * Note what is *absent*: `AnalysisDetail` has no raw response field. The backend
 * deliberately withholds it from the default view so unvalidated model text is
 * never rendered next to validated text. Admin-only access lives behind a separate
 * endpoint the dashboard calls explicitly.
 */

export type Role = 'ADMIN' | 'ENGINEER' | 'VIEWER'

export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESOLVED'

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN'

export type AnalysisStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REJECTED'

export type RealtimeEventType =
  | 'INCIDENT_CREATED'
  | 'INCIDENT_UPDATED'
  | 'INCIDENT_ASSIGNED'
  | 'INCIDENT_ACKNOWLEDGED'
  | 'INCIDENT_INVESTIGATING'
  | 'INCIDENT_RESOLVED'
  | 'AI_ANALYSIS_STARTED'
  | 'AI_ANALYSIS_COMPLETED'
  | 'AI_ANALYSIS_FAILED'
  | 'TIMELINE_ENTRY_ADDED'

export interface UserView {
  id: string
  name: string
  email: string
  role: Role
}

export interface LoginResponse {
  accessToken: string
  tokenType: string
  expiresAt: string
  user: UserView
}

export interface ServiceRef {
  id: string
  name: string
  environment: string
  healthStatus: HealthStatus
  ownerTeam?: string
}

export interface AssigneeRef {
  id: string
  name: string
  email: string
}

export interface IncidentSummary {
  id: string
  reference: string
  title: string
  service: ServiceRef
  severity: Severity
  status: IncidentStatus
  assignedTo?: AssigneeRef
  firstSeenAt: string
  lastSeenAt: string
  eventCount: number
  timelineSeq: number
  version: number
}

export interface IncidentDetail extends IncidentSummary {
  detectionRuleCode?: string
  correlationGroup?: string
  errorSignature?: string
  triggerEvidence?: string
  resolvedAt?: string
  resolvedRootCause?: string
  preventiveActions?: string
}

export interface TimelineActor {
  id: string
  name: string
  email: string
  role: Role
}

export interface TimelineEntry {
  id: string
  sequence: number
  eventType: string
  summary: string
  actor?: TimelineActor
  payload?: Record<string, unknown>
  createdAt: string
}

export interface TimelineResponse {
  incidentId: string
  currentSequence: number
  hasMore: boolean
  entries: TimelineEntry[]
}

export interface Hypothesis {
  cause: string
  confidence: number
  evidence: string[]
  nextChecks: string[]
  evidenceEventIds: string[]
}

export interface IncidentAnalysis {
  summary: string
  hypotheses: Hypothesis[]
  missingEvidence: string[]
  caveats: string[]
}

export interface AnalysisSummary {
  id: string
  reference: string
  incidentId: string
  incidentReference: string
  incidentTitle: string
  service: string
  incidentSeverity: Severity
  status: AnalysisStatus
  attemptCount: number
  triggerReason: string
  modelName: string
  promptVersion: string
  createdAt: string
  completedAt?: string
  durationMs?: number
  errorCode?: string
  topHypothesis?: string
}

export interface AnalysisDetail {
  id: string
  reference: string
  incidentId: string
  incidentReference: string
  modelName: string
  promptVersion: string
  status: AnalysisStatus
  attemptCount: number
  triggerReason: string
  analysis?: IncidentAnalysis
  usage?: Record<string, unknown>
  requestedBy?: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  errorCode?: string
  errorMessage?: string
}

export interface QueueResponse {
  analysisId: string
  reference: string
  incidentReference: string
  status: AnalysisStatus
  triggerReason: string
  message: string
}

export interface RawResponse {
  analysisId: string
  reference: string
  modelName: string
  status: AnalysisStatus
  promptVersion: string
  /**
   * Unvalidated model output. Rendered as text in a <pre>, never as markup: it may
   * contain instructions lifted from a log payload and quoted back by the model.
   */
  unvalidated?: string
  completedAt?: string
}

export interface PageResponse<T> {
  items: T[]
  page: number
  size: number
  totalItems: number
  totalPages: number
  hasNext: boolean
}

export interface AssigneeOption {
  id: string
  name: string
  email: string
  role: Role
}

export interface ServiceView {
  id: string
  name: string
  environment: string
  qualifiedName: string
  healthStatus: HealthStatus
  ownerTeam?: string
  createdAt: string
}

export interface RealtimeEnvelope {
  eventId: string
  type: RealtimeEventType
  incidentId: string
  incidentReference: string
  occurredAt: string
  sequence: number
  payload: unknown
}

export interface MetricsSummary {
  generatedAt: string
  activeIncidents: number
  resolvedIncidents: number
  incidentsByStatus: Record<string, number>
  activeIncidentsBySeverity: Record<string, number>
  activeIncidentsByService: Array<{ service: string; activeIncidents: number }>
  ai: {
    total: number
    byStatus: Record<string, number>
    /**
     * Absent — and therefore `undefined`, not merely null — when nothing has completed:
     * the API omits the field rather than serialising a null. Rendering 0 would claim a
     * latency was measured when no measurement exists, so consumers must test for both.
     */
    meanDurationMs?: number | null
    completedCount: number
  }
  ingestedEvents: number
}

export interface QueueHealth {
  queued: number
  running: number
  rejected: number
  failed: number
  knownStatuses: AnalysisStatus[]
}

export interface ApiErrorBody {
  timestamp?: string
  status: number
  code: string
  message: string
  path?: string
  traceId?: string
  details?: Record<string, string>
}