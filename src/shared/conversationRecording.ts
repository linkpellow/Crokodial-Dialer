/** Shared recording and notes bounds; no provider credentials belong here. */
export const RECORDING_MAX_BYTES = 64 * 1024 * 1024;
export const RECORDING_MAX_DURATION_SECONDS = 120 * 60;
export const CONTACT_NOTES_MAX_CHARACTERS = 200_000;
export type ConversationRecordingSource = 'microphone' | 'dialer';
export type ConversationRecordingStatus = 'queued' | 'transcribing' | 'summarizing' | 'completed' | 'failed' | 'needs_review';
export interface ContactNotesSnapshot { contactId: number; notes: string; notesRevision: number }
export interface ConversationRecordingCapabilities {
  available: boolean;
  maxBytes: number;
  maxDurationSeconds: number;
  notesMaxCharacters: number;
  reason?: string;
}
export interface ConversationRecordingState {
  recordingId: string;
  contactId: number;
  source: ConversationRecordingSource;
  callId?: string | null;
  status: ConversationRecordingStatus;
  error?: string | null;
  retryable: boolean;
  summary?: string | null;
  notes?: string;
  notesRevision?: number;
}

export const RECORDING_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
export const RECORDING_SEGMENT_MAX_DURATION_MS = 60_000;
export const RECORDING_SESSION_MAX_SEGMENTS = 240;
export type ConversationRecordingSessionStatus = 'active' | 'finalizing' | 'completed' | 'failed' | 'needs_review' | 'canceled';
export type ConversationRecordingSegmentStatus = 'queued' | 'transcribing' | 'summarizing' | 'completed' | 'failed' | 'needs_review' | 'canceled';
export interface ConversationRecordingSegmentState {
  sequence: number;
  startOffsetMs: number;
  endOffsetMs: number;
  status: ConversationRecordingSegmentStatus;
  summary?: string | null;
  error?: string | null;
  retryable: boolean;
  audioAvailable: boolean;
}
export interface ConversationRecordingSessionSummary {
  sessionId: string;
  contactId: number;
  source: ConversationRecordingSource;
  callId?: string | null;
  startedAt: string;
  endedAt?: string | null;
  retainAudio: boolean;
  status: ConversationRecordingSessionStatus;
  error?: string | null;
  retryable: boolean;
  totalDurationSeconds: number;
  totalBytes: number;
  segmentCount: number;
  audioAvailable: boolean;
}
export interface ConversationRecordingSessionState extends ConversationRecordingSessionSummary {
  segments: ConversationRecordingSegmentState[];
  draftNotes: string;
  summary?: string | null;
  notes?: string;
  notesRevision?: number;
}
export interface ConversationRecordingSessionInput {
  sessionId: string;
  source: ConversationRecordingSource;
  callId?: string;
  startedAt: string;
  retainAudio?: boolean;
}

export type RecordingSession = ConversationRecordingSessionState;
export type RecordingSegment = ConversationRecordingSegmentState;
