import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  BookmarkSimple,
  Broadcast,
  ArrowsLeftRight,
  CaretDown,
  CaretRight,
  CellSignalFull,
  Check,
  Circle,
  ClockCounterClockwise,
  Database,
  DownloadSimple,
  FloppyDisk,
  FolderOpen,
  FunnelSimple,
  Gear,
  NotePencil,
  Package,
  Pause,
  Play,
  Plus,
  RadioButton,
  SpinnerGap,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Bar, BarChart, Line, LineChart, ResponsiveContainer } from "recharts";

import {
  downloadEvidenceBundle,
  suggestEvidenceBundleFilename,
  type EvidenceBundleInclusions,
} from "./domain/bundle";
import { serializeSessionDocument } from "./data/session-file";
import { CaptureDialog } from "./capture/CaptureDialog";
import {
  MANUAL_OPERATOR_RUNTIME,
  type OperatorRuntime,
} from "./runtime/operator-runtime";
import { SUPPORTED_DECODER } from "./domain/decoder";
import { projectIncident, rowsInRange, validateIncidentPreset } from "./domain/session";
import { MAX_INCIDENT_TITLE_LENGTH, type AuthoredIncidentRange, type DiagnosticEvent, type IncidentProjection, type Marker, type ParsedSession, type SessionDocument, type TransportEvent, type TransportProvenance, type UdpRemoteEndpoint } from "./domain/types";
import { loadBundledSession, loadSessionFile, SessionLoadError } from "./data/load-session";
import {
  processingProgress,
  type SessionProcessingProgress,
} from "./processing/contracts";
import {
  processSessionBlob,
  SessionProcessingCancelledError,
} from "./processing/process-session";
import {
  buildEvidenceBundleInWorker,
  EvidenceBundleProcessingCancelledError,
  type EvidenceBundleProcessingProgress,
} from "./processing/evidence-bundle-processing";
import { downsampleBuckets, finiteOrDash, incidentViewRange, percentInRange, valueAtOffset } from "./lib/telemetry";
import { formatBytes, formatClockOffset, formatDurationUs, formatOffsetUsInput, formatSessionDate, parseOffsetUsInput, timeZoneAbbreviation } from "./lib/time";
import { useReplay } from "./replay/useReplay";
import {
  createSessionLibrary,
  sessionLibraryIdentity,
  SessionLibraryError,
  type SessionLibrary,
  type SessionLibraryEntry,
} from "./storage/session-library";
import { createOperationGate, resolveCommittedSave } from "./storage/session-library-workflow";
import { clearSessionWorkspace, loadSessionWorkspace, saveSessionWorkspace } from "./storage/session-storage";
import { ReceiverWorkspace } from "./receiver/ReceiverWorkspace";
import { CaseWorkspace } from "./cases/CaseWorkspace";
import {
  EvidenceBundleLoadError,
  loadEvidenceBundleFile,
} from "./receiver/load-evidence-bundle";
import type { ReceiverDocument } from "./receiver/receiver-document";
import {
  createReceiverComparisonSource,
  createSessionComparisonSource,
  type ComparisonModel,
  type ComparisonSource,
} from "./domain/comparison";
import {
  ComparisonSetupDialog,
  ComparisonWorkspace,
} from "./comparison/ComparisonWorkspace";

type ActiveTab = "narrative" | "details" | "provenance" | "stats";
const INCIDENT_TABS: ActiveTab[] = ["narrative", "details", "provenance", "stats"];
type LoadState =
  | { status: "loading"; message: string; progress?: SessionProcessingProgress }
  | { status: "ready"; session: ParsedSession }
  | { status: "receiver"; document: ReceiverDocument; fileName: string }
  | { status: "error"; error: SessionLoadError };

type EvidenceOpenState =
  | { status: "idle" }
  | { status: "verifying"; fileName: string }
  | { status: "error"; fileName: string; error: EvidenceBundleLoadError };

type ReplayProcessingSource =
  | {
      kind: "file";
      file: File;
      name: string;
      size: number;
    }
  | {
      kind: "library";
      identity: string;
      name: string;
      size: number;
    };

type ReplayProcessingState =
  | { status: "idle" }
  | {
      status: "processing";
      source: ReplayProcessingSource;
      progress: SessionProcessingProgress;
    }
  | {
      status: "error";
      source: ReplayProcessingSource;
      error: SessionLoadError;
    };

type SessionLibraryStatus = "loading" | "ready" | "unavailable" | "error";
type SessionLibraryAction =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "opening"; identity: string }
  | { kind: "removing"; identity: string };

type WorkspacePersistenceState = "stored" | "memory-only" | "unavailable";
type WorkspacePersistenceCommand = {
  identity: string;
  kind: "clear" | "save";
  revision: number;
};

interface SessionLibraryController {
  entries: SessionLibraryEntry[];
  status: SessionLibraryStatus;
  action: SessionLibraryAction;
  activeIdentity: string | null;
  pendingDeleteIdentity: string | null;
  error: string | null;
  notice: string;
  onSaveCurrent: () => void;
  onRetry: () => void;
  onOpen: (identity: string) => void;
  onRequestDelete: (identity: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (identity: string) => void;
}

type BundleItemId = "rawRecords" | "decodedPackets" | "schema" | "diagnostics" | "captureIntegrity" | "notes";

interface BundleItem {
  id: BundleItemId;
  name: string;
  description: string;
  source: string;
  estimatedBytes: number;
  selected: boolean;
  required?: boolean;
}

const FAMILY_ROWS = [
  { id: "Position", label: "Position (0x31)", color: "#8bc879" },
  { id: "Power", label: "Power (0x17)", color: "#6398d6" },
  { id: "Thermal", label: "Thermal (0x44)", color: "#f2a900" },
  { id: "Attitude", label: "Attitude (0x19)", color: "#8a78d6" },
  { id: "Heartbeat", label: "Heartbeat (0x02)", color: "#53b8b7" },
] as const;

const DEFAULT_NOTE = "Likely multipath from ferry traffic. Antenna re-aimed 5° up. Recommend checking tower guy-wire clearance.";
const BUNDLED_DEMO_ID = "harbor-relay-2026-07-15-213812";
const BUNDLED_DEMO_STARTED_AT = "2026-07-16T04:38:12.000Z";
const BUNDLED_DEMO_SCHEMA_HASH = SUPPORTED_DECODER.schemaHash;
const BUNDLED_DEMO_CONTENT_FINGERPRINT = "2d75a2cf9bc0fe2941316cc75e394b5b";
const BUNDLED_DEMO_WORKSPACE_REVISION = "mission-timeline-fidelity-v1";
const SESSION_IDENTITY_CACHE = new WeakMap<ParsedSession, string>();

function isBundledDemoSession(session: ParsedSession): boolean {
  return session.document.id === BUNDLED_DEMO_ID
    && session.document.startedAt === BUNDLED_DEMO_STARTED_AT
    && session.document.decoder.schemaHash === BUNDLED_DEMO_SCHEMA_HASH
    && sessionWorkspaceIdentity(session).endsWith(`:${BUNDLED_DEMO_CONTENT_FINGERPRINT}`);
}

function mixFingerprint(value: string, hashes: [number, number, number, number]): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hashes[0] = Math.imul(hashes[0] ^ code, 16_777_619) >>> 0;
    hashes[1] = (Math.imul(hashes[1], 33) ^ code) >>> 0;
    hashes[2] = Math.imul(hashes[2] ^ code, 2_246_822_519) >>> 0;
    hashes[3] = Math.imul(hashes[3] + code, 3_266_489_917) >>> 0;
  }
}

export function sessionContentFingerprint(session: ParsedSession): string {
  if (session.document.records.length >= 50_000 && session.canonicalIdentity) {
    return session.canonicalIdentity.replace(/^sha256:/, "").slice(0, 32);
  }
  const hashes: [number, number, number, number] = [2_166_136_261, 5_381, 2_654_435_769, 2_246_822_507];
  mixFingerprint(JSON.stringify(session.document), hashes);
  return hashes.map((hash) => hash.toString(16).padStart(8, "0")).join("");
}

function sessionWorkspaceIdentity(session: ParsedSession): string {
  const cached = SESSION_IDENTITY_CACHE.get(session);
  if (cached) return cached;
  const contentFingerprint = sessionContentFingerprint(session);
  const identity = [
    session.document.id,
    session.document.startedAt,
    session.document.durationUs,
    session.document.source.id,
    session.document.decoder.schemaHash,
    session.document.records.length,
    contentFingerprint,
  ].join(":");
  SESSION_IDENTITY_CACHE.set(session, identity);
  return identity;
}

function sessionWorkspaceStorageIdentity(session: ParsedSession): string {
  const identity = sessionWorkspaceIdentity(session);
  return isBundledDemoSession(session) ? `${identity}:${BUNDLED_DEMO_WORKSPACE_REVISION}` : identity;
}

function createSeedMarkers(session: ParsedSession): Marker[] {
  const incident = session.incidents.find((candidate) => candidate.id === "fade") ?? session.incidents[0];
  if (!incident) return [];
  const seeds = [
    { offsetUs: Math.max(0, incident.startUs - 72_000_000), title: "Tower check", note: "Field note before the fade.", category: "field-note" as const },
    { offsetUs: incident.startUs + 55_000_000, title: "Interference observed", note: "RF conditions degraded at the harbor relay.", category: "observation" as const },
    { offsetUs: Math.min(session.document.durationUs - 1, incident.endUs + 18_000_000), title: "Antenna re-aimed", note: "Antenna adjusted five degrees upward.", category: "maintenance" as const },
  ];
  return seeds.map((seed, index) => ({
    id: `demo-marker-${index + 1}`,
    ...seed,
    createdAt: new Date(new Date(session.document.startedAt).getTime() + seed.offsetUs / 1000).toISOString(),
  }));
}

function formatSource(session: ParsedSession): string {
  const { source } = session.document;
  return source.port ? `${source.kind.toUpperCase()} :${source.port}` : source.label;
}

function formatDecoderRevision(revision: string): string {
  return revision.toLowerCase().startsWith("v") ? revision : `v${revision}`;
}

function shortDiagnosticTitle(event: DiagnosticEvent): string {
  const titles: Record<DiagnosticEvent["type"], string> = {
    "link-degraded": "Link quality ↓",
    "loss-burst": "Loss burst",
    "decoder-resync": "Decoder resync",
    recovery: "Recovered",
    "decoder-locked": "Decoder locked",
    "crc-failure": "CRC failure",
    "checksum-failure": "Checksum failure",
    "partial-frame": "Partial frame",
    "capture-path-event": "Capture path",
  };
  return titles[event.type];
}

const FAILURE_DOMAIN_LABELS: Record<DiagnosticEvent["domain"], string> = {
  link: "Link",
  decoder: "Decoder",
  "capture-path": "Capture path",
  unknown: "Unknown",
};

function failureDomainLabel(domain: DiagnosticEvent["domain"]): string {
  return FAILURE_DOMAIN_LABELS[domain];
}

function captureIntegrityLabel(session: ParsedSession): string {
  if (session.captureIntegrity.status === "verified") return "Verified";
  if (session.captureIntegrity.status === "incomplete") return "Incomplete";
  if (session.captureIntegrity.assessmentBasis === "legacy-v1") return "Unknown · legacy replay";
  if (session.captureIntegrity.assessmentBasis === "file-source-unassessed") return "Unknown · file replay";
  return "Unknown";
}

function sessionTransportProvenance(session: ParsedSession): TransportProvenance | undefined {
  return session.document.formatVersion === 2 ? session.document.transportProvenance : undefined;
}

function formatUdpAddressPort(address: string, port: number, family: UdpRemoteEndpoint["family"]): string {
  return `${family === "IPv6" ? `[${address}]` : address}:${port}`;
}

function formatUdpEndpoint(endpoint: UdpRemoteEndpoint): string {
  return formatUdpAddressPort(endpoint.address, endpoint.port, endpoint.family);
}

function formatUsbIdentifier(value: number | null): string {
  return value === null ? "Unavailable" : `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function savedIntegrityLabel(status: SessionLibraryEntry["captureIntegrityStatus"]): string {
  if (status === "verified") return "Verified";
  if (status === "incomplete") return "Incomplete";
  return "Unknown";
}

function sessionLibraryErrorMessage(error: unknown): string {
  if (!(error instanceof SessionLibraryError)) {
    return "The local session library could not complete this operation.";
  }
  switch (error.code) {
    case "unavailable":
      return "The local session library is unavailable in this browser. The active replay remains usable.";
    case "quota":
      return "Browser storage is full. Remove a saved replay or free site storage, then try again.";
    case "not-found":
      return "That saved replay is no longer present in the local library.";
    case "corrupt":
      return "The saved replay failed its content or validation checks and was not opened.";
    case "too-large":
      return "This session exceeds the 64 MiB local-library limit. The active replay remains usable.";
    case "open-failed":
      return "The local session library could not be opened. Close other ReplayCase windows and retry.";
    case "transaction-failed":
    case "write-failed":
      return "The local session library could not finish the operation. The active replay was not changed.";
  }
}

function scheduleSavedSessionFocus(preferredIdentity: string | null = null): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const candidates = [...document.querySelectorAll<HTMLElement>("[data-saved-session-focus]")]
      .filter((candidate) => candidate.getClientRects().length > 0);
    const preferred = preferredIdentity === null
      ? null
      : candidates.find((candidate) => candidate.dataset.savedSessionIdentity === preferredIdentity) ?? null;
    (preferred ?? candidates[0])?.focus({ preventScroll: true });
  }));
}

function scheduleElementFocus(selector: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }));
}

function handleHorizontalScrollKey(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget) return;
  const element = event.currentTarget;
  if (element.scrollWidth <= element.clientWidth) return;
  const step = Math.max(48, Math.round(element.clientWidth * 0.2));
  let next: number | null = null;
  if (event.key === "ArrowLeft") next = element.scrollLeft - step;
  else if (event.key === "ArrowRight") next = element.scrollLeft + step;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = element.scrollWidth - element.clientWidth;
  if (next === null) return;
  event.preventDefault();
  element.scrollLeft = Math.max(0, Math.min(next, element.scrollWidth - element.clientWidth));
}

function diagnosticIntersectsRange(event: DiagnosticEvent, startUs: number, endUs: number): boolean {
  return event.endUs == null
    ? event.startUs >= startUs && event.startUs < endUs
    : event.startUs < endUs && event.endUs > startUs;
}

function transportEventIntersectsRange(event: TransportEvent, startUs: number, endUs: number): boolean {
  if (event.scope.kind === "session") return true;
  if (event.scope.kind === "point") return event.scope.offsetUs >= startUs && event.scope.offsetUs < endUs;
  return event.scope.startUs < endUs && event.scope.endUs > startUs;
}

interface TimelineDiagnosticGroup {
  first: DiagnosticEvent;
  count: number;
  severity: DiagnosticEvent["severity"];
}

function groupTimelineDiagnostics(events: DiagnosticEvent[], startUs: number, endUs: number): TimelineDiagnosticGroup[] {
  const binWidthUs = Math.max(1, Math.ceil((endUs - startUs) / 15));
  const bins = new Map<number, DiagnosticEvent[]>();
  for (const event of events) {
    const bin = Math.floor((Math.max(event.startUs, startUs) - startUs) / binWidthUs);
    const grouped = bins.get(bin) ?? [];
    grouped.push(event);
    bins.set(bin, grouped);
  }
  const rank: Record<DiagnosticEvent["severity"], number> = { info: 0, warning: 1, critical: 2 };
  return [...bins.entries()].sort(([left], [right]) => left - right).flatMap(([, grouped]) => {
    const first = grouped[0];
    if (!first) return [];
    const severity = grouped.reduce<DiagnosticEvent["severity"]>((highest, event) => rank[event.severity] > rank[highest] ? event.severity : highest, first.severity);
    return [{ first, count: grouped.length, severity }];
  });
}

interface TimelineSegment {
  startUs: number;
  endUs: number;
}

interface DecoderSegment extends TimelineSegment {
  state: "locked" | "resync";
}

function familySegments(session: ParsedSession, familyName: string, startUs: number, endUs: number): TimelineSegment[] {
  const resolutionUs = Math.max(1_000_000, Math.ceil((endUs - startUs) / 600));
  const familyBuckets = session.buckets.filter((bucket) => (bucket.familyCounts[familyName] ?? 0) > 0);
  const cadenceGaps = familyBuckets.slice(1).flatMap((bucket, index) => {
    const previous = familyBuckets[index];
    return previous ? [bucket.offsetUs - previous.offsetUs] : [];
  }).sort((left, right) => left - right);
  const medianCadenceUs = cadenceGaps.length > 0 ? cadenceGaps[Math.floor(cadenceGaps.length / 2)] ?? 1_000_000 : 1_000_000;
  const continuityGapUs = Math.min(10_000_000, Math.max(2_000_000, medianCadenceUs * 2.5));
  const matching = familyBuckets.filter(
    (bucket) => bucket.offsetUs < endUs
      && bucket.offsetUs + 1_000_000 > startUs,
  );
  const occupiedBins = new Set(matching.map((bucket) => Math.floor((bucket.offsetUs - startUs) / resolutionUs)));
  const segments: TimelineSegment[] = [];
  for (const bin of [...occupiedBins].sort((left, right) => left - right)) {
    const start = Math.max(startUs, startUs + bin * resolutionUs);
    const end = Math.min(endUs, start + resolutionUs);
    const previous = segments.at(-1);
    if (previous && start - previous.endUs <= continuityGapUs) previous.endUs = Math.max(previous.endUs, end);
    else segments.push({ startUs: start, endUs: end });
  }
  return segments;
}

function decoderSegments(events: DiagnosticEvent[], startUs: number, endUs: number): DecoderSegment[] {
  const transitions = events
    .filter((event) => event.type === "decoder-resync" || event.type === "decoder-locked")
    .sort((left, right) => left.startUs - right.startUs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  let state: DecoderSegment["state"] = "locked";
  for (const event of transitions) {
    if (event.startUs >= startUs) break;
    state = event.type === "decoder-resync" ? "resync" : "locked";
  }
  const segments: DecoderSegment[] = [];
  let cursor = startUs;
  for (const event of transitions) {
    if (event.startUs < startUs || event.startUs >= endUs) continue;
    const nextState: DecoderSegment["state"] = event.type === "decoder-resync" ? "resync" : "locked";
    if (nextState === state) continue;
    if (event.startUs > cursor) segments.push({ startUs: cursor, endUs: event.startUs, state });
    cursor = event.startUs;
    state = nextState;
  }
  if (cursor < endUs) segments.push({ startUs: cursor, endUs, state });
  return segments;
}

function incidentClock(session: ParsedSession, incident: IncidentProjection): { start: string; end: string; duration: string } {
  return {
    start: formatClockOffset(session.document.startedAt, incident.startUs, session.document.displayTimeZone),
    end: formatClockOffset(session.document.startedAt, incident.endUs, session.document.displayTimeZone),
    duration: formatDurationUs(incident.endUs - incident.startUs, true),
  };
}

function formatExactSessionClock(session: ParsedSession, offsetUs: number): string {
  const absoluteUs = Date.parse(session.document.startedAt) * 1_000 + offsetUs;
  const subMillisecondUs = ((absoluteUs % 1_000) + 1_000) % 1_000;
  return `${formatClockOffset(session.document.startedAt, offsetUs, session.document.displayTimeZone)}${subMillisecondUs.toString().padStart(3, "0")}`;
}

function initialBundleItems(session: ParsedSession, incident: IncidentProjection): BundleItem[] {
  const records = rowsInRange(session.document.records, incident.startUs, incident.endUs);
  const frames = rowsInRange(session.frames, incident.startUs, incident.endUs);
  const diagnostics = incident.diagnostics;
  const transportEvents = session.transportEvents.filter((event) => transportEventIntersectsRange(event, incident.startUs, incident.endUs));
  const provenance = sessionTransportProvenance(session);
  const bridgeJournal = provenance?.transport === "udp" ? provenance.journal : null;
  const rawEstimate = records.reduce((sum, record) => sum + record.dataHex.length + 250, 0);
  const decodedEstimate = Math.max(1, frames.length) * 260;
  const integrityEstimate = JSON.stringify(session.captureIntegrity).length
    + transportEvents.reduce((sum, event) => sum + JSON.stringify(event).length, 0)
    + JSON.stringify(provenance ?? { status: "unavailable" }).length
    + JSON.stringify(bridgeJournal).length;
  return [
    { id: "rawRecords", name: "Raw source records (NDJSON)", description: "Lossless captured records in the selected range", source: "Local", estimatedBytes: rawEstimate, selected: true },
    { id: "decodedPackets", name: "Decoded packets (CSV)", description: "Fields, integrity, and source provenance", source: `${session.document.decoder.id} ${formatDecoderRevision(session.document.decoder.revision)}`, estimatedBytes: decodedEstimate, selected: true },
    { id: "schema", name: "Decoder schema", description: "Envelope, families, and timing semantics", source: `${session.document.decoder.id} ${formatDecoderRevision(session.document.decoder.revision)}`, estimatedBytes: 4_600, selected: true },
    { id: "diagnostics", name: "Diagnostics", description: "Derived decoder, link, and capture-path events in the selected range", source: "Local evidence", estimatedBytes: Math.max(1, diagnostics.length) * 620, selected: true },
    { id: "captureIntegrity", name: "Capture integrity", description: "Required events, provenance, bridge journal, and terminal receipt", source: "Required provenance", estimatedBytes: integrityEstimate, selected: true, required: true },
    { id: "notes", name: "Operator context", description: "Session-wide note plus markers inside the range", source: "Local workspace", estimatedBytes: 3_200, selected: true },
  ];
}

function StatusBars({ rssi }: { rssi: number | null }) {
  const quality = rssi == null ? "muted" : rssi < -90 ? "warn" : "good";
  return <CellSignalFull className={`status-bars ${quality}`} size={20} weight="fill" aria-label={`${quality} signal`} />;
}

function SavedSessionRows({ library, announceErrors = false }: { library: SessionLibraryController; announceErrors?: boolean }) {
  const actionBusy = library.action.kind !== "idle";
  const saving = library.action.kind === "saving";
  return (
    <div className="saved-session-list" aria-busy={library.status === "loading" || actionBusy}>
      {library.status === "loading" && <p className="library-state"><SpinnerGap className="spin" size={13} /> Loading saved sessions…</p>}
      {library.status === "ready" && library.activeIdentity === null && (
        <button className="library-save-row" type="button" disabled={actionBusy} onClick={library.onSaveCurrent}>
          {saving ? <SpinnerGap className="spin" size={15} /> : <FloppyDisk size={15} />}
          <span><strong>{saving ? "Saving current replay…" : "Save current replay"}</strong><small>Validated replay · local only</small></span>
        </button>
      )}
      {library.entries.map((entry) => {
        const active = entry.identity === library.activeIdentity;
        const opening = library.action.kind === "opening" && library.action.identity === entry.identity;
        const removing = library.action.kind === "removing" && library.action.identity === entry.identity;
        const confirming = library.pendingDeleteIdentity === entry.identity;
        return (
          <div className={`saved-session-entry${active ? " active" : ""}`} key={entry.identity}>
            <div className="saved-session-row">
              <button
                className="recent-row"
                type="button"
                disabled={actionBusy}
                aria-current={active ? "true" : undefined}
                aria-label={`${active ? "Reopen current saved session" : "Open saved session"} ${entry.title}, ${formatSessionDate(entry.startedAt, entry.displayTimeZone)}, ${formatDurationUs(entry.durationUs)}, ${savedIntegrityLabel(entry.captureIntegrityStatus)} integrity`}
                data-saved-session-focus
                data-saved-session-identity={entry.identity}
                onClick={() => library.onOpen(entry.identity)}
              >
                <span>
                  <strong>{entry.title}</strong>
                  <small>{formatSessionDate(entry.startedAt, entry.displayTimeZone)} <i>•</i> {formatDurationUs(entry.durationUs)} <i>•</i> {savedIntegrityLabel(entry.captureIntegrityStatus)}</small>
                </span>
                {opening ? <SpinnerGap className="spin" size={13} /> : <CaretRight size={13} />}
              </button>
              <button
                className="saved-session-remove"
                type="button"
                disabled={actionBusy}
                aria-label={`Remove saved session ${entry.title}`}
                title="Remove saved replay"
                onClick={(event) => {
                  const entryElement = event.currentTarget.closest(".saved-session-entry");
                  library.onRequestDelete(entry.identity);
                  requestAnimationFrame(() => entryElement?.querySelector<HTMLButtonElement>("[data-saved-session-cancel]")?.focus({ preventScroll: true }));
                }}
              ><Trash size={13} /></button>
            </div>
            {confirming && (
              <div className="saved-session-delete" role="group" aria-label={`Confirm removal of ${entry.title}`}>
                <p>Remove this saved replay and its stored markers, notes, and incident ranges? The current in-memory workspace stays open; exported files are not affected.</p>
                <div>
                  <button
                    type="button"
                    data-saved-session-cancel
                    disabled={removing}
                    onClick={(event) => {
                      const removeButton = event.currentTarget.closest(".saved-session-entry")?.querySelector<HTMLButtonElement>(".saved-session-remove");
                      library.onCancelDelete();
                      requestAnimationFrame(() => removeButton?.focus({ preventScroll: true }));
                    }}
                  >Cancel</button>
                  <button className="destructive-link" type="button" disabled={removing} onClick={() => library.onConfirmDelete(entry.identity)}>
                    {removing ? <SpinnerGap className="spin" size={12} /> : <Trash size={12} />} Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {library.status === "ready" && library.entries.length === 0 && <p className="library-state" tabIndex={-1} data-saved-session-focus>No saved sessions yet.</p>}
      {library.error && <p className="library-state error" role={announceErrors ? "alert" : undefined}>{library.error}</p>}
      {(library.status === "error" || library.status === "unavailable") && <button className="library-retry" type="button" disabled={actionBusy} onClick={library.onRetry}>Retry local library</button>}
    </div>
  );
}

interface LeftRailProps {
  session: ParsedSession;
  replayOffsetUs: number;
  onOpenReplay: () => void;
  onOpenBundle: () => void;
  onOpenCapture: () => void;
  library: SessionLibraryController;
}

function LeftRail({ session, replayOffsetUs, onOpenReplay, onOpenBundle, onOpenCapture, library }: LeftRailProps) {
  const { document } = session;
  const current = valueAtOffset(session.buckets, replayOffsetUs);
  const replaySummary = useMemo(() => {
    const invalidFrames = session.frames.filter((frame) => frame.status !== "complete").length;
    const missingFrames = session.buckets.reduce((sum, bucket) => sum + bucket.missing, 0);
    const expectedFrames = document.records.length + missingFrames;
    return { invalidFrames, missingFrames, droppedPct: expectedFrames > 0 ? (missingFrames / expectedFrames) * 100 : 0 };
  }, [document.records.length, session.buckets, session.frames]);
  const endClock = formatClockOffset(document.startedAt, document.durationUs, document.displayTimeZone, false);
  const savedState = library.activeIdentity !== null
    ? "In library"
    : library.action.kind === "saving"
      ? "Saving…"
      : library.status === "unavailable"
        ? "Unavailable"
        : "Not saved";

  return (
    <aside className="left-rail" aria-label="Session navigation">
      <div className="brand-lockup">
        <img src="/replaycase-mark.svg" alt="ReplayCase" />
        <div><strong>ReplayCase</strong><span>Local-first telemetry</span></div>
      </div>
      <div className="rail-scroll">
        <section className="rail-section sessions-heading">
          <div className="section-kicker-row"><span>Sessions</span><button className="icon-button" onClick={onOpenReplay} aria-label="Open replay"><Plus size={15} /></button></div>
          <div className="session-filter">
            <button type="button" onClick={onOpenReplay}>Open local replay <UploadSimple size={13} /></button>
            <button type="button" className="filter-button" aria-label="Replay filters unavailable" disabled><FunnelSimple size={15} /></button>
          </div>
          <button className="capture-entry" type="button" onClick={onOpenCapture}>
            <Broadcast size={16} />
            <span><strong>Live capture</strong><small>UDP or serial · local only</small></span>
          </button>
          <button className="capture-entry receiver-entry" type="button" onClick={onOpenBundle}>
            <Package size={16} />
            <span><strong>Open evidence</strong><small>Verify a received .nlb</small></span>
          </button>
        </section>
        <section className="rail-section active-links">
          <div className="section-kicker-row"><span>Loaded source</span><b>1</b></div>
          <div className="link-list">
            <div className="link-row selected" aria-current="true">
              <RadioButton size={13} weight="fill" />
              <span className="link-copy">
                <strong>{document.title}</strong>
                <small>{formatSource(session)} <i>•</i> {document.decoder.id}</small>
                <small>Recorded <i>•</i> {finiteOrDash(current?.rssiDbm ?? null, 0, " dBm")}</small>
              </span>
              <StatusBars rssi={current?.rssiDbm ?? null} />
            </div>
          </div>
        </section>
        <section className="rail-section recent-sessions saved-sessions">
          <div className="section-kicker-row"><span>Saved sessions</span><b>{library.entries.length}</b></div>
          <SavedSessionRows library={library} />
        </section>
        <section className="rail-section session-info">
          <div className="section-kicker-row"><span>Session info</span></div>
          <dl>
            <div><dt>Source</dt><dd>{formatSource(session)}</dd></div>
            <div><dt>Decoder</dt><dd>{document.decoder.id}</dd></div>
            <div><dt>Schema</dt><dd>{formatDecoderRevision(document.decoder.revision)}</dd></div>
            <div><dt>Frames</dt><dd>{document.records.length.toLocaleString()}</dd></div>
            <div><dt>Invalid</dt><dd>{replaySummary.invalidFrames}</dd></div>
            <div><dt>Missing</dt><dd>{replaySummary.missingFrames} ({replaySummary.droppedPct.toFixed(2)}%)</dd></div>
            <div><dt>Start</dt><dd>{formatClockOffset(document.startedAt, 0, document.displayTimeZone, false)}</dd></div>
            <div><dt>End</dt><dd>{endClock}</dd></div>
            <div><dt>Duration</dt><dd>{formatDurationUs(document.durationUs)}</dd></div>
            <div><dt>Integrity</dt><dd>{captureIntegrityLabel(session)}</dd></div>
            <div><dt>Saved</dt><dd className={`saved${library.activeIdentity === null ? " unsaved" : ""}`}><Circle size={7} weight="fill" /> {savedState}</dd></div>
          </dl>
        </section>
      </div>
      <button className="settings-button" type="button" onClick={onOpenReplay}><Gear size={16} /> Replace session</button>
    </aside>
  );
}

interface TopBarProps {
  onOpenCases: () => void;
  session: ParsedSession;
  replayOffsetUs: number;
  replayStatus: string;
  replayRate: number;
  onTogglePlayback: () => void;
  onReset: () => void;
  onRateChange: (rate: number) => void;
  onAddMarker: () => void;
  onCreateBundle: () => void;
  onOpenReplay: () => void;
  onOpenBundle: () => void;
  onOpenCapture: () => void;
  onOpenLibrary: () => void;
  onCompare: () => void;
  savedSessionCount: number;
  bundleDisabled: boolean;
  compareDisabled: boolean;
}

function TopBar(props: TopBarProps) {
  const { document } = props.session;
  const end = formatClockOffset(document.startedAt, document.durationUs, document.displayTimeZone, false);
  return (
    <header className="topbar">
      <div className="session-title">
        <span>Session review <i>•</i> Recorded</span>
        <div><h1 className="workspace-heading" tabIndex={-1}>{document.title}</h1><NotePencil className="decorative-icon" size={15} aria-hidden="true" /></div>
      </div>
      <div className="session-meta">
        {formatSessionDate(document.startedAt, document.displayTimeZone)} <i>•</i> {formatClockOffset(document.startedAt, 0, document.displayTimeZone, false)} – {end} {timeZoneAbbreviation(document.startedAt, document.displayTimeZone, document.durationUs)} <i>•</i> {formatDurationUs(document.durationUs)}
      </div>
      <div className="header-actions">
        <button className="secondary-action" type="button" onClick={props.onOpenCases}><FolderOpen size={15} /> Cases</button>
        <button className="secondary-action library-mobile" type="button" aria-haspopup="dialog" onClick={props.onOpenLibrary}><Database size={15} /> Saved ({props.savedSessionCount})</button>
        <button className="secondary-action capture-mobile" type="button" onClick={props.onOpenCapture}><Broadcast size={15} /> Capture</button>
        <button className="secondary-action open-replay-mobile" type="button" onClick={props.onOpenReplay}><UploadSimple size={15} /> Open replay</button>
        <button className="secondary-action open-bundle-action" type="button" onClick={props.onOpenBundle}><Package size={15} /> Open evidence</button>
        <button className="secondary-action" type="button" disabled={props.compareDisabled} onClick={props.onCompare}><ArrowsLeftRight size={16} /> Compare</button>
        <div className="replay-action-group">
          <button className={`secondary-action replay-toggle ${props.replayStatus === "playing" ? "active" : ""}`} type="button" onClick={props.onTogglePlayback}>
            {props.replayStatus === "playing" ? <Pause size={15} weight="fill" /> : <Play size={15} weight="fill" />}
            {props.replayStatus === "playing" ? "Pause replay" : props.replayStatus === "ended" ? "Replay again" : "Play replay"}
          </button>
          <label className="speed-control"><span className="visually-hidden">Replay speed</span><select value={props.replayRate} onChange={(event) => props.onRateChange(Number(event.target.value))}>{[0.5, 1, 2, 4, 8, 16].map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select></label>
        </div>
        <button className="secondary-action" type="button" onClick={props.onAddMarker}><BookmarkSimple size={16} /> Add marker</button>
        <div className="primary-action-group">
          <button className="primary-action" type="button" disabled={props.bundleDisabled} onClick={props.onCreateBundle}><DownloadSimple size={17} /> Create incident bundle</button>
          <button className="primary-split" type="button" disabled={props.bundleDisabled} onClick={props.onCreateBundle} aria-label="Review incident bundle options"><CaretDown size={14} weight="bold" /></button>
        </div>
      </div>
    </header>
  );
}

interface OverviewProps {
  session: ParsedSession;
  incidents: IncidentProjection[];
  incident: IncidentProjection | null;
  incidentEditable: boolean;
  markers: Marker[];
  replayOffsetUs: number;
  onSeek: (offsetUs: number) => void;
  onSelectIncident: (incident: IncidentProjection) => void;
  onCreateRange: () => void;
  onRangeChange: (startUs: number, endUs: number) => void;
}

const OverviewSignalChart = memo(function OverviewSignalChart({ data }: { data: ReturnType<typeof downsampleBuckets> }) {
  return (
    <div className="overview-tracks" aria-hidden="true">
      <div><ResponsiveContainer width="100%" height="100%"><LineChart accessibilityLayer={false} data={data} margin={{ top: 2, right: 1, bottom: 1, left: 1 }}><Line type="linear" dataKey="rssi" stroke="#8bc879" strokeWidth={1.15} dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer></div>
      <div><ResponsiveContainer width="100%" height="100%"><BarChart accessibilityLayer={false} data={data} margin={{ top: 1, right: 1, bottom: 0, left: 1 }}><Bar dataKey="throughput" fill="#6398d6" opacity={0.82} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
      <div><ResponsiveContainer width="100%" height="100%"><BarChart accessibilityLayer={false} data={data} margin={{ top: 0, right: 1, bottom: 1, left: 1 }}><Bar dataKey="loss" fill="#ea6f66" opacity={0.92} isAnimationActive={false} /></BarChart></ResponsiveContainer></div>
    </div>
  );
});

interface IncidentRangeHandlesProps {
  className?: string;
  session: ParsedSession;
  incident: IncidentProjection;
  domainStartUs: number;
  domainEndUs: number;
  onChange: (startUs: number, endUs: number) => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

function IncidentRangeHandles({ className = "", session, incident, domainStartUs, domainEndUs, onChange, onInteractionStart, onInteractionEnd }: IncidentRangeHandlesProps) {
  const safeDomainStartUs = Math.ceil(domainStartUs);
  const safeDomainEndUs = Math.floor(domainEndUs);
  const updateEdge = (edge: "start" | "end", value: number) => {
    const rounded = Math.round(value);
    if (edge === "start") {
      onChange(Math.max(safeDomainStartUs, Math.min(rounded, incident.endUs - 1)), incident.endUs);
    } else {
      onChange(incident.startUs, Math.min(safeDomainEndUs, Math.max(rounded, incident.startUs + 1)));
    }
  };
  const handleKeyDown = (edge: "start" | "end", event: ReactKeyboardEvent<HTMLInputElement>) => {
    const relevant = ["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"];
    if (!relevant.includes(event.key)) return;
    event.preventDefault();
    const current = edge === "start" ? incident.startUs : incident.endUs;
    let next = current;
    if (event.key === "Home") next = edge === "start" ? safeDomainStartUs : incident.startUs + 1;
    else if (event.key === "End") next = edge === "start" ? incident.endUs - 1 : safeDomainEndUs;
    else {
      const direction = event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "PageUp" ? 1 : -1;
      const stepUs = event.key.startsWith("Page") ? 10_000_000 : event.shiftKey ? 1_000_000 : 100_000;
      next += direction * stepUs;
    }
    updateEdge(edge, next);
  };
  return (
    <div className={`incident-range-handles ${className}`}>
      {(["start", "end"] as const).map((edge) => {
        const offsetUs = edge === "start" ? incident.startUs : incident.endUs;
        return <input key={edge} className={`range-handle ${edge}`} type="range" min={safeDomainStartUs} max={safeDomainEndUs} step={1} value={offsetUs} aria-label={`${edge === "start" ? "Start" : "End"} boundary for ${incident.title}`} aria-valuetext={`${formatOffsetUsInput(offsetUs)} from session start, ${formatExactSessionClock(session, offsetUs)} ${timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, offsetUs)}; ${edge === "start" ? "included" : "excluded"}`} onChange={(event) => updateEdge(edge, Number(event.target.value))} onKeyDown={(event) => handleKeyDown(edge, event)} onPointerDown={onInteractionStart} onPointerUp={onInteractionEnd} onPointerCancel={onInteractionEnd} />;
      })}
      <span className="visually-hidden">Arrow keys adjust by 0.1 seconds. Hold Shift for one second, or use Page Up and Page Down for ten seconds.</span>
    </div>
  );
}

function SessionOverview({ session, incidents, incident, incidentEditable, markers, replayOffsetUs, onSeek, onSelectIncident, onCreateRange, onRangeChange }: OverviewProps) {
  const data = useMemo(() => downsampleBuckets(session.buckets, 0, session.document.durationUs, 420), [session]);
  const durationUs = session.document.durationUs;
  const selectionLeft = incident ? percentInRange(incident.startUs, 0, durationUs) : 0;
  const selectionWidth = incident ? percentInRange(incident.endUs, 0, durationUs) - selectionLeft : 0;
  const ticks = useMemo(() => Array.from({ length: 6 }, (_, index) => (durationUs * index) / 5), [durationUs]);
  const summary = useMemo(() => {
    const measuredSignal = data.flatMap((point) => point.rssi == null ? [] : [point.rssi]);
    const totalMissing = session.buckets.reduce((sum, bucket) => sum + bucket.missing, 0);
    return measuredSignal.length > 0
      ? `Session overview. Link quality ranges from ${Math.min(...measuredSignal).toFixed(0)} to ${Math.max(...measuredSignal).toFixed(0)} dBm. ${totalMissing.toLocaleString()} frames are inferred missing. ${markers.length} operator markers are present.`
      : `Session overview. No signal measurements are present. ${totalMissing.toLocaleString()} frames are inferred missing. ${markers.length} operator markers are present.`;
  }, [data, markers.length, session.buckets]);
  return (
    <section className="overview" aria-label="Session overview" aria-describedby="session-overview-summary">
      <p id="session-overview-summary" className="visually-hidden">{summary}</p>
      <div className="overview-title"><span>Session overview</span><button className="overview-new-range" type="button" onClick={onCreateRange}><Plus size={11} weight="bold" /> New range</button></div>
      <div className="overview-body">
        <div className="overview-chart">
          <OverviewSignalChart data={data} />
          <div className="overview-marker-strip" aria-hidden="true">{markers.map((marker) => <span key={marker.id} style={{ left: `${percentInRange(marker.offsetUs, 0, durationUs)}%` }} />)}</div>
          {incident && <div className="overview-selection" style={{ left: `${selectionLeft}%`, width: `${selectionWidth}%` }} />}
          {incidents.map((candidate) => {
            const selected = candidate.id === incident?.id;
            const range = incidentClock(session, candidate);
            return <button key={candidate.id} className="overview-incident-hit" style={{ left: `${percentInRange(candidate.startUs, 0, durationUs)}%`, width: `${Math.max(1.2, percentInRange(candidate.endUs, 0, durationUs) - percentInRange(candidate.startUs, 0, durationUs))}%` }} onClick={() => onSelectIncident(candidate)} aria-pressed={selected} aria-label={`${selected ? "Selected" : "Select"} ${candidate.title}, ${candidate.severity} severity, ${range.start} to ${range.end}`} />;
          })}
          {incident && incidentEditable && <IncidentRangeHandles className="overview-range-handles" session={session} incident={incident} domainStartUs={0} domainEndUs={durationUs} onChange={onRangeChange} />}
          <div className="replay-cursor" style={{ left: `${percentInRange(replayOffsetUs, 0, durationUs)}%` }} aria-hidden="true" />
          <input className="overview-scrubber" type="range" min={0} max={durationUs} step={1_000_000} value={replayOffsetUs} onChange={(event) => onSeek(Number(event.target.value))} aria-label="Replay position" aria-valuetext={`${formatClockOffset(session.document.startedAt, replayOffsetUs, session.document.displayTimeZone)} (${formatDurationUs(replayOffsetUs, true)} elapsed)`} aria-describedby="session-overview-summary" />
          <div className="overview-times">{ticks.map((offset) => <span key={offset}>{formatClockOffset(session.document.startedAt, offset, session.document.displayTimeZone, false).slice(0, 5)}</span>)}</div>
        </div>
        <div className="overview-legend" aria-label="Overview legend"><span><i className="legend green" /> Link quality</span><span><i className="legend blue" /> Throughput</span><span><i className="legend red" /> Dropped frames</span><span><i className="legend purple" /> Markers</span></div>
      </div>
    </section>
  );
}

function PlotLane({ label, unit, value, scale, children, className = "" }: { label: string; unit?: string; value?: string; scale?: string[]; children: React.ReactNode; className?: string }) {
  return <div className={`plot-lane ${className}`} role="group" aria-label={unit ? `${label}, ${unit}` : label}><div className="lane-label"><CaretDown size={10} weight="fill" aria-hidden="true" /><span><strong>{label}</strong>{unit && <small>{unit}{scale && value && <> <i>•</i> {value}</>}</small>}</span></div><div className="lane-plot">{children}</div>{scale ? <span className="lane-scale" aria-hidden="true">{scale.map((tick) => <i key={tick}>{tick}</i>)}</span> : value && <span className={`lane-value ${value === "Out of view" ? "out-of-view" : ""}`}>{value}</span>}</div>;
}

const SignalChart = memo(function SignalChart({ data, dataKey, color, label, bar = false }: { data: ReturnType<typeof downsampleBuckets>; dataKey: "rssi" | "throughput" | "loss" | "lat" | "lon" | "alt"; color: string; label: string; bar?: boolean }) {
  const values = data.flatMap((point) => typeof point[dataKey] === "number" ? [point[dataKey]] : []);
  const summary = values.length > 0
    ? `${label} chart, ${values.length} samples, minimum ${Math.min(...values).toFixed(2)}, maximum ${Math.max(...values).toFixed(2)}.`
    : `${label} chart, no measured samples in this view.`;
  return <div className="signal-chart" role="img" aria-label={summary}>{bar ? <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 3, right: 0, bottom: 2, left: 0 }}><Bar dataKey={dataKey} fill={color} isAnimationActive={false} /></BarChart></ResponsiveContainer> : <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 5, right: 0, bottom: 5, left: 0 }}><Line type="linear" dataKey={dataKey} stroke={color} strokeWidth={1.3} dot={false} connectNulls={false} isAnimationActive={false} /></LineChart></ResponsiveContainer>}</div>;
});

interface FamilyTrackRow {
  id: string;
  label: string;
  color: string;
  segments: TimelineSegment[];
}

const PacketFamilyTrack = memo(function PacketFamilyTrack({ rows, startUs, endUs }: { rows: FamilyTrackRow[]; startUs: number; endUs: number }) {
  return <div className="family-list">{rows.map((family) => <div className="family-row" key={family.id}><span><i style={{ background: family.color }} />{family.label}</span><div className="family-segments" role="img" aria-label={`${family.label}: ${family.segments.length} cadence-presence interval${family.segments.length === 1 ? "" : "s"}`}>{family.segments.map((segment) => <b key={`${segment.startUs}-${segment.endUs}`} style={{ background: family.color, left: `${percentInRange(segment.startUs, startUs, endUs)}%`, width: `${percentInRange(segment.endUs, startUs, endUs) - percentInRange(segment.startUs, startUs, endUs)}%` }} />)}</div></div>)}</div>;
});

interface TimelineProps {
  session: ParsedSession;
  incident: IncidentProjection;
  incidentEditable: boolean;
  markers: Marker[];
  replayOffsetUs: number;
  onSeek: (offsetUs: number) => void;
  onRangeChange: (startUs: number, endUs: number) => void;
}

function MissionTimeline({ session, incident, incidentEditable, markers, replayOffsetUs, onSeek, onRangeChange }: TimelineProps) {
  const projectedView = useMemo(() => incidentViewRange(session, incident), [session, incident]);
  const [frozenResizeView, setFrozenResizeView] = useState<{ startUs: number; endUs: number } | null>(null);
  useEffect(() => { setFrozenResizeView(null); }, [incident.id]);
  const view = frozenResizeView ?? projectedView;
  const data = useMemo(() => downsampleBuckets(session.buckets, view.startUs, view.endUs, 300), [session, view.startUs, view.endUs]);
  const playheadInView = replayOffsetUs >= view.startUs && replayOffsetUs < view.endUs;
  const current = playheadInView ? valueAtOffset(session.buckets, replayOffsetUs) : null;
  const selectionLeft = percentInRange(incident.startUs, view.startUs, view.endUs);
  const selectionWidth = percentInRange(incident.endUs, view.startUs, view.endUs) - selectionLeft;
  const ticks = useMemo(() => {
    const sessionStartEpochUs = Date.parse(session.document.startedAt) * 1_000;
    const firstMinuteEpochUs = Math.ceil((sessionStartEpochUs + view.startUs) / 60_000_000) * 60_000_000;
    return Array.from({ length: 7 }, (_, index) => firstMinuteEpochUs + index * 60_000_000 - sessionStartEpochUs)
      .filter((offsetUs) => offsetUs >= view.startUs && offsetUs < view.endUs);
  }, [session.document.startedAt, view.endUs, view.startUs]);
  const visibleDiagnostics = useMemo(() => session.diagnostics.filter((event) => diagnosticIntersectsRange(event, view.startUs, view.endUs)), [session.diagnostics, view.endUs, view.startUs]);
  const diagnosticGroups = useMemo(() => groupTimelineDiagnostics(visibleDiagnostics, view.startUs, view.endUs), [visibleDiagnostics, view.endUs, view.startUs]);
  const visibleMarkers = useMemo(() => markers.filter((marker) => marker.offsetUs >= view.startUs && marker.offsetUs < view.endUs), [markers, view.endUs, view.startUs]);
  const decoderStateSegments = useMemo(() => decoderSegments(session.diagnostics, view.startUs, view.endUs), [session.diagnostics, view.endUs, view.startUs]);
  const familyRows = useMemo(() => FAMILY_ROWS.map((family) => ({ ...family, segments: familySegments(session, family.id, view.startUs, view.endUs) })), [session, view.endUs, view.startUs]);
  const throughputScaleMax = Math.max(2, Math.ceil(Math.max(...data.map((point) => point.throughput), 0) / 2) * 2);
  const lossScaleMax = Math.max(5, Math.ceil(Math.max(...data.map((point) => point.loss), 0) / 5) * 5);
  const clock = incidentClock(session, incident);
  const replayLeft = percentInRange(replayOffsetUs, view.startUs, view.endUs);
  const viewZoneStart = timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, view.startUs);
  const viewZoneEnd = timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, view.endUs);
  const viewZoneLabel = viewZoneStart === viewZoneEnd ? viewZoneStart : session.document.displayTimeZone;

  return (
    <section className="timeline-panel keyboard-scroll-region" tabIndex={0} aria-label="Mission telemetry timeline" aria-describedby="timeline-keyboard-scroll-instructions" onKeyDown={handleHorizontalScrollKey}>
      <p id="timeline-keyboard-scroll-instructions" className="visually-hidden">This timeline scrolls horizontally in narrow layouts. When this region is focused, use the Left and Right Arrow keys to pan or Home and End to move to either edge.</p>
      <div className="time-ruler"><span className="time-zone" aria-label={`Time zone ${session.document.displayTimeZone}`}><small>Time ({viewZoneLabel})</small><strong>{formatClockOffset(session.document.startedAt, replayOffsetUs, session.document.displayTimeZone, false).slice(0, 5)}</strong></span><div className="time-buttons">{ticks.map((offset) => { const active = replayOffsetUs >= offset && replayOffsetUs < offset + 60_000_000; return <button key={offset} type="button" style={{ left: `${percentInRange(offset, view.startUs, view.endUs)}%` }} className={active ? "active" : ""} aria-current={active ? "time" : undefined} onClick={() => onSeek(offset)}>{formatClockOffset(session.document.startedAt, offset, session.document.displayTimeZone, false).slice(0, 5)}</button>; })}</div></div>
      <div className="timeline-stack">
        <div className="shared-grid" aria-hidden="true" />
        <div className="selection-band" style={{ left: `calc(var(--label-gutter) + (100% - var(--label-gutter) - var(--scale-gutter)) * ${selectionLeft / 100})`, width: `calc((100% - var(--label-gutter) - var(--scale-gutter)) * ${selectionWidth / 100})` }}><button className="selection-chip" type="button" onClick={() => onSeek(incident.startUs)}><BookmarkSimple size={12} weight="fill" /> {clock.start} <span>–</span> {clock.end} <small>({clock.duration})</small></button></div>
        {incidentEditable && <IncidentRangeHandles className="timeline-range-handles" session={session} incident={incident} domainStartUs={view.startUs} domainEndUs={view.endUs} onChange={onRangeChange} onInteractionStart={() => setFrozenResizeView(view)} onInteractionEnd={() => setFrozenResizeView(null)} />}
        {replayOffsetUs >= view.startUs && replayOffsetUs <= view.endUs && <div className="timeline-cursor" style={{ left: `calc(var(--label-gutter) + (100% - var(--label-gutter) - var(--scale-gutter)) * ${replayLeft / 100})` }} aria-hidden="true" />}
        <PlotLane label="Connection" unit="RSSI (dBm)" value={playheadInView ? finiteOrDash(current?.rssiDbm ?? null, 0) : "Out of view"} scale={["−40", "−80", "−120"]}><SignalChart data={data} dataKey="rssi" color="#8bc879" label="Connection RSSI" /></PlotLane>
        <PlotLane label="Throughput" unit="pkt/s (1s avg)" value={playheadInView ? finiteOrDash(current?.throughput ?? null, 0) : "Out of view"} scale={[String(throughputScaleMax), String(throughputScaleMax / 2), "0"]}><SignalChart data={data} dataKey="throughput" color="#6398d6" label="Packet throughput" bar /></PlotLane>
        <PlotLane label="Packet loss" unit="drop % (1s avg)" value={playheadInView ? finiteOrDash(current?.lossPct ?? null, 2, "%") : "Out of view"} scale={[`${lossScaleMax}%`, `${lossScaleMax / 2}%`, "0%"]}><SignalChart data={data} dataKey="loss" color="#ea6f66" label="Packet loss" bar /></PlotLane>
        <PlotLane label="Packet families" className="families-lane"><PacketFamilyTrack rows={familyRows} startUs={view.startUs} endUs={view.endUs} /></PlotLane>
        <PlotLane label="Decoder" unit={session.document.decoder.id} className="event-lane"><div className="decoder-track">{decoderStateSegments.map((segment) => { const left = percentInRange(segment.startUs, view.startUs, view.endUs); const width = percentInRange(segment.endUs, view.startUs, view.endUs) - left; const label = segment.state === "locked" ? `Locked ${formatDecoderRevision(session.document.decoder.revision)}` : "Resync search"; return <span key={`${segment.state}-${segment.startUs}`} className={`decoder-segment ${segment.state}`} style={{ left: `${left}%`, width: `${width}%` }} aria-label={`${label} from ${formatClockOffset(session.document.startedAt, segment.startUs, session.document.displayTimeZone)} to ${formatClockOffset(session.document.startedAt, segment.endUs, session.document.displayTimeZone)}`} title={label}>{width >= 9 ? label : <span className="visually-hidden">{label}</span>}{segment.state === "resync" && width >= 16 && <small>invalid frames retained</small>}</span>; })}</div></PlotLane>
        <PlotLane label="Diagnostics" className="event-lane diagnostics-lane"><div className="event-track diagnostics-track">{diagnosticGroups.map((group) => { const anchorUs = Math.max(view.startUs, group.first.startUs); return <button className={`severity-${group.severity}`} key={group.first.id} type="button" style={{ left: `${percentInRange(anchorUs, view.startUs, view.endUs)}%` }} onClick={() => onSeek(anchorUs)} aria-label={`${group.count} ${group.severity} diagnostic${group.count === 1 ? "" : "s"}; ${failureDomainLabel(group.first.domain)} domain; first: ${group.first.title}, ${formatClockOffset(session.document.startedAt, group.first.startUs, session.document.displayTimeZone)}${group.first.startUs < view.startUs ? "; began before this view" : ""}`}><span className="timeline-diagnostic-severity" aria-hidden="true">{group.severity === "critical" ? "C" : group.severity === "warning" ? "W" : "I"}</span><span className="timeline-diagnostic-copy">{shortDiagnosticTitle(group.first)}{group.count > 1 && ` +${group.count - 1}`}</span><small>{formatClockOffset(session.document.startedAt, group.first.startUs, session.document.displayTimeZone, false)}</small></button>; })}</div></PlotLane>
        <PlotLane label="Markers" className="event-lane"><div className="event-track marker-track">{visibleMarkers.map((marker) => <button key={marker.id} type="button" style={{ left: `${percentInRange(marker.offsetUs, view.startUs, view.endUs)}%` }} onClick={() => onSeek(marker.offsetUs)}><BookmarkSimple size={12} weight="fill" /> {marker.title}<small>{formatClockOffset(session.document.startedAt, marker.offsetUs, session.document.displayTimeZone)}</small></button>)}</div></PlotLane>
        <PlotLane label="Latitude" unit="deg" value={playheadInView ? finiteOrDash(current?.latitude ?? null, 4) : "Out of view"}><SignalChart data={data} dataKey="lat" color="#8bc879" label="Latitude" /></PlotLane>
        <PlotLane label="Longitude" unit="deg" value={playheadInView ? finiteOrDash(current?.longitude ?? null, 4) : "Out of view"}><SignalChart data={data} dataKey="lon" color="#8bc879" label="Longitude" /></PlotLane>
        <PlotLane label="Altitude" unit="m" value={playheadInView ? finiteOrDash(current?.altitudeM ?? null, 0) : "Out of view"}><SignalChart data={data} dataKey="alt" color="#8bc879" label="Altitude" /></PlotLane>
      </div>
    </section>
  );
}

function diagnosticTone(event: DiagnosticEvent): "amber" | "red" | "green" {
  if (event.type === "recovery" || event.type === "decoder-locked") return "green";
  return event.severity === "critical" ? "red" : "amber";
}

const NARRATIVE_SUMMARY_TYPES: DiagnosticEvent["type"][] = [
  "capture-path-event",
  "link-degraded",
  "crc-failure",
  "checksum-failure",
  "decoder-resync",
  "loss-burst",
  "recovery",
  "decoder-locked",
];

function summarizeNarrative(events: DiagnosticEvent[]): DiagnosticEvent[] {
  const selected = NARRATIVE_SUMMARY_TYPES.flatMap((type) => {
    const event = events.find((candidate) => candidate.type === type);
    return event ? [event] : [];
  });
  for (const event of events) {
    if (selected.length >= 6) break;
    if (!selected.some((candidate) => candidate.id === event.id)) selected.push(event);
  }
  return selected.sort((left, right) => left.startUs - right.startUs);
}

function TransportProvenancePanel({ session, incident }: { session: ParsedSession; incident: IncidentProjection }) {
  const provenance = sessionTransportProvenance(session);
  if (!provenance) {
    const reason = session.document.formatVersion === 1
      ? "This unchanged version 1 replay predates durable capture receipts and transport provenance."
      : "This valid version 2 replay predates structured transport provenance.";
    return (
      <div className="provenance-view provenance-unavailable" id="incident-panel-provenance" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-provenance">
        <div className="provenance-title"><h2>Transport provenance</h2><span className="provenance-status unavailable">Unavailable</span></div>
        <p>{reason} ReplayCase leaves the evidence unavailable instead of reconstructing it from recorder totals.</p>
      </div>
    );
  }

  const issues = provenance.issueCodes;
  if (provenance.transport === "serial") {
    return (
      <div className="provenance-view" id="incident-panel-provenance" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-provenance">
        <div className="provenance-title"><h2>Serial provenance</h2><span className={`provenance-status ${provenance.status}`}>{provenance.status}</span></div>
        <dl className="provenance-facts">
          <div><dt>Source identity</dt><dd>{provenance.sourceId}</dd></div>
          <div><dt>USB vendor</dt><dd>{formatUsbIdentifier(provenance.device.usbVendorId)}</dd></div>
          <div><dt>USB product</dt><dd>{formatUsbIdentifier(provenance.device.usbProductId)}</dd></div>
          <div><dt>Bluetooth service</dt><dd>{provenance.device.bluetoothServiceClassId ?? "Unavailable"}</dd></div>
          <div><dt>Negotiated line</dt><dd>{provenance.settings.baudRate.toLocaleString("en-US")} baud · {provenance.settings.dataBits}{provenance.settings.parity[0]?.toUpperCase() ?? "N"}{provenance.settings.stopBits}</dd></div>
          <div><dt>Flow / buffer</dt><dd>{provenance.settings.flowControl} · {formatBytes(provenance.settings.bufferSize)}</dd></div>
        </dl>
        <section className="provenance-section" aria-label="Serial provenance boundaries"><h3>Evidence boundaries</h3>{issues.length > 0 ? <ul className="provenance-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>No provenance reconciliation issues.</p>}</section>
      </div>
    );
  }

  const rangeEndpoints = new Map<string, { endpoint: UdpRemoteEndpoint; records: number; bytes: number }>();
  for (const record of rowsInRange(session.document.records, incident.startUs, incident.endUs)) {
    const endpoint = record.transport.remoteEndpoint;
    if (!endpoint) continue;
    const key = `${endpoint.family}\u0000${endpoint.address}\u0000${endpoint.port}`;
    const existing = rangeEndpoints.get(key);
    if (existing) {
      existing.records += 1;
      existing.bytes += record.captureBytes;
    } else {
      rangeEndpoints.set(key, { endpoint, records: 1, bytes: record.captureBytes });
    }
  }
  const journal = provenance.journal;
  const rangeJournalEntries = journal?.entries.filter((entry) => entry.offsetUs >= incident.startUs && entry.offsetUs < incident.endUs) ?? [];
  const kernelDrops = !journal
    ? "Unavailable"
    : journal.kernelDroppedDatagrams !== null
      ? `${journal.kernelDroppedDatagrams.toLocaleString()} datagram${journal.kernelDroppedDatagrams === 1 ? "" : "s"} · Linux socket counter`
      : journal.kernelDroppedDatagramsSource === "unavailable"
        ? "Unavailable · bridge API"
        : `Unavailable · ${journal.kernelDroppedDatagramsSource.replace(/^unavailable-/, "").replaceAll("-", " ")}`;
  const byteAccounting = provenance.schemaVersion === 2 ? provenance.byteAccounting : null;

  return (
    <div className="provenance-view" id="incident-panel-provenance" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-provenance">
      <div className="provenance-title"><h2>UDP provenance</h2><span className={`provenance-status ${provenance.status}`}>{provenance.status}</span></div>
      <dl className="provenance-facts">
        <div><dt>Capture identity</dt><dd>{journal?.captureId ?? "Unavailable"}</dd></div>
        <div><dt>Bound socket</dt><dd>{journal ? formatUdpAddressPort(journal.bind.host, journal.bind.port, journal.bind.family) : "Unavailable"}</dd></div>
        <div><dt>Multicast</dt><dd>{journal?.multicast ? `${journal.multicast.group}${journal.multicast.interface ? ` · ${journal.multicast.interface}` : ""}` : "None"}</dd></div>
        <div><dt>Endpoint attribution</dt><dd>{provenance.endpointAttribution.attributedRecords.toLocaleString()} / {provenance.endpointAttribution.totalRecords.toLocaleString()} records · {provenance.endpointAttribution.distinctEndpoints.length.toLocaleString()} endpoint{provenance.endpointAttribution.distinctEndpoints.length === 1 ? "" : "s"}</dd></div>
        <div><dt>Bridge totals</dt><dd>{journal ? `${journal.datagrams.toLocaleString()} datagrams · ${formatBytes(journal.bytes)}` : "Unavailable"}</dd></div>
        <div><dt>Kernel drops</dt><dd>{kernelDrops}</dd></div>
        <div><dt>UDP estimate</dt><dd>{byteAccounting ? `${formatBytes(byteAccounting.udp.bytes)} · payload + 8 B/datagram` : "Unavailable"}</dd></div>
        <div><dt>IP minimum</dt><dd>{byteAccounting ? `${formatBytes(byteAccounting.ip.bytes)} · ${byteAccounting.ip.family}, no options or fragments` : "Unavailable"}</dd></div>
        <div><dt>Link / radio bytes</dt><dd>{byteAccounting ? "Unavailable · not observed at UDP socket" : "Unavailable"}</dd></div>
        <div><dt>Journal</dt><dd>{journal ? `${journal.state} · ${journal.entries.length.toLocaleString()} entries${journal.omittedEntries > 0 ? ` · ${journal.omittedEntries.toLocaleString()} omitted` : ""}` : "Unavailable"}</dd></div>
      </dl>
      <section className="provenance-section" aria-label="Remote endpoints in selected incident"><h3>Endpoints in range</h3>{rangeEndpoints.size > 0 ? <ol className="endpoint-list">{[...rangeEndpoints.values()].map(({ endpoint, records, bytes }) => <li key={`${endpoint.family}-${endpoint.address}-${endpoint.port}`}><code>{formatUdpEndpoint(endpoint)}</code><span>{endpoint.family} · {records.toLocaleString()} record{records === 1 ? "" : "s"} · {formatBytes(bytes)}</span></li>)}</ol> : <p>No attributed UDP records intersect this half-open range.</p>}</section>
      <section className="provenance-section" aria-label="Bridge journal entries in selected incident"><h3>Journal in range</h3>{rangeJournalEntries.length > 0 ? <ol className="journal-list">{rangeJournalEntries.map((entry) => <li key={entry.sequence}><time>{formatClockOffset(session.document.startedAt, entry.offsetUs, session.document.displayTimeZone, false)}</time><div><strong>{entry.type}</strong><span>{entry.datagrams.toLocaleString()} datagrams · {formatBytes(entry.bytes)}</span>{entry.message && <small>{entry.message}</small>}</div></li>)}</ol> : <p>No bridge lifecycle entry intersects this range. Whole-session state: {journal?.state ?? "unavailable"}.</p>}</section>
      <section className="provenance-section" aria-label="UDP provenance boundaries"><h3>Evidence boundaries</h3>{issues.length > 0 ? <ul className="provenance-issues">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul> : <p>No provenance reconciliation issues.</p>}</section>
    </div>
  );
}

interface IncidentPanelProps {
  session: ParsedSession;
  incidents: IncidentProjection[];
  incident: IncidentProjection | null;
  incidentEditable: boolean;
  activeTab: ActiveTab;
  note: string;
  workspacePersistence: WorkspacePersistenceState;
  onTabChange: (tab: ActiveTab) => void;
  onNoteChange: (note: string) => void;
  onSelectIncident: (id: string, focusPanel?: boolean) => void;
  onEditRange: () => void;
  onClear: () => void;
}

function IncidentPanel(props: IncidentPanelProps) {
  const { incident, session } = props;
  const [narrativeLimit, setNarrativeLimit] = useState(6);
  useEffect(() => { setNarrativeLimit(6); }, [incident?.id]);
  if (!incident) {
    const firstIncident = props.incidents[0];
    return <aside className="incident-panel empty-incident" aria-label="Incident details"><div className="incident-heading"><div><BookmarkSimple size={14} /><span>Incident selection</span></div></div><div className="empty-state"><ClockCounterClockwise size={24} /><h2 data-incident-empty-focus tabIndex={-1}>{firstIncident ? "No incident selected" : "No incident ranges"}</h2><p>{firstIncident ? "Choose an incident from the session overview to inspect decoded evidence and prepare a handoff bundle." : "This replay does not declare any incident presets. Playback, decoded values, markers, and the session overview remain available."}</p>{firstIncident && <button className="secondary-action" type="button" onClick={() => props.onSelectIncident(firstIncident.id, true)}>Select first incident</button>}</div></aside>;
  }
  const clock = incidentClock(session, incident);
  const stats = incident.stats;
  const narrative = incident.diagnostics;
  const domainOrder: DiagnosticEvent["domain"][] = ["capture-path", "link", "decoder", "unknown"];
  const evidenceDomains = domainOrder.filter((domain) => narrative.some((event) => event.domain === domain));
  const evidenceDomainSummary = evidenceDomains.length > 0
    ? evidenceDomains.map(failureDomainLabel).join(", ")
    : "No attributed events";
  const narrativeSummary = summarizeNarrative(narrative);
  const showingAllNarrative = narrativeLimit > 6;
  const displayedNarrative = showingAllNarrative ? narrative : narrativeSummary;
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = INCIDENT_TABS.indexOf(props.activeTab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? INCIDENT_TABS.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + INCIDENT_TABS.length) % INCIDENT_TABS.length;
    const nextTab = INCIDENT_TABS[nextIndex];
    if (!nextTab) return;
    props.onTabChange(nextTab);
    requestAnimationFrame(() => document.getElementById(`incident-tab-${nextTab}`)?.focus());
  };
  return (
    <aside className="incident-panel" aria-label="Incident details">
      <div className="incident-heading"><div><BookmarkSimple size={14} weight="fill" /><span>Incident selection</span></div><div className="incident-heading-actions"><button className="icon-button" type="button" aria-label={props.incidentEditable ? "Edit operator range" : "Refine replay preset as a local range"} title={props.incidentEditable ? "Edit operator range" : "Refine as local range"} onClick={props.onEditRange}><NotePencil size={15} /></button><button className="icon-button" type="button" aria-label="Clear incident" onClick={props.onClear}><X size={15} /></button></div></div>
      <div className="incident-range"><select className="incident-switcher" data-incident-selected-focus value={incident.id} onChange={(event) => props.onSelectIncident(event.target.value)} aria-label="Selected incident">{props.incidents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><strong>{clock.start} – {clock.end}</strong><span>{props.incidentEditable ? "Local range" : "Replay preset"} · {clock.duration}</span></div>
      <div className="incident-tabs" role="tablist" aria-label="Incident information" onKeyDown={handleTabKeyDown}>{INCIDENT_TABS.map((tab) => <button id={`incident-tab-${tab}`} aria-controls={`incident-panel-${tab}`} aria-selected={props.activeTab === tab} role="tab" tabIndex={props.activeTab === tab ? 0 : -1} type="button" key={tab} className={props.activeTab === tab ? "active" : ""} onClick={() => props.onTabChange(tab)}>{tab}</button>)}</div>
      {props.activeTab === "narrative" && <div className="narrative-view" id="incident-panel-narrative" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-narrative"><h2>{incident.title}</h2>{narrative.length > 0 ? <><p className="visually-hidden">{narrative.length} evidence-backed event{narrative.length === 1 ? "" : "s"} in the selected half-open range.</p><ol className="event-narrative">{displayedNarrative.map((event) => <li key={event.id} className={diagnosticTone(event)}><time>{formatClockOffset(session.document.startedAt, event.startUs, session.document.displayTimeZone, false)}</time><div><strong><span className={`diagnostic-severity severity-${event.severity}`}>{event.severity}</span>{event.title}<small> · {failureDomainLabel(event.domain)}</small></strong><p>{event.description}</p></div></li>)}</ol>{narrativeSummary.length < narrative.length && <button className="narrative-more" type="button" onClick={() => setNarrativeLimit(showingAllNarrative ? 6 : narrative.length)}>{showingAllNarrative ? "Show six key events" : `Show all ${narrative.length} events`} <small>{displayedNarrative.length} of {narrative.length} shown</small></button>}</> : <div className="incident-evidence-empty"><p>No derived diagnostic events intersect this operator-defined range.</p><small>The range remains available for replay, marker review, and exact-range export.</small></div>}</div>}
      {props.activeTab === "details" && <dl className="details-view" id="incident-panel-details" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-details"><div><dt>Source</dt><dd>{formatSource(session)}</dd></div><div><dt>Capture integrity</dt><dd>{captureIntegrityLabel(session)}</dd></div><div><dt>Evidence domains</dt><dd>{evidenceDomainSummary}</dd></div><div><dt>Decoder</dt><dd>{session.document.decoder.id} {formatDecoderRevision(session.document.decoder.revision)}</dd></div><div><dt>Frames in range</dt><dd>{stats.receivedFrames.toLocaleString()}</dd></div><div><dt>Missing</dt><dd className="danger">{stats.missingFrames}</dd></div><div><dt>Loss</dt><dd className="danger">{finiteOrDash(stats.lossPct, 2, "%")}</dd></div><div><dt>Lowest RSSI</dt><dd>{finiteOrDash(stats.lowestRssiDbm, 1, " dBm")}</dd></div><div><dt>Peak jitter</dt><dd>{finiteOrDash(stats.peakJitterMs, 1, " ms")}</dd></div><div><dt>Complete packets</dt><dd>{stats.completePackets.toLocaleString()}</dd></div></dl>}
      {props.activeTab === "provenance" && <TransportProvenancePanel session={session} incident={incident} />}
      {props.activeTab === "stats" && <div className="stats-view" id="incident-panel-stats" role="tabpanel" tabIndex={0} aria-labelledby="incident-tab-stats"><StatBar label="Link availability" value={stats.linkAvailabilityPct} /><StatBar label="Decode confidence" value={stats.decodeConfidencePct} /><StatBar label="Delivery" value={stats.lossPct == null ? null : 100 - stats.lossPct} /></div>}
      <div className="operator-notes"><div><span>Session-wide operator note</span><NotePencil size={14} aria-hidden="true" /></div><textarea maxLength={2000} value={props.note} onChange={(event) => props.onNoteChange(event.target.value)} aria-label="Session-wide operator note" /><small className={props.workspacePersistence === "stored" ? "" : "storage-warning"}>{props.workspacePersistence === "stored" ? "Stored in this browser only; included with any range when selected for export" : props.workspacePersistence === "memory-only" ? "Removed from browser storage; save this replay again to persist the visible workspace" : "Browser storage is unavailable; edits remain in memory until this page closes"}</small></div>
    </aside>
  );
}

function StatBar({ label, value }: { label: string; value: number | null }) {
  const bounded = Math.max(0, Math.min(100, value ?? 0));
  return <div><span>{label}</span><strong>{finiteOrDash(value, 1, "%")}</strong><i><b style={{ width: `${bounded}%` }} /></i></div>;
}

interface BundlePanelProps {
  session: ParsedSession;
  incident: IncidentProjection | null;
  items: BundleItem[];
  note: string;
  workspacePersistence: WorkspacePersistenceState;
  onItemsChange: (items: BundleItem[]) => void;
  onNoteChange: (note: string) => void;
  onCreateBundle: () => void;
}

function BundlePanel(props: BundlePanelProps) {
  const selected = props.incident ? props.items.filter((item) => item.required || item.selected) : [];
  const estimatedBytes = selected.reduce((sum, item) => sum + item.estimatedBytes, 0);
  const clock = props.incident ? incidentClock(props.session, props.incident) : null;
  const toggle = (id: BundleItemId) => props.onItemsChange(props.items.map((item) => item.id === id && !item.required ? { ...item, selected: !item.selected } : item));
  return (
    <section className="bundle-panel" aria-label="Incident bundle preview">
      <div className="bundle-summary"><div><span>Incident bundle preview</span><p>A local, verifiable archive for reproducing and investigating the selected incident.</p></div><dl><div><dt>Time range</dt><dd>{clock ? <>{clock.start} – {clock.end}<small>{clock.duration}</small></> : <span className="no-selection-copy">No incident selected</span>}</dd></div><div><dt>Size (est.)</dt><dd>{formatBytes(estimatedBytes)}</dd></div><div><dt>Groups</dt><dd>{selected.length}</dd></div></dl><button className="primary-action bundle-create" type="button" disabled={!props.incident || selected.length === 0} onClick={props.onCreateBundle}><DownloadSimple size={17} /> Create incident bundle</button></div>
      <div className="bundle-body"><p id="bundle-table-keyboard-scroll-instructions" className="visually-hidden">This evidence table scrolls horizontally in narrow layouts. When the table region is focused, use the Left and Right Arrow keys to reveal columns or Home and End to move to either edge.</p><div className="bundle-table-wrap keyboard-scroll-region" role="region" tabIndex={0} aria-label="Scrollable evidence bundle contents" aria-describedby="bundle-table-keyboard-scroll-instructions" onKeyDown={handleHorizontalScrollKey}><div role="table" aria-label="Evidence bundle contents"><div className="bundle-table-head" role="row"><span role="columnheader">Include</span><span role="columnheader">Item</span><span role="columnheader">Description</span><span role="columnheader">Source</span><span role="columnheader">Size (est.)</span></div><div className="bundle-table" role="rowgroup">{props.items.map((item) => <label className={!item.selected && !item.required ? "excluded" : ""} key={item.id} role="row"><span className="checkbox" role="cell"><input type="checkbox" checked={item.required || item.selected} disabled={!props.incident || item.required} title={item.required ? "Required in every verifiable archive" : undefined} onChange={() => toggle(item.id)} /></span><strong role="cell">{item.name}</strong><span role="cell">{item.description}</span><span role="cell">{item.source}</span><span role="cell">{formatBytes(item.estimatedBytes)}</span></label>)}</div></div></div><label className="bundle-notes"><span>Session-wide note for bundle</span><small className={props.workspacePersistence === "stored" ? "" : "storage-warning"}>{props.workspacePersistence === "stored" ? "This note applies to the session and is included with the selected range." : props.workspacePersistence === "memory-only" ? "This visible note is memory-only until the replay is saved again; it can still be included now." : "Browser storage is unavailable; this note remains in memory and can still be included now."}</small><textarea disabled={!props.incident} value={props.note} maxLength={2000} onChange={(event) => props.onNoteChange(event.target.value)} /><b>{props.note.length} / 2000</b></label></div>
    </section>
  );
}

interface MarkerDialogProps {
  session: ParsedSession;
  initialOffsetUs: number;
  onClose: () => void;
  onCreate: (marker: Marker) => void;
}

const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function useModalFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void, canClose = true): void {
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appRoot = document.getElementById("root");
    const previousAriaHidden = appRoot?.getAttribute("aria-hidden") ?? null;
    const previousInert = appRoot?.inert ?? false;
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute("aria-hidden", "true");
    }

    const focusFrame = requestAnimationFrame(() => {
      const initial = dialog.querySelector<HTMLElement>("[data-dialog-focus]")
        ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?? dialog;
      initial.focus({ preventScroll: true });
    });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", keydown, true);
      if (appRoot) {
        appRoot.inert = previousInert;
        if (previousAriaHidden == null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      opener?.focus({ preventScroll: true });
    };
  }, [dialogRef]);
}

function SessionLibraryDialog({ library, onClose }: { library: SessionLibraryController; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const storedBytes = library.entries.reduce((total, entry) => total + entry.byteLength, 0);
  useModalFocus(dialogRef, onClose, library.action.kind === "idle");
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && library.action.kind === "idle" && onClose()}>
      <section ref={dialogRef} className="bundle-dialog session-library-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="session-library-dialog-title" aria-describedby="session-library-dialog-description">
        <button className="dialog-close" type="button" aria-label="Close saved sessions" onClick={onClose} disabled={library.action.kind !== "idle"}><X size={17} /></button>
        <div className="dialog-icon"><Database size={24} /></div>
        <span className="dialog-kicker">Local session library</span>
        <h2 id="session-library-dialog-title" data-dialog-focus tabIndex={-1}>Saved sessions</h2>
        <p id="session-library-dialog-description">Reopen validated local captures without uploading telemetry or changing their immutable source records.</p>
        <dl className="dialog-summary">
          <div><dt>Sessions</dt><dd>{library.entries.length}</dd></div>
          <div><dt>Stored bytes</dt><dd>{formatBytes(storedBytes)}</dd></div>
          <div><dt>Location</dt><dd>Browser IndexedDB</dd></div>
        </dl>
        <div className="session-library-dialog-list" tabIndex={-1}><SavedSessionRows library={library} announceErrors /></div>
        <div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose} disabled={library.action.kind !== "idle"}>Close</button></div>
      </section>
    </div>,
    document.body,
  );
}

function MarkerDialog({ session, initialOffsetUs, onClose, onCreate }: MarkerDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const offsetRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const safeInitialOffsetUs = Math.floor(Math.min(initialOffsetUs, session.document.durationUs - 1) / 1000) * 1000;
  const [offsetSeconds, setOffsetSeconds] = useState((safeInitialOffsetUs / 1_000_000).toFixed(3));
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<Marker["category"]>("observation");
  const [error, setError] = useState<{ field: "offset" | "title"; message: string } | null>(null);
  useModalFocus(dialogRef, onClose);
  const seconds = offsetSeconds.trim() === "" ? Number.NaN : Number(offsetSeconds);
  const offsetUs = Number.isFinite(seconds) ? Math.round(seconds * 1_000_000) : null;
  const offsetIsValid = offsetUs != null && offsetUs >= 0 && offsetUs < session.document.durationUs;
  const displayedTimestamp = offsetIsValid
    ? formatClockOffset(session.document.startedAt, offsetUs, session.document.displayTimeZone)
    : "Outside this replay";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!offsetIsValid || offsetUs == null) {
      setError({ field: "offset", message: `Enter an offset from 0 up to ${formatDurationUs(session.document.durationUs - 1, true)}.` });
      requestAnimationFrame(() => offsetRef.current?.focus());
      return;
    }
    if (!title.trim()) {
      setError({ field: "title", message: "Give the marker a short title." });
      requestAnimationFrame(() => titleRef.current?.focus());
      return;
    }
    onCreate({ id: globalThis.crypto?.randomUUID?.() ?? `marker-${Date.now()}`, offsetUs, title: title.trim(), note: note.trim(), category, createdAt: new Date().toISOString() });
  };
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><form ref={dialogRef} className="bundle-dialog marker-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="marker-dialog-title" onSubmit={submit}><button className="dialog-close" type="button" aria-label="Close marker dialog" onClick={onClose}><X size={17} /></button><div className="dialog-icon"><BookmarkSimple size={24} /></div><span className="dialog-kicker">Session marker</span><h2 id="marker-dialog-title">Add an operator marker</h2><p>Anchor field context to the same microsecond replay timeline used by diagnostics and export.</p><div className="dialog-fields"><label><span>Offset from session start (seconds)</span><input ref={offsetRef} data-dialog-focus type="number" min={0} max={(session.document.durationUs - 1) / 1_000_000} step="0.001" inputMode="decimal" value={offsetSeconds} aria-invalid={error?.field === "offset"} aria-describedby={`marker-offset-help${error?.field === "offset" ? " marker-dialog-error" : ""}`} onChange={(event) => { setOffsetSeconds(event.target.value); if (error?.field === "offset") setError(null); }} /><small id="marker-offset-help" className="field-help">Session clock: <output>{displayedTimestamp}</output> {timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, offsetUs ?? 0)}</small></label><label><span>Title</span><input ref={titleRef} value={title} maxLength={80} aria-invalid={error?.field === "title"} aria-describedby={error?.field === "title" ? "marker-dialog-error" : undefined} onChange={(event) => { setTitle(event.target.value); if (error?.field === "title") setError(null); }} placeholder="What happened?" /></label><label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value as Marker["category"])}><option value="observation">Observation</option><option value="field-note">Field note</option><option value="maintenance">Maintenance</option></select></label><label><span>Note</span><textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label></div>{error && <p id="marker-dialog-error" className="dialog-error" role="alert">{error.message}</p>}<div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit"><BookmarkSimple size={16} /> Add marker</button></div></form></div>, document.body);
}

interface IncidentRangeDialogProps {
  session: ParsedSession;
  mode: "create" | "edit";
  range: AuthoredIncidentRange;
  onClose: () => void;
  onSave: (range: AuthoredIncidentRange) => void;
  onDelete?: () => void;
}

function IncidentRangeDialog({ session, mode, range, onClose, onSave, onDelete }: IncidentRangeDialogProps) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteKeepRef = useRef<HTMLButtonElement>(null);
  const [title, setTitle] = useState(range.title);
  const [startValue, setStartValue] = useState(() => formatOffsetUsInput(range.startUs));
  const [endValue, setEndValue] = useState(() => formatOffsetUsInput(range.endUs));
  const [severity, setSeverity] = useState<AuthoredIncidentRange["severity"]>(range.severity);
  const [error, setError] = useState<{ field: "title" | "start" | "end" | "range"; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useModalFocus(dialogRef, onClose);
  const startUs = parseOffsetUsInput(startValue);
  const endUs = parseOffsetUsInput(endValue);
  const validDuration = startUs != null && endUs != null && endUs > startUs && endUs <= session.document.durationUs
    ? endUs - startUs
    : null;
  const zone = timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, startUs ?? 0);
  const clearFieldError = (field: "title" | "start" | "end") => {
    if (error?.field === field || error?.field === "range") setError(null);
  };
  const requestDelete = () => {
    setConfirmDelete(true);
    requestAnimationFrame(() => deleteKeepRef.current?.focus({ preventScroll: true }));
  };
  const cancelDelete = () => {
    setConfirmDelete(false);
    requestAnimationFrame(() => deleteTriggerRef.current?.focus({ preventScroll: true }));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setError({ field: "title", message: "Give the incident range a short title." });
      requestAnimationFrame(() => titleRef.current?.focus());
      return;
    }
    if (startUs == null) {
      setError({ field: "start", message: "Enter the start as HH:MM:SS.ffffff from session start." });
      requestAnimationFrame(() => startRef.current?.focus());
      return;
    }
    if (endUs == null) {
      setError({ field: "end", message: "Enter the end as HH:MM:SS.ffffff from session start." });
      requestAnimationFrame(() => endRef.current?.focus());
      return;
    }
    try {
      const validated = validateIncidentPreset({ id: range.id, title: title.trim(), startUs, endUs, severity }, session.document.durationUs);
      const updatedAt = new Date(Math.max(Date.now(), Date.parse(range.createdAt))).toISOString();
      onSave({ ...validated, createdAt: range.createdAt, updatedAt });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "The range is invalid.";
      setError({ field: "range", message: `${detail} Keep 0 ≤ start < end ≤ ${formatOffsetUsInput(session.document.durationUs)}.` });
    }
  };
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form ref={dialogRef} className="bundle-dialog range-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="range-dialog-title" onSubmit={submit}>
        <button className="dialog-close" type="button" aria-label="Close incident range dialog" onClick={onClose}><X size={17} /></button>
        <div className="dialog-icon"><BookmarkSimple size={24} /></div>
        <span className="dialog-kicker">{mode === "create" ? "New local incident" : "Operator-authored incident"}</span>
        <h2 id="range-dialog-title">{mode === "create" ? "Define an incident range" : "Edit incident range"}</h2>
        <p>{mode === "create" ? "Create a local overlay on the immutable replay, then investigate and export only that evidence." : "Rename the incident or set its exact half-open boundaries without changing the captured session."}</p>
        <div className="dialog-fields">
          <label><span>Title</span><input ref={titleRef} data-dialog-focus value={title} maxLength={MAX_INCIDENT_TITLE_LENGTH} aria-invalid={error?.field === "title"} aria-describedby={error?.field === "title" ? "range-dialog-error" : undefined} onChange={(event) => { setTitle(event.target.value); clearFieldError("title"); }} placeholder="What happened?" /></label>
          <div className="range-boundaries">
            <label><span>Start · included</span><input ref={startRef} value={startValue} inputMode="text" spellCheck={false} aria-invalid={error?.field === "start" || error?.field === "range"} aria-describedby={`range-start-help${error?.field === "start" || error?.field === "range" ? " range-dialog-error" : ""}`} onChange={(event) => { setStartValue(event.target.value); clearFieldError("start"); }} /><small id="range-start-help" className="field-help">{startUs == null ? "HH:MM:SS.ffffff" : <><output>{formatExactSessionClock(session, startUs)}</output> {timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, startUs)}</>}</small></label>
            <label><span>End · excluded</span><input ref={endRef} value={endValue} inputMode="text" spellCheck={false} aria-invalid={error?.field === "end" || error?.field === "range"} aria-describedby={`range-end-help${error?.field === "end" || error?.field === "range" ? " range-dialog-error" : ""}`} onChange={(event) => { setEndValue(event.target.value); clearFieldError("end"); }} /><small id="range-end-help" className="field-help">{endUs == null ? "HH:MM:SS.ffffff" : <><output>{formatExactSessionClock(session, endUs)}</output> {timeZoneAbbreviation(session.document.startedAt, session.document.displayTimeZone, endUs)}</>}</small></label>
          </div>
          <label><span>Severity</span><select value={severity} onChange={(event) => setSeverity(event.target.value as AuthoredIncidentRange["severity"])}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label>
        </div>
        <div className="range-semantics"><strong>{validDuration == null ? "Invalid range" : formatDurationUs(validDuration, true)}</strong><span>[start, end) · the end instant is excluded</span><small>Session clock uses {session.document.displayTimeZone} ({zone}). Offsets are stored as integer microseconds.</small></div>
        {error && <p id="range-dialog-error" className="dialog-error" role="alert">{error.message}</p>}
        {mode === "edit" && onDelete && <div className="range-delete">{confirmDelete ? <><p>Delete this local range? The replay and exported archives are not changed.</p><div><button ref={deleteKeepRef} className="secondary-action" type="button" onClick={cancelDelete}>Keep range</button><button className="destructive-action" type="button" onClick={onDelete}><Trash size={15} /> Delete range</button></div></> : <button ref={deleteTriggerRef} className="destructive-link" type="button" onClick={requestDelete}><Trash size={14} /> Delete local range</button>}</div>}
        <div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Cancel</button><button className="primary-action" type="submit"><Check size={16} weight="bold" /> {mode === "create" ? "Create range" : "Save range"}</button></div>
      </form>
    </div>,
    document.body,
  );
}

interface BundleDialogProps {
  session: ParsedSession;
  incident: IncidentProjection;
  items: BundleItem[];
  markers: Marker[];
  note: string;
  onClose: () => void;
}

function BundleDialog({ session, incident, items, markers, note, onClose }: BundleDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const buildControllerRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<"confirm" | "building" | "canceled" | "success" | "error">("confirm");
  const [progress, setProgress] = useState<EvidenceBundleProcessingProgress | null>(null);
  const [artifact, setArtifact] = useState<{ filename: string; bytes: number } | null>(null);
  const [error, setError] = useState("");
  const selected = items.filter((item) => item.required || item.selected);
  const clock = incidentClock(session, incident);
  const cancelBuild = () => {
    buildControllerRef.current?.abort();
    buildControllerRef.current = null;
    setStatus("canceled");
  };
  const requestClose = () => {
    if (status === "building") cancelBuild();
    else onClose();
  };
  useModalFocus(dialogRef, requestClose);
  useEffect(() => () => buildControllerRef.current?.abort(), []);
  useEffect(() => {
    if (status === "confirm") return;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("[data-status-focus]")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [status]);
  const createBundle = async () => {
    buildControllerRef.current?.abort();
    const controller = new AbortController();
    buildControllerRef.current = controller;
    setStatus("building");
    setProgress({
      phase: "loading-session",
      percent: 0,
      message: "Preparing immutable session evidence",
    });
    try {
      const enabled = new Set(selected.map((item) => item.id));
      const include: Partial<EvidenceBundleInclusions> = { rawRecords: enabled.has("rawRecords"), decodedPackets: enabled.has("decodedPackets"), schema: enabled.has("schema"), diagnostics: enabled.has("diagnostics"), markers: enabled.has("notes"), notes: enabled.has("notes") };
      const bytes = await buildEvidenceBundleInWorker(
        { session, range: incident, markers, notes: note.trim() ? [{ id: "operator-note", body: note.trim(), title: "Operator note" }] : [], include },
        {
          signal: controller.signal,
          onProgress: setProgress,
        },
      );
      if (controller.signal.aborted) throw new EvidenceBundleProcessingCancelledError();
      const filename = suggestEvidenceBundleFilename(session, incident);
      downloadEvidenceBundle(bytes, filename);
      setArtifact({ filename, bytes: bytes.byteLength });
      setStatus("success");
    } catch (cause) {
      if (cause instanceof EvidenceBundleProcessingCancelledError) {
        setStatus("canceled");
        return;
      }
      setError(cause instanceof Error ? cause.message : "The evidence archive could not be built.");
      setStatus("error");
    } finally {
      if (buildControllerRef.current === controller) buildControllerRef.current = null;
    }
  };
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && status !== "building" && onClose()}><section ref={dialogRef} className="bundle-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="bundle-dialog-title" aria-live="polite" aria-busy={status === "building"}><button className="dialog-close" type="button" aria-label={status === "building" ? "Cancel bundle construction" : "Close"} onClick={requestClose}><X size={17} /></button>{status === "confirm" && <><div className="dialog-icon"><Package size={24} /></div><span className="dialog-kicker">Incident bundle</span><h2 id="bundle-dialog-title">Package this incident for handoff?</h2><p>The archive is built and downloaded locally. The original replay is never modified or uploaded.</p><dl className="dialog-summary"><div><dt>Range</dt><dd>{clock.start} – {clock.end}</dd></div><div><dt>Contents</dt><dd>{selected.length} selected groups</dd></div><div><dt>Checksums</dt><dd>SHA-256 manifest</dd></div></dl><div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Cancel</button><button className="primary-action" data-dialog-focus type="button" onClick={() => void createBundle()}><DownloadSimple size={17} /> Build and download</button></div></>}{status === "building" && <div className="dialog-success"><div className="dialog-icon"><SpinnerGap className="spin" size={24} /></div><span className="dialog-kicker">Building locally</span><h2 id="bundle-dialog-title" className="bundle-progress-title" data-status-focus tabIndex={-1}>{progress?.message ?? "Preparing evidence"}</h2><p>Only a complete, verified archive can reach the download boundary.</p>{progress && <div className="processing-meter processing-meter-dialog"><progress max={100} value={progress.percent} aria-label="Evidence bundle construction progress" /><span>{Math.floor(progress.percent)}%</span></div>}<div className="dialog-actions"><button className="secondary-action" type="button" onClick={cancelBuild}>Cancel construction</button></div></div>}{status === "canceled" && <div className="dialog-success"><div className="dialog-icon"><X size={24} /></div><span className="dialog-kicker">Bundle canceled</span><h2 id="bundle-dialog-title" data-status-focus tabIndex={-1}>No archive was created</h2><p>The source replay and operator workspace were not modified.</p><div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Return to session</button><button className="primary-action" type="button" onClick={() => void createBundle()}>Build again</button></div></div>}{status === "success" && artifact && <div className="dialog-success"><div className="success-mark"><Check size={28} weight="bold" /></div><span className="dialog-kicker">Evidence bundle downloaded</span><h2 id="bundle-dialog-title">Handoff archive is ready</h2><p><strong>{artifact.filename}</strong> contains {formatBytes(artifact.bytes)} of locally generated, verifiable evidence.</p><button className="primary-action" data-status-focus type="button" onClick={onClose}>Return to session</button></div>}{status === "error" && <div className="dialog-success"><div className="dialog-icon error-icon"><WarningCircle size={26} /></div><span className="dialog-kicker">Bundle failed</span><h2 id="bundle-dialog-title" data-status-focus tabIndex={-1}>The archive was not created</h2><p>{error}</p><div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Close</button><button className="primary-action" type="button" onClick={() => void createBundle()}>Try again</button></div></div>}</section></div>, document.body);
}

function Toast({ message }: { message: string }) {
  return message ? <div className="toast" role="status"><Check size={15} weight="bold" /> {message}</div> : null;
}

function Workspace({ session, onOpenReplay, onOpenBundle, onOpenCapture, onOpenCases, onCompare, library, workspacePersistenceCommand }: { session: ParsedSession; onOpenReplay: () => void; onOpenBundle: () => void; onOpenCapture: () => void; onOpenCases: () => void; onCompare: (session: ParsedSession, incident: IncidentProjection) => void; library: SessionLibraryController; workspacePersistenceCommand: WorkspacePersistenceCommand | null }) {
  const firstIncident = session.incidents.find((candidate) => candidate.id === "fade") ?? session.incidents[0] ?? null;
  const initialReplayOffsetUs = firstIncident ? incidentViewRange(session, firstIncident).startUs : 0;
  const replay = useReplay({ durationUs: session.document.durationUs, initialOffsetUs: initialReplayOffsetUs, initialRate: 1 });
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(firstIncident?.id ?? null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("narrative");
  const isBundledDemo = isBundledDemoSession(session);
  const workspaceIdentity = useMemo(() => sessionWorkspaceStorageIdentity(session), [session]);
  const workspaceContext = useMemo(() => ({
    durationUs: session.document.durationUs,
    reservedIncidentIds: session.incidents.map((incident) => incident.id),
  }), [session.document.durationUs, session.incidents]);
  const stored = useMemo(() => loadSessionWorkspace(workspaceIdentity, workspaceContext), [workspaceContext, workspaceIdentity]);
  const [markers, setMarkers] = useState<Marker[]>(() => stored.updatedAt == null && isBundledDemo ? createSeedMarkers(session) : stored.markers);
  const [note, setNote] = useState(() => stored.updatedAt == null && isBundledDemo ? DEFAULT_NOTE : stored.notes);
  const [authoredIncidentRanges, setAuthoredIncidentRanges] = useState<AuthoredIncidentRange[]>(() => stored.authoredIncidentRanges);
  const [markerDialogOpen, setMarkerDialogOpen] = useState(false);
  const [rangeDialog, setRangeDialog] = useState<{ mode: "create" | "edit"; range: AuthoredIncidentRange } | null>(null);
  const [bundleDialogOpen, setBundleDialogOpen] = useState(false);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [workspacePersistence, setWorkspacePersistence] = useState<WorkspacePersistenceState>("stored");
  const workspaceAutosaveEnabledRef = useRef(true);
  const workspacePersistenceCommandRef = useRef(0);
  const authoredIncidents = useMemo(() => authoredIncidentRanges.map((range) => projectIncident({ id: range.id, title: range.title, startUs: range.startUs, endUs: range.endUs, severity: range.severity }, session.frames, session.diagnostics)), [authoredIncidentRanges, session.diagnostics, session.frames]);
  const incidents = useMemo(() => [...session.incidents, ...authoredIncidents], [authoredIncidents, session.incidents]);
  const selectedIncident = incidents.find((candidate) => candidate.id === selectedIncidentId) ?? null;
  const selectedAuthoredRange = authoredIncidentRanges.find((candidate) => candidate.id === selectedIncidentId) ?? null;
  const [bundleItems, setBundleItems] = useState<BundleItem[]>(() => firstIncident ? initialBundleItems(session, firstIncident) : []);
  const bundleIncidentIdRef = useRef<string | null>(firstIncident?.id ?? null);

  useEffect(() => {
    if (!workspaceAutosaveEnabledRef.current) return;
    setWorkspacePersistence(saveSessionWorkspace(workspaceIdentity, { markers, notes: note, authoredIncidentRanges }, workspaceContext) ? "stored" : "unavailable");
  }, [authoredIncidentRanges, markers, note, workspaceContext, workspaceIdentity]);
  useEffect(() => {
    if (
      workspacePersistenceCommand === null
      || workspacePersistenceCommand.identity !== workspaceIdentity
      || workspacePersistenceCommand.revision <= workspacePersistenceCommandRef.current
    ) return;
    workspacePersistenceCommandRef.current = workspacePersistenceCommand.revision;
    if (workspacePersistenceCommand.kind === "clear") {
      workspaceAutosaveEnabledRef.current = false;
      setWorkspacePersistence("memory-only");
      return;
    }
    workspaceAutosaveEnabledRef.current = true;
    setWorkspacePersistence(saveSessionWorkspace(workspaceIdentity, { markers, notes: note, authoredIncidentRanges }, workspaceContext) ? "stored" : "unavailable");
  }, [authoredIncidentRanges, markers, note, workspaceContext, workspaceIdentity, workspacePersistenceCommand]);
  useEffect(() => {
    const nextItems = selectedIncident ? initialBundleItems(session, selectedIncident) : [];
    const preserveSelections = selectedIncident != null && bundleIncidentIdRef.current === selectedIncident.id;
    setBundleItems((current) => {
      if (!preserveSelections) return nextItems;
      const selectedById = new Map(current.map((item) => [item.id, item.selected]));
      return nextItems.map((item) => ({ ...item, selected: item.required ? true : (selectedById.get(item.id) ?? item.selected) }));
    });
    bundleIncidentIdRef.current = selectedIncident?.id ?? null;
  }, [selectedIncident?.endUs, selectedIncident?.id, selectedIncident?.startUs, session]);
  const notify = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); }, []);
  const selectIncident = (id: string, focusPanel = false) => {
    const next = incidents.find((candidate) => candidate.id === id);
    if (!next) return;
    setSelectedIncidentId(next.id);
    replay.pause();
    replay.seek(next.startUs);
    setActiveTab("narrative");
    if (focusPanel) scheduleElementFocus("[data-incident-selected-focus]");
  };
  const clearIncident = () => {
    setSelectedIncidentId(null);
    scheduleElementFocus("[data-incident-empty-focus]");
  };
  const togglePlayback = () => replay.snapshot.status === "playing" ? replay.pause() : replay.play();
  const addMarker = (marker: Marker) => { setMarkers((current) => [...current, marker].sort((left, right) => left.offsetUs - right.offsetUs)); setMarkerDialogOpen(false); replay.seek(marker.offsetUs); notify(`Marker added at ${formatClockOffset(session.document.startedAt, marker.offsetUs, session.document.displayTimeZone)}`); };
  const createRangeDraft = (source?: IncidentProjection): AuthoredIncidentRange => {
    const now = new Date().toISOString();
    if (source) {
      const localSuffix = " · local";
      const title = source.title.length + localSuffix.length <= MAX_INCIDENT_TITLE_LENGTH ? `${source.title}${localSuffix}` : source.title;
      return { id: `operator-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, title, startUs: source.startUs, endUs: source.endUs, severity: source.severity, createdAt: now, updatedAt: now };
    }
    const rangeDurationUs = Math.min(30_000_000, session.document.durationUs);
    const startUs = Math.max(0, Math.min(Math.round(replay.snapshot.offsetUs - rangeDurationUs / 2), session.document.durationUs - rangeDurationUs));
    return { id: `operator-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, title: `Incident ${authoredIncidentRanges.length + 1}`, startUs, endUs: startUs + rangeDurationUs, severity: "warning", createdAt: now, updatedAt: now };
  };
  const openNewRange = () => {
    if (authoredIncidentRanges.length >= 100) {
      notify("This session already has the maximum of 100 local incident ranges");
      return;
    }
    setRangeDialog({ mode: "create", range: createRangeDraft() });
  };
  const openRangeEditor = () => {
    if (!selectedIncident) {
      openNewRange();
    } else if (selectedAuthoredRange) {
      setRangeDialog({ mode: "edit", range: selectedAuthoredRange });
    } else {
      if (authoredIncidentRanges.length >= 100) {
        notify("This session already has the maximum of 100 local incident ranges");
        return;
      }
      setRangeDialog({ mode: "create", range: createRangeDraft(selectedIncident) });
    }
  };
  const saveRange = (range: AuthoredIncidentRange) => {
    const isExisting = authoredIncidentRanges.some((candidate) => candidate.id === range.id);
    setAuthoredIncidentRanges((current) => isExisting ? current.map((candidate) => candidate.id === range.id ? range : candidate) : [...current, range]);
    setSelectedIncidentId(range.id);
    setRangeDialog(null);
    replay.pause();
    replay.seek(range.startUs);
    setActiveTab("narrative");
    notify(isExisting ? "Incident range updated" : "Incident range created locally");
  };
  const deleteRange = () => {
    if (!rangeDialog) return;
    const replacement = session.incidents[0] ?? null;
    setAuthoredIncidentRanges((current) => current.filter((candidate) => candidate.id !== rangeDialog.range.id));
    setSelectedIncidentId(replacement?.id ?? null);
    setRangeDialog(null);
    if (replacement) replay.seek(replacement.startUs);
    scheduleElementFocus(replacement ? "[data-incident-selected-focus]" : "[data-incident-empty-focus]");
    notify("Local incident range deleted");
  };
  const resizeSelectedRange = (startUs: number, endUs: number) => {
    if (!selectedAuthoredRange) return;
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(selectedAuthoredRange.createdAt))).toISOString();
    setAuthoredIncidentRanges((current) => current.map((range) => range.id === selectedAuthoredRange.id ? { ...range, startUs, endUs, updatedAt } : range));
  };

  return (
    <main className="app-shell" aria-label="Telemetry review workspace">
      <LeftRail session={session} replayOffsetUs={replay.snapshot.offsetUs} onOpenReplay={onOpenReplay} onOpenBundle={onOpenBundle} onOpenCapture={onOpenCapture} library={library} />
      <TopBar onOpenCases={onOpenCases} session={session} replayOffsetUs={replay.snapshot.offsetUs} replayStatus={replay.snapshot.status} replayRate={replay.snapshot.rate} onTogglePlayback={togglePlayback} onReset={replay.reset} onRateChange={replay.setRate} onAddMarker={() => setMarkerDialogOpen(true)} onCreateBundle={() => setBundleDialogOpen(true)} onOpenReplay={onOpenReplay} onOpenBundle={onOpenBundle} onOpenCapture={onOpenCapture} onOpenLibrary={() => setLibraryDialogOpen(true)} onCompare={() => selectedIncident && onCompare(session, selectedIncident)} savedSessionCount={library.entries.length} bundleDisabled={!selectedIncident || !bundleItems.some((item) => item.selected)} compareDisabled={!selectedIncident} />
      <SessionOverview session={session} incidents={incidents} incident={selectedIncident} incidentEditable={selectedAuthoredRange != null} markers={markers} replayOffsetUs={replay.snapshot.offsetUs} onSeek={replay.seek} onSelectIncident={(incident) => selectIncident(incident.id)} onCreateRange={openNewRange} onRangeChange={resizeSelectedRange} />
      {selectedIncident ? <MissionTimeline session={session} incident={selectedIncident} incidentEditable={selectedAuthoredRange != null} markers={markers} replayOffsetUs={replay.snapshot.offsetUs} onSeek={replay.seek} onRangeChange={resizeSelectedRange} /> : <section className="timeline-panel"><div className="empty-state"><BookmarkSimple size={24} /><h2>Select an incident</h2><p>The full replay remains available in the session overview.</p></div></section>}
      <IncidentPanel session={session} incidents={incidents} incident={selectedIncident} incidentEditable={selectedAuthoredRange != null} activeTab={activeTab} note={note} workspacePersistence={workspacePersistence} onTabChange={setActiveTab} onNoteChange={setNote} onSelectIncident={selectIncident} onEditRange={openRangeEditor} onClear={clearIncident} />
      <BundlePanel session={session} incident={selectedIncident} items={bundleItems} note={note} workspacePersistence={workspacePersistence} onItemsChange={setBundleItems} onNoteChange={setNote} onCreateBundle={() => setBundleDialogOpen(true)} />
      {markerDialogOpen && <MarkerDialog session={session} initialOffsetUs={replay.snapshot.offsetUs} onClose={() => setMarkerDialogOpen(false)} onCreate={addMarker} />}
      {rangeDialog && <IncidentRangeDialog session={session} mode={rangeDialog.mode} range={rangeDialog.range} onClose={() => setRangeDialog(null)} onSave={saveRange} onDelete={rangeDialog.mode === "edit" ? deleteRange : undefined} />}
      {bundleDialogOpen && selectedIncident && <BundleDialog session={session} incident={selectedIncident} items={bundleItems} markers={markers} note={note} onClose={() => setBundleDialogOpen(false)} />}
      {libraryDialogOpen && <SessionLibraryDialog library={library} onClose={() => setLibraryDialogOpen(false)} />}
      <div className="visually-hidden" role="alert" aria-atomic="true">{library.error}</div>
      <Toast message={library.notice || toast} />
    </main>
  );
}

function LoadingScreen({ message, progress }: { message: string; progress?: SessionProcessingProgress }) {
  return <main className="load-screen" role="status" aria-live="polite" aria-busy="true"><img src="/replaycase-mark.svg" alt="" /><SpinnerGap className="spin" size={24} /><h1 data-load-focus tabIndex={-1}>ReplayCase</h1><p>{progress?.message ?? message}</p>{progress && <div className="processing-meter"><progress max={100} value={progress.percent} aria-label="Replay processing progress" /><span>{Math.floor(progress.percent)}%</span></div>}</main>;
}

function ErrorScreen({ error, onRetry, onOpenReplay, onOpenBundle }: { error: SessionLoadError; onRetry: () => void; onOpenReplay: () => void; onOpenBundle: () => void }) {
  return <main className="load-screen error-screen" role="alert"><img src="/replaycase-mark.svg" alt="" /><WarningCircle size={28} /><h1 data-load-focus tabIndex={-1}>Replay could not be opened</h1><p>{error.message}</p>{error.details.length > 0 && <ul>{error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}<div><button className="secondary-action" type="button" onClick={onOpenReplay}>Choose another replay</button><button className="secondary-action" type="button" onClick={onOpenBundle}>Open evidence bundle</button><button className="primary-action" type="button" onClick={onRetry}>Load bundled replay</button></div></main>;
}

function ReplayProcessingDialog({
  state,
  onCancel,
  onRetry,
  onClose,
}: {
  state: Exclude<ReplayProcessingState, { status: "idle" }>;
  onCancel: () => void;
  onRetry: (source: ReplayProcessingSource) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, state.status === "processing" ? onCancel : onClose);
  const processing = state.status === "processing";
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && (processing ? onCancel() : onClose())}>
      <section
        ref={dialogRef}
        className="bundle-dialog replay-processing-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="replay-processing-title"
        aria-describedby="replay-processing-description"
        aria-busy={processing}
      >
        <button className="dialog-close" type="button" aria-label={processing ? "Cancel replay processing" : "Close replay processing error"} onClick={processing ? onCancel : onClose}><X size={17} /></button>
        <div className={`dialog-icon${processing ? "" : " error-icon"}`}>
          {processing ? <SpinnerGap className="spin" size={24} /> : <WarningCircle size={26} />}
        </div>
        <span className="dialog-kicker">{processing ? "Worker-isolated replay" : "Replay unchanged"}</span>
        <h2 id="replay-processing-title" data-dialog-focus tabIndex={-1}>
          {processing ? `Processing ${state.source.name}` : `${state.source.name} was not opened`}
        </h2>
        {processing ? (
          <>
            <p id="replay-processing-description">{state.progress.message}. The currently open workspace remains available if this operation is canceled.</p>
            <div className="processing-meter processing-meter-dialog">
              <progress max={100} value={state.progress.percent} aria-label="Replay processing progress" />
              <span>{Math.floor(state.progress.percent)}%</span>
            </div>
            <dl className="dialog-summary">
              <div><dt>Phase</dt><dd>{state.progress.phase}</dd></div>
              <div><dt>Source</dt><dd>{formatBytes(state.source.size)}</dd></div>
            </dl>
            <div className="dialog-actions"><button className="secondary-action" type="button" onClick={onCancel}>Cancel processing</button></div>
          </>
        ) : (
          <>
            <p id="replay-processing-description">{state.error.message}</p>
            {state.error.details.length > 0 && <ul className="dialog-error-details">{state.error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
            <p className="evidence-recovery-note">No partial session was opened or persisted.</p>
            <div className="dialog-actions"><button className="secondary-action" type="button" onClick={onClose}>Return to workspace</button><button className="primary-action" type="button" onClick={() => onRetry(state.source)}>Try again</button></div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

function EvidenceOpenDialog({
  state,
  onClose,
}: {
  state: Exclude<EvidenceOpenState, { status: "idle" }>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(dialogRef, onClose, state.status === "error");
  const descriptionId = state.status === "error" ? "evidence-open-error-description" : "evidence-open-progress-description";
  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && state.status === "error" && onClose()}>
      <section
        ref={dialogRef}
        className="bundle-dialog evidence-open-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="evidence-open-dialog-title"
        aria-describedby={descriptionId}
        aria-busy={state.status === "verifying"}
      >
        <button className="dialog-close" type="button" aria-label="Close evidence verification" disabled={state.status === "verifying"} onClick={onClose}><X size={17} /></button>
        <div className={`dialog-icon${state.status === "error" ? " error-icon" : ""}`}>
          {state.status === "verifying" ? <SpinnerGap className="spin" size={24} /> : <WarningCircle size={26} />}
        </div>
        <span className="dialog-kicker">{state.status === "verifying" ? "Untrusted evidence input" : "Evidence bundle rejected"}</span>
        <h2 id="evidence-open-dialog-title" data-dialog-focus tabIndex={-1}>
          {state.status === "verifying" ? `Verifying ${state.fileName}` : `${state.fileName} was not opened`}
        </h2>
        {state.status === "verifying" ? (
          <p id={descriptionId}>ReplayCase is preflighting ZIP structure, bounding decompression, checking every artifact, and reconciling the incident before showing any evidence.</p>
        ) : (
          <>
            <p id={descriptionId}>{state.error.message}</p>
            <dl className="dialog-summary evidence-error-summary">
              <div><dt>Failure</dt><dd>{state.error.code}</dd></div>
              <div><dt>Artifact</dt><dd>{state.error.path ?? "Archive"}</dd></div>
            </dl>
            {state.error.details.length > 0 && <ul className="dialog-error-details">{state.error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
            <p className="evidence-recovery-note">The previously open workspace remains unchanged.</p>
            <div className="dialog-actions"><button className="primary-action" type="button" onClick={onClose}>Return to workspace</button></div>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

export function App({ operatorRuntime = MANUAL_OPERATOR_RUNTIME }: { operatorRuntime?: OperatorRuntime }) {
  const [casesVisible, setCasesVisible] = useState(false);
  const [casesOpened, setCasesOpened] = useState(false);
  const caseTriggerRef = useRef<HTMLElement | null>(null);
  const caseHostRef = useRef<HTMLDivElement>(null);
  const openCases = () => {
    caseTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCasesOpened(true);
    setCasesVisible(true);
    requestAnimationFrame(() => caseHostRef.current?.querySelector<HTMLElement>("h1")?.focus());
  };
  const closeCases = () => {
    setCasesVisible(false);
    requestAnimationFrame(() => caseTriggerRef.current?.focus());
  };
  const [state, setState] = useState<LoadState>({ status: "loading", message: "Validating bundled telemetry…" });
  const [comparisonModel, setComparisonModel] = useState<ComparisonModel | null>(null);
  const [comparisonBaseline, setComparisonBaseline] = useState<ComparisonSource | null>(null);
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const sessionLibrary = useMemo<SessionLibrary>(() => createSessionLibrary(), []);
  const [libraryEntries, setLibraryEntries] = useState<SessionLibraryEntry[]>([]);
  const [libraryStatus, setLibraryStatus] = useState<SessionLibraryStatus>("loading");
  const [libraryAction, setLibraryAction] = useState<SessionLibraryAction>({ kind: "idle" });
  const [activeLibraryIdentity, setActiveLibraryIdentity] = useState<string | null>(null);
  const [pendingDeleteIdentity, setPendingDeleteIdentity] = useState<string | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState("");
  const libraryOperationGate = useMemo(() => createOperationGate(), []);
  const sessionOperationGate = useMemo(() => createOperationGate(), []);
  const [workspacePersistenceCommand, setWorkspacePersistenceCommand] = useState<WorkspacePersistenceCommand | null>(null);
  const [evidenceOpenState, setEvidenceOpenState] = useState<EvidenceOpenState>({ status: "idle" });
  const [replayProcessingState, setReplayProcessingState] = useState<ReplayProcessingState>({ status: "idle" });
  const workspacePersistenceCommandRevisionRef = useRef(0);
  const libraryNoticeTimerRef = useRef<number | null>(null);
  const replayProcessingControllerRef = useRef<AbortController | null>(null);
  const libraryProcessingControllerRef = useRef<AbortController | null>(null);
  const bundledProcessingControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const evidenceInputRef = useRef<HTMLInputElement>(null);

  const announceLibrary = useCallback((message: string) => {
    if (libraryNoticeTimerRef.current !== null) window.clearTimeout(libraryNoticeTimerRef.current);
    setLibraryNotice(message);
    libraryNoticeTimerRef.current = window.setTimeout(() => setLibraryNotice(""), 3_000);
  }, []);

  useEffect(() => () => {
    if (libraryNoticeTimerRef.current !== null) window.clearTimeout(libraryNoticeTimerRef.current);
    replayProcessingControllerRef.current?.abort();
    libraryProcessingControllerRef.current?.abort();
    bundledProcessingControllerRef.current?.abort();
  }, []);

  const issueWorkspacePersistenceCommand = useCallback((session: ParsedSession, kind: WorkspacePersistenceCommand["kind"]) => {
    workspacePersistenceCommandRevisionRef.current += 1;
    setWorkspacePersistenceCommand({
      identity: sessionWorkspaceStorageIdentity(session),
      kind,
      revision: workspacePersistenceCommandRevisionRef.current,
    });
  }, []);

  const refreshLibrary = useCallback(async () => {
    const operation = libraryOperationGate.begin();
    setLibraryStatus("loading");
    setLibraryError(null);
    try {
      const entries = await sessionLibrary.list();
      if (!libraryOperationGate.isCurrent(operation)) return;
      setLibraryEntries(entries);
      setLibraryStatus("ready");
    } catch (cause) {
      if (!libraryOperationGate.isCurrent(operation)) return;
      setLibraryStatus(cause instanceof SessionLibraryError && cause.code === "unavailable" ? "unavailable" : "error");
      setLibraryError(sessionLibraryErrorMessage(cause));
    }
  }, [libraryOperationGate, sessionLibrary]);

  useEffect(() => { void refreshLibrary(); }, [refreshLibrary]);

  const persistSession = useCallback(async (session: ParsedSession, successMessage: string, focusSavedEntry = false) => {
    const operation = libraryOperationGate.begin();
    setLibraryAction({ kind: "saving" });
    setLibraryError(null);
    try {
      const entry = await sessionLibrary.save(session);
      let refreshResult: Parameters<typeof resolveCommittedSave>[2];
      try {
        refreshResult = { ok: true, entries: await sessionLibrary.list() };
      } catch (cause) {
        refreshResult = {
          ok: false,
          warning: `The session was saved, but the local library list could not be refreshed. ${sessionLibraryErrorMessage(cause)}`,
        };
      }
      if (!libraryOperationGate.isCurrent(operation)) return;
      setLibraryEntries((current) => resolveCommittedSave(current, entry, refreshResult).entries);
      setActiveLibraryIdentity(entry.identity);
      setLibraryStatus("ready");
      setLibraryError(refreshResult.ok ? null : refreshResult.warning);
      issueWorkspacePersistenceCommand(session, "save");
      announceLibrary(successMessage);
      if (focusSavedEntry) scheduleSavedSessionFocus(entry.identity);
    } catch (cause) {
      if (!libraryOperationGate.isCurrent(operation)) return;
      setActiveLibraryIdentity(null);
      setLibraryError(sessionLibraryErrorMessage(cause));
      if (cause instanceof SessionLibraryError && cause.code === "unavailable") {
        setLibraryStatus("unavailable");
      } else {
        try {
          const entries = await sessionLibrary.list();
          if (!libraryOperationGate.isCurrent(operation)) return;
          setLibraryEntries(entries);
          setLibraryStatus("ready");
        } catch (listCause) {
          if (!libraryOperationGate.isCurrent(operation)) return;
          setLibraryStatus(listCause instanceof SessionLibraryError && listCause.code === "unavailable" ? "unavailable" : "error");
        }
      }
    } finally {
      if (libraryOperationGate.isCurrent(operation)) setLibraryAction({ kind: "idle" });
    }
  }, [announceLibrary, issueWorkspacePersistenceCommand, libraryOperationGate, sessionLibrary]);

  const loadDefault = useCallback(async () => {
    const operation = sessionOperationGate.begin();
    bundledProcessingControllerRef.current?.abort();
    const controller = new AbortController();
    bundledProcessingControllerRef.current = controller;
    setEvidenceOpenState({ status: "idle" });
    setComparisonModel(null);
    setComparisonBaseline(null);
    setState({ status: "loading", message: "Validating bundled telemetry…" });
    try {
      const session = await loadBundledSession({
        signal: controller.signal,
        onProgress(progress) {
          if (sessionOperationGate.isCurrent(operation)) {
            setState({ status: "loading", message: "Validating bundled telemetry…", progress });
          }
        },
      });
      if (sessionOperationGate.isCurrent(operation)) setState({ status: "ready", session });
    } catch (cause) {
      if (cause instanceof SessionProcessingCancelledError) return;
      if (sessionOperationGate.isCurrent(operation)) setState({ status: "error", error: cause instanceof SessionLoadError ? cause : new SessionLoadError("The bundled replay could not be loaded.", [cause instanceof Error ? cause.message : "Unknown error"]) });
    } finally {
      if (bundledProcessingControllerRef.current === controller) bundledProcessingControllerRef.current = null;
    }
  }, [sessionOperationGate]);
  useEffect(() => { void loadDefault(); }, [loadDefault]);

  useEffect(() => {
    if (state.status !== "ready") {
      setActiveLibraryIdentity(null);
      return;
    }
    let cancelled = false;
    void sessionLibraryIdentity(state.session).then((identity) => {
      if (!cancelled) setActiveLibraryIdentity(libraryEntries.some((entry) => entry.identity === identity) ? identity : null);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      setActiveLibraryIdentity(null);
      setLibraryError(sessionLibraryErrorMessage(cause));
    });
    return () => { cancelled = true; };
  }, [libraryEntries, state]);

  const stateFocusKey = comparisonModel == null
    ? state.status === "ready"
      ? sessionWorkspaceKey(state.session)
      : state.status === "receiver"
        ? state.document.bundle.sha256
        : state.status
    : comparisonWorkspaceKey(comparisonModel);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(
        comparisonModel != null || state.status === "ready" || state.status === "receiver"
          ? ".workspace-heading"
          : "[data-load-focus]",
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [comparisonModel, state.status, stateFocusKey]);
  const openReplay = () => fileInputRef.current?.click();
  const openEvidence = () => evidenceInputRef.current?.click();
  const completeCapture = useCallback(async (document: SessionDocument) => {
    sessionOperationGate.begin();
    try {
      const serialized = serializeSessionDocument(document);
      const processed = await processSessionBlob(
        new Blob([serialized], { type: "application/json" }),
        { sourceLabel: `${document.id}.nlsession` },
      );
      const session = processed.session;
      setComparisonModel(null);
      setComparisonBaseline(null);
      setState({ status: "ready", session });
      setCaptureDialogOpen(false);
      scheduleElementFocus(".workspace-heading");
      void persistSession(session, "Capture saved to the local session library");
    } catch (cause) {
      setCaptureDialogOpen(false);
      setState({ status: "error", error: new SessionLoadError("The captured session could not be opened.", [cause instanceof Error ? cause.message : "Unknown capture error"]) });
    }
  }, [persistSession, sessionOperationGate]);
  const processReplayFile = useCallback(async (file: File) => {
    libraryProcessingControllerRef.current?.abort();
    replayProcessingControllerRef.current?.abort();
    const controller = new AbortController();
    replayProcessingControllerRef.current = controller;
    const operation = sessionOperationGate.begin();
    const source: ReplayProcessingSource = {
      kind: "file",
      file,
      name: file.name,
      size: file.size,
    };
    setReplayProcessingState({
      status: "processing",
      source,
      progress: processingProgress("reading", 0, file.size),
    });
    try {
      const session = await loadSessionFile(file, {
        signal: controller.signal,
        onProgress(progress) {
          if (sessionOperationGate.isCurrent(operation)) {
            setReplayProcessingState({ status: "processing", source, progress });
          }
        },
      });
      if (!sessionOperationGate.isCurrent(operation)) return;
      setComparisonModel(null);
      setComparisonBaseline(null);
      setState({ status: "ready", session });
      setReplayProcessingState({ status: "idle" });
      void persistSession(session, `${file.name} saved to the local session library`);
    }
    catch (cause) {
      if (!sessionOperationGate.isCurrent(operation)) return;
      if (cause instanceof SessionProcessingCancelledError) {
        setReplayProcessingState({ status: "idle" });
        announceLibrary("Replay processing canceled; the open workspace was not changed");
        return;
      }
      setReplayProcessingState({
        status: "error",
        source,
        error: cause instanceof SessionLoadError
          ? cause
          : new SessionLoadError("The selected replay could not be loaded.", [
              cause instanceof Error ? cause.message : "Unknown replay processing error.",
            ]),
      });
    } finally {
      if (replayProcessingControllerRef.current === controller) replayProcessingControllerRef.current = null;
    }
  }, [announceLibrary, persistSession, sessionOperationGate]);
  const cancelReplayProcessing = useCallback(() => {
    replayProcessingControllerRef.current?.abort();
    replayProcessingControllerRef.current = null;
    libraryProcessingControllerRef.current?.abort();
    libraryProcessingControllerRef.current = null;
    sessionOperationGate.begin();
    libraryOperationGate.begin();
    setLibraryAction({ kind: "idle" });
    setReplayProcessingState({ status: "idle" });
    announceLibrary("Replay processing canceled; the open workspace was not changed");
  }, [announceLibrary, libraryOperationGate, sessionOperationGate]);
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void processReplayFile(file);
  };

  const handleEvidenceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const operation = sessionOperationGate.begin();
    setEvidenceOpenState({ status: "verifying", fileName: file.name });
    try {
      const receiverDocument = await loadEvidenceBundleFile(file);
      if (!sessionOperationGate.isCurrent(operation)) return;
      setComparisonModel(null);
      setComparisonBaseline(null);
      setState({ status: "receiver", document: receiverDocument, fileName: file.name });
      setEvidenceOpenState({ status: "idle" });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".workspace-heading")?.focus({ preventScroll: true });
      }));
    } catch (cause) {
      if (!sessionOperationGate.isCurrent(operation)) return;
      const error = cause instanceof EvidenceBundleLoadError
        ? cause
        : new EvidenceBundleLoadError(
            "WORKER_FAILURE",
            "ReplayCase could not verify the selected evidence bundle.",
            file.name,
            [cause instanceof Error ? cause.message : "Unknown evidence verification error."],
          );
      setEvidenceOpenState({ status: "error", fileName: file.name, error });
    }
  };

  const openSavedSession = useCallback(async (identity: string) => {
    if (state.status !== "ready") return;
    replayProcessingControllerRef.current?.abort();
    libraryProcessingControllerRef.current?.abort();
    const controller = new AbortController();
    libraryProcessingControllerRef.current = controller;
    const libraryOperation = libraryOperationGate.begin();
    const sessionOperation = sessionOperationGate.begin();
    const entry = libraryEntries.find((candidate) => candidate.identity === identity);
    const source: ReplayProcessingSource = {
      kind: "library",
      identity,
      name: entry?.title ?? "Saved replay",
      size: entry?.byteLength ?? 0,
    };
    setPendingDeleteIdentity(null);
    setLibraryAction({ kind: "opening", identity });
    setLibraryError(null);
    setReplayProcessingState({
      status: "processing",
      source,
      progress: processingProgress("reading", 0, source.size),
    });
    try {
      const session = await sessionLibrary.load(identity, {
        signal: controller.signal,
        onProgress(progress) {
          if (
            libraryOperationGate.isCurrent(libraryOperation)
            && sessionOperationGate.isCurrent(sessionOperation)
          ) {
            setReplayProcessingState({ status: "processing", source, progress });
          }
        },
      });
      if (!libraryOperationGate.isCurrent(libraryOperation) || !sessionOperationGate.isCurrent(sessionOperation)) return;
      setComparisonModel(null);
      setComparisonBaseline(null);
      setActiveLibraryIdentity(identity);
      setState({ status: "ready", session });
      setReplayProcessingState({ status: "idle" });
      announceLibrary(`${session.document.title} reopened from the local library`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".workspace-heading")?.focus({ preventScroll: true });
      }));
    } catch (cause) {
      if (!libraryOperationGate.isCurrent(libraryOperation) || !sessionOperationGate.isCurrent(sessionOperation)) return;
      if (cause instanceof SessionProcessingCancelledError) {
        setReplayProcessingState({ status: "idle" });
        announceLibrary("Replay processing canceled; the open workspace was not changed");
        return;
      }
      setLibraryError(sessionLibraryErrorMessage(cause));
      setReplayProcessingState({
        status: "error",
        source,
        error: new SessionLoadError("The saved replay could not be opened.", [
          sessionLibraryErrorMessage(cause),
        ]),
      });
      if (cause instanceof SessionLibraryError && cause.code === "not-found") {
        setLibraryEntries((current) => current.filter((entry) => entry.identity !== identity));
      }
      if (cause instanceof SessionLibraryError && cause.code === "unavailable") setLibraryStatus("unavailable");
    } finally {
      if (libraryProcessingControllerRef.current === controller) {
        libraryProcessingControllerRef.current = null;
      }
      if (libraryOperationGate.isCurrent(libraryOperation)) setLibraryAction({ kind: "idle" });
    }
  }, [announceLibrary, libraryEntries, libraryOperationGate, sessionLibrary, sessionOperationGate, state]);

  const removeSavedSession = useCallback(async (identity: string) => {
    const operation = libraryOperationGate.begin();
    setLibraryAction({ kind: "removing", identity });
    setLibraryError(null);
    const removedIndex = libraryEntries.findIndex((entry) => entry.identity === identity);
    const nextFocusIdentity = libraryEntries[removedIndex + 1]?.identity
      ?? libraryEntries[removedIndex - 1]?.identity
      ?? null;
    const removesActiveWorkspace = state.status === "ready" && activeLibraryIdentity === identity;
    let workspaceSession = removesActiveWorkspace && state.status === "ready" ? state.session : null;
    let workspaceLookupFailed = false;
    if (workspaceSession === null) {
      try {
        workspaceSession = await sessionLibrary.load(identity);
      } catch {
        workspaceLookupFailed = true;
      }
    }
    if (!libraryOperationGate.isCurrent(operation)) return;
    try {
      await sessionLibrary.remove(identity);
      if (!libraryOperationGate.isCurrent(operation)) return;
      const removed = libraryEntries.find((entry) => entry.identity === identity);
      const workspaceCleared = workspaceSession === null
        ? false
        : clearSessionWorkspace(sessionWorkspaceStorageIdentity(workspaceSession));
      setLibraryEntries((current) => current.filter((entry) => entry.identity !== identity));
      setActiveLibraryIdentity((current) => current === identity ? null : current);
      setPendingDeleteIdentity(null);
      announceLibrary(`${removed?.title ?? "Session"} removed from the local library`);
      if (removesActiveWorkspace && workspaceSession !== null) {
        issueWorkspacePersistenceCommand(workspaceSession, "clear");
      }
      if (workspaceLookupFailed || !workspaceCleared) {
        setLibraryError("The replay was removed, but its separately stored operator workspace could not be fully cleared. Browser storage may still contain markers, notes, or incident ranges.");
      }
      scheduleSavedSessionFocus(nextFocusIdentity);
    } catch (cause) {
      if (!libraryOperationGate.isCurrent(operation)) return;
      setLibraryError(sessionLibraryErrorMessage(cause));
      if (cause instanceof SessionLibraryError && cause.code === "not-found") {
        setLibraryEntries((current) => current.filter((entry) => entry.identity !== identity));
        setActiveLibraryIdentity((current) => current === identity ? null : current);
        setPendingDeleteIdentity(null);
        scheduleSavedSessionFocus(nextFocusIdentity);
      }
      if (cause instanceof SessionLibraryError && cause.code === "unavailable") setLibraryStatus("unavailable");
    } finally {
      if (libraryOperationGate.isCurrent(operation)) setLibraryAction({ kind: "idle" });
    }
  }, [activeLibraryIdentity, announceLibrary, issueWorkspacePersistenceCommand, libraryEntries, libraryOperationGate, sessionLibrary, state]);

  const libraryController: SessionLibraryController = {
    entries: libraryEntries,
    status: libraryStatus,
    action: libraryAction,
    activeIdentity: activeLibraryIdentity,
    pendingDeleteIdentity,
    error: libraryError,
    notice: libraryNotice,
    onSaveCurrent: () => { if (state.status === "ready") void persistSession(state.session, "Session saved to the local library", true); },
    onRetry: () => { void refreshLibrary(); },
    onOpen: (identity) => { void openSavedSession(identity); },
    onRequestDelete: setPendingDeleteIdentity,
    onCancelDelete: () => setPendingDeleteIdentity(null),
    onConfirmDelete: (identity) => { void removeSavedSession(identity); },
  };

  const startSessionComparison = useCallback((session: ParsedSession, incident: IncidentProjection) => {
    setComparisonBaseline(createSessionComparisonSource(session, incident));
  }, []);
  const startReceiverComparison = useCallback((document: ReceiverDocument) => {
    setComparisonBaseline(createReceiverComparisonSource(document));
  }, []);
  const openComparison = useCallback((model: ComparisonModel) => {
    setComparisonModel(model);
    setComparisonBaseline(null);
  }, []);
  const returnFromComparison = useCallback(() => {
    setComparisonModel(null);
    setComparisonBaseline(null);
  }, []);

  return (
    <>
      <input ref={fileInputRef} className="visually-hidden" type="file" tabIndex={-1} aria-label="Choose a local ReplayCase replay" accept=".json,.nlsession,application/json" onChange={(event) => void handleFile(event)} />
      <input ref={evidenceInputRef} className="visually-hidden" type="file" tabIndex={-1} aria-label="Choose a ReplayCase evidence bundle" accept=".nlb,application/zip" onChange={(event) => void handleEvidenceFile(event)} />
      <div hidden={casesVisible}>
      {comparisonModel != null ? (
        <ComparisonWorkspace
          key={comparisonWorkspaceKey(comparisonModel)}
          model={comparisonModel}
          onOpenCases={openCases}
          onNewComparison={() => setComparisonBaseline(comparisonModel.baseline)}
          onReturn={returnFromComparison}
          onOpenReplay={openReplay}
          onOpenBundle={openEvidence}
        />
      ) : (
        <>
          {state.status === "loading" && <LoadingScreen message={state.message} progress={state.progress} />}
          {state.status === "error" && <ErrorScreen error={state.error} onRetry={() => void loadDefault()} onOpenReplay={openReplay} onOpenBundle={openEvidence} />}
          {state.status === "ready" && <Workspace onOpenCases={openCases} key={sessionWorkspaceKey(state.session)} session={state.session} onOpenReplay={openReplay} onOpenBundle={openEvidence} onOpenCapture={() => setCaptureDialogOpen(true)} onCompare={startSessionComparison} library={libraryController} workspacePersistenceCommand={workspacePersistenceCommand} />}
          {state.status === "receiver" && <ReceiverWorkspace onOpenCases={openCases} key={state.document.bundle.sha256} document={state.document} fileName={state.fileName} onOpenBundle={openEvidence} onOpenReplay={openReplay} onLoadBundledReplay={() => void loadDefault()} onCompare={startReceiverComparison} />}
        </>
      )}
      {captureDialogOpen && comparisonModel == null && <CaptureDialog operatorRuntime={operatorRuntime} displayTimeZone={state.status === "ready" ? state.session.document.displayTimeZone : undefined} onClose={() => setCaptureDialogOpen(false)} onComplete={completeCapture} />}
      {replayProcessingState.status !== "idle" && <ReplayProcessingDialog state={replayProcessingState} onCancel={cancelReplayProcessing} onRetry={(source) => source.kind === "file" ? void processReplayFile(source.file) : void openSavedSession(source.identity)} onClose={() => setReplayProcessingState({ status: "idle" })} />}
      {evidenceOpenState.status !== "idle" && <EvidenceOpenDialog state={evidenceOpenState} onClose={() => setEvidenceOpenState({ status: "idle" })} />}
      {comparisonBaseline != null && <ComparisonSetupDialog baseline={comparisonBaseline} onClose={() => setComparisonBaseline(null)} onStart={openComparison} />}
      </div>
      {casesOpened && <div ref={caseHostRef} hidden={!casesVisible}><CaseWorkspace onClose={closeCases} /></div>}
    </>
  );
}

function sessionWorkspaceKey(session: ParsedSession): string {
  return sessionWorkspaceIdentity(session);
}

function comparisonWorkspaceKey(model: ComparisonModel): string {
  return [
    model.baseline.identity,
    model.baseline.range.startUs,
    model.baseline.range.endUs,
    model.candidate.identity,
    model.candidate.range.startUs,
    model.candidate.range.endUs,
    model.alignment.mode,
    model.alignment.label,
    model.alignment.baselineAnchorUs,
    model.alignment.candidateAnchorUs,
  ].join(":");
}
