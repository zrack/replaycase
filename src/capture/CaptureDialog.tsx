import {
  useEffect,
  useId,
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
  DownloadSimple,
  FloppyDisk,
  SpinnerGap,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import type { CaptureIntegrityIssueCode, CaptureIntegrityReceipt, SessionDocument, UdpBridgeJournal } from "../domain/types";
import {
  BUILT_IN_DECODER_PACKS,
  NSL01_DECODER_PACK,
} from "../domain/decoder";
import { verifyDecoderPackConformance } from "../domain/decoder-conformance";
import {
  MAX_DECODER_PACK_BYTES,
  parseBoundedDecoderPackJson,
  type DecoderPackDocument,
} from "../domain/decoder-pack";
import { serializeSessionDocument } from "../data/session-file";
import { formatBytes, formatDurationUs } from "../lib/time";
import {
  MANUAL_OPERATOR_RUNTIME,
  type OperatorRuntime,
} from "../runtime/operator-runtime";
import {
  clearCaptureProfiles,
  createCaptureProfile,
  loadCaptureProfiles,
  removeCaptureProfile,
  saveCaptureProfile,
  type CaptureProfileDocument,
  type CaptureProfileSettings,
} from "./capture-profile";
import {
  CapturePreflightAnalyzer,
  MAX_PREFLIGHT_ANALYZED_BYTES,
  MAX_PREFLIGHT_ANALYZED_RECORDS,
  type CapturePreflightSummary,
} from "./capture-preflight";
import {
  createSerialAssembler,
  type SerialRecordAssembler,
} from "./serial-assembler";
import {
  CaptureRecorder,
  CaptureRecorderError,
  MAX_CAPTURE_BYTES,
  MAX_CAPTURE_RECORDS,
  type CaptureFinalizationEvidence,
  type CaptureTransportProvenanceEvidence,
  type CapturedBytes,
  type TransportEventDraft,
} from "./recorder";
import {
  DEFAULT_UDP_BRIDGE_URL,
  UdpBridgeClient,
  UdpBridgeProtocolError,
  type UdpBridgeDatagram,
  type UdpBridgeErrorDetail,
  type UdpBridgeStatus,
  type UdpCaptureLifecycleJournal,
} from "./udp-bridge";
import {
  getBrowserSerialApi,
  WebSerialCapture,
  type SerialCaptureHandlers,
  type SerialFlowControl,
  type SerialCaptureDevice,
  type SerialParity,
} from "./web-serial";

type CaptureTransport = "udp" | "serial";
type CapturePhase =
  | "ready"
  | "starting"
  | "preflighting"
  | "canceling"
  | "capturing"
  | "stopping"
  | "saving"
  | "save-error"
  | "finalize-error";
type CaptureStartingPurpose = "preflight" | "recording";
type SerialConnectionState = "idle" | "selecting" | "open" | "disconnected" | "closed" | "error";

interface CaptureTotals {
  inputUnits: number;
  inputBytes: number;
  records: number;
  recordedBytes: number;
}

interface PendingUdpRecorderConfig {
  sessionId: string;
  title: string;
  displayTimeZone: string;
  decoderPack: DecoderPackDocument;
}

interface PendingFinalization {
  durationUs: number;
  incompleteReason: string | null;
  evidence: CaptureFinalizationEvidence;
}

export interface CaptureDialogProps {
  onClose: () => void;
  onComplete: (session: SessionDocument) => void | Promise<void>;
  displayTimeZone?: string;
  operatorRuntime?: OperatorRuntime;
}

const EMPTY_TOTALS: CaptureTotals = Object.freeze({
  inputUnits: 0,
  inputBytes: 0,
  records: 0,
  recordedBytes: 0,
});

const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function nowMonotonicMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function monotonicCaptureDurationUs(
  captureStartMs: number,
  currentMs: number,
  lastObservedUs: number,
  bridgeDurationUs = 0,
): number {
  const wallDurationUs = captureStartMs > 0
    ? Math.max(0, Math.floor((currentMs - captureStartMs) * 1_000))
    : 0;
  return Math.max(0, lastObservedUs, bridgeDurationUs, wallDurationUs);
}

export function verifiedCaptureDurationUs(input: {
  frozenDurationUs: number;
  bridgeDurationUs?: number;
  bridgeDatagrams?: number;
  lastRetainedOffsetUs: number;
}): number {
  const bridgeEndUs = (input.bridgeDurationUs ?? 0) + ((input.bridgeDatagrams ?? 0) > 0 ? 1 : 0);
  return Math.max(1, input.frozenDurationUs, bridgeEndUs, input.lastRetainedOffsetUs + 1);
}

export function boundFinalizationDuration(
  requestedDurationUs: number,
  maximumDurationUs: number,
): { durationUs: number; wasCapped: boolean } {
  return requestedDurationUs > maximumDurationUs
    ? { durationUs: maximumDurationUs, wasCapped: true }
    : { durationUs: requestedDurationUs, wasCapped: false };
}

export interface CaptureFinalizationSnapshot {
  transport: CaptureTransport;
  durationUs: number;
  stopDisposition: CaptureIntegrityReceipt["stopDisposition"];
  eventLogComplete: boolean;
  observedUnits: number;
  observedBytes: number;
  transportReportedUnits: number | null;
  transportReportedBytes: number | null;
  issueCodes?: readonly CaptureIntegrityIssueCode[];
  shutdown?: CaptureFinalizationEvidence["shutdown"];
  transportProvenance?: CaptureTransportProvenanceEvidence;
}

/**
 * Preserves the evidence actually observed at stop. In particular, a missing
 * UDP terminal status remains null rather than being replaced by browser-side
 * counters that cannot certify bridge reconciliation.
 */
export function captureFinalizationEvidence(
  snapshot: CaptureFinalizationSnapshot,
): CaptureFinalizationEvidence {
  const stopDisposition = snapshot.stopDisposition === "not-observed"
    ? "unconfirmed"
    : snapshot.stopDisposition;
  return {
    stopDisposition,
    stopOffsetUs: snapshot.durationUs,
    eventLogComplete: snapshot.eventLogComplete,
    observedUnits: snapshot.observedUnits,
    observedBytes: snapshot.observedBytes,
    transportReportedUnits: snapshot.transport === "udp" ? snapshot.transportReportedUnits : null,
    transportReportedBytes: snapshot.transport === "udp" ? snapshot.transportReportedBytes : null,
    issueCodes: snapshot.issueCodes,
    shutdown: snapshot.shutdown,
    transportProvenance: snapshot.transportProvenance,
  };
}

export function ownedUdpCaptureJournal(
  status: UdpBridgeStatus,
  captureId: string,
): UdpBridgeJournal | null {
  const journal: UdpCaptureLifecycleJournal | null | undefined = status.captureJournal;
  if (!journal || journal.captureId !== captureId || status.capture?.id !== captureId) return null;
  return {
    captureId: journal.captureId,
    startedAt: journal.startedAt,
    endedAt: journal.endedAt,
    state: journal.state,
    bind: { ...journal.bind },
    multicast: journal.multicast ? { ...journal.multicast } : null,
    datagrams: journal.datagrams,
    bytes: journal.bytes,
    kernelDroppedDatagrams: journal.kernelDroppedDatagrams,
    kernelDroppedDatagramsSource: journal.kernelDroppedDatagramsSource,
    entriesComplete: journal.entriesComplete,
    omittedEntries: journal.omittedEntries,
    entries: journal.entries.map((entry) => ({ ...entry })),
  };
}

export function serialCaptureProvenance(
  device: SerialCaptureDevice,
  settings: Extract<CaptureTransportProvenanceEvidence, { transport: "serial" }>["settings"],
): Extract<CaptureTransportProvenanceEvidence, { transport: "serial" }> {
  return {
    transport: "serial",
    device: {
      usbVendorId: device.info.usbVendorId ?? null,
      usbProductId: device.info.usbProductId ?? null,
      bluetoothServiceClassId: device.info.bluetoothServiceClassId ?? null,
    },
    settings: { ...settings },
  };
}

export type CapturedInputOrigin = "live" | "pre-status-buffer" | "serial-tail";

export function canRetainCapturedInput(
  inputClosed: boolean,
  ingestPaused: boolean,
  origin: CapturedInputOrigin = "live",
): boolean {
  if (origin === "pre-status-buffer") return !inputClosed;
  if (origin === "serial-tail") return !ingestPaused;
  return !inputClosed && !ingestPaused;
}

export function retainSerialAssemblerTail(
  assembler: SerialRecordAssembler,
  append: (input: CapturedBytes, origin: "serial-tail") => boolean,
): { records: number; bytes: number } {
  let records = 0;
  let bytes = 0;
  for (const assembly of assembler.finish()) {
    if (!append({ offsetUs: assembly.offsetUs, bytes: assembly.bytes }, "serial-tail")) continue;
    records += 1;
    bytes += assembly.bytes.byteLength;
  }
  return { records, bytes };
}

export function flushOwnedBufferedUdpDatagrams(
  pending: readonly UdpBridgeDatagram[],
  ownedCaptureId: string,
  accept: (datagram: UdpBridgeDatagram, allowPausedRetention: boolean) => boolean,
): { observed: number; retained: number } {
  let observed = 0;
  let retained = 0;
  let bufferedRetentionAvailable = true;
  for (const datagram of pending) {
    if (datagram.captureId !== ownedCaptureId) continue;
    observed += 1;
    const didRetain = accept(datagram, bufferedRetentionAvailable);
    if (didRetain) retained += 1;
    else bufferedRetentionAvailable = false;
  }
  return { observed, retained };
}

export function ensureDurationLimitTransportEvent(
  recorder: CaptureRecorder,
  input: {
    alreadyRecorded: boolean;
    transport: CaptureTransport;
    maximumDurationUs: number;
    observedDurationUs: number;
    message: string;
  },
): boolean {
  if (input.alreadyRecorded) return true;
  return recorder.appendTerminalTransportEvent({
    type: "capture-limit",
    transport: input.transport,
    scope: { kind: "session" },
    severity: "critical",
    message: input.message.slice(0, 1_000),
    component: "recorder",
    limit: "duration",
    limitValue: input.maximumDurationUs,
    observedValue: input.observedDurationUs,
  }) !== null;
}

function isDurationLimitEvent(event: TransportEventDraft): boolean {
  return event.type === "capture-limit" && event.limit === "duration";
}

function createSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `capture-${Date.now().toString(36)}-${random}`;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

function udpErrorMessage(error: UdpBridgeErrorDetail | UdpBridgeProtocolError): string {
  if (error instanceof UdpBridgeProtocolError) return `${error.message} (${error.code})`;
  return `${error.message} (${error.code}${error.fatal ? ", fatal" : ""})`;
}

export function udpSequenceDiscontinuityEvent(
  datagram: Pick<UdpBridgeDatagram, "offsetUs" | "sequence">,
  expectedSequence: number,
): TransportEventDraft {
  return {
    type: "udp-event-sequence-discontinuity",
    transport: "udp",
    scope: { kind: "point", offsetUs: datagram.offsetUs },
    severity: "critical",
    message: `UDP event-stream sequence ${datagram.sequence} arrived where ${expectedSequence} was expected.`,
    expectedSequence,
    observedSequence: datagram.sequence,
  };
}

export function serialTransportFailureEvent(
  type: "serial-read-error" | "serial-disconnected" | "serial-tail-recovery-failed",
  offsetUs: number,
  message: string,
  code: string,
): TransportEventDraft {
  return {
    type,
    transport: "serial",
    scope: { kind: "point", offsetUs },
    severity: "critical",
    message: message.slice(0, 1_000),
    code: code.slice(0, 128),
  };
}

export class UdpCaptureOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UdpCaptureOwnershipError";
  }
}

export class UdpCaptureIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UdpCaptureIntegrityError";
  }
}

interface UdpStopClient {
  getStatus(): Promise<UdpBridgeStatus>;
  stop(): Promise<UdpBridgeStatus>;
}

export interface UdpCaptureIntegritySnapshot {
  observedDatagrams: number;
  observedBytes: number;
  retainedRecords: number;
  retainedBytes: number;
  lastSequence: number;
  sequenceIssue: string | null;
}

/**
 * Refreshes status before issuing the global bridge stop command. The command
 * is never sent unless the currently reported capture ID is the one returned
 * by this dialog's successful start request, and success requires the bridge
 * to confirm that capture is no longer active.
 */
export async function stopUdpCaptureIfOwned(
  client: UdpStopClient,
  ownedCaptureId: string,
): Promise<UdpBridgeStatus> {
  const current = await client.getStatus();
  if (current.capture?.id !== ownedCaptureId) {
    throw new UdpCaptureOwnershipError(
      "The bridge is no longer running this dialog's UDP capture. It was left untouched; verify the bridge before continuing.",
    );
  }
  if (current.state === "stopped" || current.state === "idle") return current;
  const stopped = await client.stop();
  if (stopped.capture?.id !== ownedCaptureId) {
    throw new UdpCaptureOwnershipError(
      "The bridge stop response identified a different capture. Clean save was refused.",
    );
  }
  if (stopped.state !== "stopped" && stopped.state !== "idle") {
    throw new UdpCaptureIntegrityError(
      `The bridge stop response remained in ${stopped.state} state. Capture shutdown was not confirmed.`,
    );
  }
  return stopped;
}

/** Refuses a clean session when bridge, event-stream, or recorder totals differ. */
export function assertUdpCaptureIntegrity(
  status: UdpBridgeStatus,
  ownedCaptureId: string,
  snapshot: UdpCaptureIntegritySnapshot,
): void {
  const capture = status.capture;
  if (!capture || capture.id !== ownedCaptureId) {
    throw new UdpCaptureIntegrityError(
      "UDP capture integrity check failed: the stop response did not identify the capture owned by this dialog. Clean save was refused.",
    );
  }

  const expectedLastSequence = capture.datagrams - 1;
  const failures: string[] = [];
  if (status.state !== "stopped") {
    failures.push(`the bridge ended in ${status.state} state instead of stopped`);
  }
  if (status.lastError?.fatal) {
    failures.push(`the bridge reported fatal ${status.lastError.code}: ${status.lastError.message}`);
  }
  if (snapshot.observedDatagrams !== capture.datagrams) {
    failures.push(`bridge recorded ${capture.datagrams.toLocaleString()} datagrams but the browser received ${snapshot.observedDatagrams.toLocaleString()}`);
  }
  if (snapshot.observedBytes !== capture.bytes) {
    failures.push(`bridge recorded ${capture.bytes.toLocaleString()} bytes but the browser received ${snapshot.observedBytes.toLocaleString()}`);
  }
  if (snapshot.retainedRecords !== snapshot.observedDatagrams) {
    failures.push(`the recorder retained ${snapshot.retainedRecords.toLocaleString()} records for ${snapshot.observedDatagrams.toLocaleString()} received datagrams`);
  }
  if (snapshot.retainedBytes !== snapshot.observedBytes) {
    failures.push(`the recorder retained ${snapshot.retainedBytes.toLocaleString()} of ${snapshot.observedBytes.toLocaleString()} received bytes`);
  }
  if (snapshot.sequenceIssue) failures.push(snapshot.sequenceIssue);
  if (snapshot.lastSequence !== expectedLastSequence) {
    failures.push(`the final SSE sequence was ${snapshot.lastSequence}, expected ${expectedLastSequence}`);
  }
  if (failures.length > 0) {
    throw new UdpCaptureIntegrityError(
      `UDP capture integrity check failed; clean save was refused because ${failures.join("; ")}. Check the local bridge event stream and record a new capture.`,
    );
  }
}

function strictInteger(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`);
  }
  return parsed;
}

function validateTimeZone(value: string): string {
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
  } catch {
    throw new Error("Display timezone must be a valid IANA timezone name, such as America/Los_Angeles.");
  }
  return normalized;
}

function downloadSession(session: SessionDocument): string {
  const json = serializeSessionDocument(session);
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const slug = session.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "capture";
  const timestamp = session.startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const filename = `replaycase-${slug}-${timestamp}.nlsession`;
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  return filename;
}

function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  canClose: boolean,
  onBlockedClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  const onBlockedCloseRef = useRef(onBlockedClose);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;
  onBlockedCloseRef.current = onBlockedClose;

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

    const frame = requestAnimationFrame(() => {
      const initial = dialog.querySelector<HTMLElement>("[data-dialog-focus]")
        ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
        ?? dialog;
      initial.focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (canCloseRef.current) onCloseRef.current();
        else onBlockedCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (appRoot) {
        appRoot.inert = previousInert;
        if (previousAriaHidden == null) appRoot.removeAttribute("aria-hidden");
        else appRoot.setAttribute("aria-hidden", previousAriaHidden);
      }
      opener?.focus({ preventScroll: true });
    };
  }, [dialogRef]);
}

function capturePhaseLabel(
  phase: CapturePhase,
  transport: CaptureTransport,
  issue: string,
  startingPurpose: CaptureStartingPurpose,
  preflight: CapturePreflightSummary | null,
): string {
  if (phase === "starting") {
    if (startingPurpose === "recording") return "Establishing evidence boundary";
    return transport === "udp" ? "Opening UDP preflight" : "Selecting serial device";
  }
  if (phase === "preflighting") {
    if (preflight?.readiness === "ready") return "Preflight ready";
    if (preflight?.readiness === "attention") return "Preflight needs attention";
    return "Preflight waiting for traffic";
  }
  if (phase === "canceling") return "Capture setup cancelled";
  if (phase === "capturing") return issue ? "Recording with attention required" : "Recording";
  if (phase === "stopping") return "Stopping transport";
  if (phase === "saving") return "Saving local session";
  if (phase === "save-error") return "Finalized session awaiting download";
  if (phase === "finalize-error") return "Retained capture awaiting recovery";
  return "Ready";
}

export function CaptureDialog({
  onClose,
  onComplete,
  displayTimeZone,
  operatorRuntime = MANUAL_OPERATOR_RUNTIME,
}: CaptureDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const udpTabRef = useRef<HTMLButtonElement>(null);
  const serialTabRef = useRef<HTMLButtonElement>(null);
  const captureStatusRef = useRef<HTMLDivElement>(null);
  const discardTriggerRef = useRef<HTMLButtonElement>(null);
  const discardKeepRef = useRef<HTMLButtonElement>(null);
  const decoderPackInputRef = useRef<HTMLInputElement>(null);
  const profileNameInputRef = useRef<HTMLInputElement>(null);
  const transportRef = useRef<CaptureTransport | null>(null);
  const startingPurposeRef = useRef<CaptureStartingPurpose>("preflight");
  const recorderRef = useRef<CaptureRecorder | null>(null);
  const udpClientRef = useRef<UdpBridgeClient | null>(null);
  const udpStatusRef = useRef<UdpBridgeStatus | null>(null);
  const udpCaptureJournalRef = useRef<UdpBridgeJournal | null>(null);
  const udpRecorderConfigRef = useRef<PendingUdpRecorderConfig | null>(null);
  // Set only from this dialog's successful POST /start response.
  const ownedUdpCaptureIdRef = useRef<string | null>(null);
  const pendingUdpDatagramsRef = useRef<UdpBridgeDatagram[]>([]);
  const pendingUdpBytesRef = useRef(0);
  const observedUdpDatagramsRef = useRef(0);
  const observedUdpBytesRef = useRef(0);
  const lastUdpSequenceRef = useRef(-1);
  const udpSequenceIssueRef = useRef<string | null>(null);
  const transportIntegrityIssueRef = useRef<string | null>(null);
  const pendingTransportEventsRef = useRef<TransportEventDraft[]>([]);
  const recordedUdpErrorKeysRef = useRef<Set<string>>(new Set());
  const transportEventLogCompleteRef = useRef(true);
  const transportReportedUnitsRef = useRef<number | null>(null);
  const transportReportedBytesRef = useRef<number | null>(null);
  const stopDispositionRef = useRef<"confirmed" | "unconfirmed" | "not-observed">("not-observed");
  const shutdownEvidenceRef = useRef<{ code: string; message: string } | undefined>(undefined);
  const finalizationIssueCodesRef = useRef<CaptureIntegrityIssueCode[]>([]);
  const durationLimitEventRecordedRef = useRef(false);
  const serialCaptureRef = useRef<WebSerialCapture | null>(null);
  const serialPreflightDeviceRef = useRef<SerialCaptureDevice | null>(null);
  const serialPreflightSettingsRef = useRef<Extract<CaptureTransportProvenanceEvidence, { transport: "serial" }>["settings"] | null>(null);
  const serialPreflightAssemblerRef = useRef<SerialRecordAssembler | null>(null);
  const serialProvenanceRef = useRef<Extract<CaptureTransportProvenanceEvidence, { transport: "serial" }> | null>(null);
  const serialAssemblerRef = useRef<SerialRecordAssembler | null>(null);
  const serialDisconnectedRef = useRef(false);
  const observedSerialReadsRef = useRef(0);
  const observedSerialBytesRef = useRef(0);
  const captureStartMsRef = useRef(0);
  const lastDurationUsRef = useRef(0);
  const lastRetainedOffsetUsRef = useRef(-1);
  const verifiedStopDurationUsRef = useRef(0);
  const durationFrozenRef = useRef(false);
  const frozenDurationUsRef = useRef(0);
  const captureInputClosedRef = useRef(false);
  const ingestPausedRef = useRef(false);
  const finalizingRef = useRef(false);
  const startCancelledRef = useRef(false);
  const pendingFinalizedSessionRef = useRef<SessionDocument | null>(null);
  const pendingFinalizationRef = useRef<PendingFinalization | null>(null);
  const preflightAnalyzerRef = useRef<CapturePreflightAnalyzer | null>(null);
  const preflightConnectedRef = useRef(false);
  const mountedRef = useRef(true);

  const id = useId().replace(/:/g, "");
  const titleId = `capture-dialog-title-${id}`;
  const descriptionId = `capture-dialog-description-${id}`;
  const statusId = `capture-status-${id}`;
  const errorId = `capture-error-${id}`;
  const udpPanelId = `capture-udp-panel-${id}`;
  const serialPanelId = `capture-serial-panel-${id}`;
  const udpTabId = `capture-udp-tab-${id}`;
  const serialTabId = `capture-serial-tab-${id}`;
  const profileEditorId = `capture-profile-editor-${id}`;

  const [transport, setTransport] = useState<CaptureTransport>("udp");
  const [phase, setPhase] = useState<CapturePhase>("ready");
  const previousPhaseRef = useRef<CapturePhase>(phase);
  const [sessionTitle, setSessionTitle] = useState("Live telemetry capture");
  const [timeZone, setTimeZone] = useState(displayTimeZone ?? browserTimeZone());
  const [localDecoderPack, setLocalDecoderPack] = useState<DecoderPackDocument | null>(null);
  const [decoderPack, setDecoderPack] = useState<DecoderPackDocument>(NSL01_DECODER_PACK);
  const managedRuntime = operatorRuntime.mode === "managed" ? operatorRuntime : null;
  const [bridgeUrl, setBridgeUrl] = useState(managedRuntime?.controlUrl ?? DEFAULT_UDP_BRIDGE_URL);
  const [bridgeToken, setBridgeToken] = useState("");
  const [udpHost, setUdpHost] = useState(managedRuntime?.defaults.host ?? "127.0.0.1");
  const [udpPort, setUdpPort] = useState(String(managedRuntime?.defaults.port ?? 9_104));
  const [multicastGroup, setMulticastGroup] = useState(managedRuntime?.defaults.multicastGroup ?? "");
  const [multicastInterface, setMulticastInterface] = useState(managedRuntime?.defaults.multicastInterface ?? "");
  const [baudRate, setBaudRate] = useState("115200");
  const [dataBits, setDataBits] = useState<"7" | "8">("8");
  const [stopBits, setStopBits] = useState<"1" | "2">("1");
  const [parity, setParity] = useState<SerialParity>("none");
  const [flowControl, setFlowControl] = useState<SerialFlowControl>("none");
  const [totals, setTotals] = useState<CaptureTotals>(EMPTY_TOTALS);
  const [udpStatus, setUdpStatus] = useState<UdpBridgeStatus | null>(null);
  const [serialState, setSerialState] = useState<SerialConnectionState>("idle");
  const [serialDevice, setSerialDevice] = useState("Not selected");
  const [issue, setIssue] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [profiles, setProfiles] = useState<CaptureProfileDocument[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileStorageIssue, setProfileStorageIssue] = useState("");
  const [preflightSummary, setPreflightSummary] = useState<CapturePreflightSummary | null>(null);
  const [timerTick, setTimerTick] = useState(0);

  const captureLocked = phase !== "ready";
  const decoderPacks = useMemo(() => {
    if (
      localDecoderPack == null
      || BUILT_IN_DECODER_PACKS.some((pack) => pack.integrity.canonicalSha256 === localDecoderPack.integrity.canonicalSha256)
    ) {
      return [...BUILT_IN_DECODER_PACKS];
    }
    return [...BUILT_IN_DECODER_PACKS, localDecoderPack];
  }, [localDecoderPack]);
  const canDismiss = phase === "ready" || phase === "canceling";
  const serialAvailable = useMemo(() => getBrowserSerialApi() != null, []);
  const elapsedUs = (() => {
    if (phase === "preflighting" || (phase === "starting" && startingPurposeRef.current === "preflight")) {
      return Math.floor((preflightSummary?.elapsedMs ?? 0) * 1_000);
    }
    if (durationFrozenRef.current) return frozenDurationUsRef.current;
    if (captureStartMsRef.current === 0) return lastDurationUsRef.current;
    if (transportRef.current === "udp") {
      return monotonicCaptureDurationUs(
        captureStartMsRef.current,
        nowMonotonicMs(),
        lastDurationUsRef.current,
        udpStatus?.capture?.durationUs ?? 0,
      );
    }
    if (phase === "capturing" || phase === "starting") {
      return monotonicCaptureDurationUs(captureStartMsRef.current, nowMonotonicMs(), lastDurationUsRef.current);
    }
    return lastDurationUsRef.current;
  })();
  void timerTick;

  useEffect(() => {
    try {
      setProfiles(loadCaptureProfiles());
      setProfileStorageIssue("");
    } catch (cause) {
      setProfileStorageIssue(errorMessage(cause, "Saved capture profiles could not be loaded."));
    }
  }, []);

  const markConfigurationChanged = (): void => {
    setProfileDirty(selectedProfileId !== "");
    setPreflightSummary(null);
    setIssue("");
    setNotice("");
  };

  const markConnectionChanged = (): void => {
    setPreflightSummary(null);
    setIssue("");
    setNotice("");
  };

  const selectDecoderPack = (packHash: string): void => {
    const selected = decoderPacks.find((pack) => pack.integrity.canonicalSha256 === packHash);
    if (!selected || captureLocked) return;
    setDecoderPack(selected);
    markConfigurationChanged();
  };

  const loadDecoderPack = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || captureLocked) return;
    setIssue("");
    setNotice("");
    try {
      if (file.size > MAX_DECODER_PACK_BYTES) {
        throw new Error(`Decoder pack files cannot exceed ${formatBytes(MAX_DECODER_PACK_BYTES)}.`);
      }
      const text = await file.text();
      const input = parseBoundedDecoderPackJson(text);
      const result = verifyDecoderPackConformance(input);
      setLocalDecoderPack(result.pack);
      setDecoderPack(result.pack);
      setProfileDirty(selectedProfileId !== "");
      setPreflightSummary(null);
      setNotice(
        `Loaded ${result.pack.displayName} ${result.pack.revision}; ${result.fixtureIds.length} fixture${result.fixtureIds.length === 1 ? "" : "s"} passed.`,
      );
    } catch (cause) {
      setIssue(errorMessage(cause, "The decoder pack could not be loaded."));
    }
  };

  const profileSettings = (): CaptureProfileSettings => {
    if (transport === "udp") {
      return {
        transport: "udp",
        host: udpHost.trim(),
        port: strictInteger(udpPort, "UDP port", 0, 65_535),
        multicastGroup: multicastGroup.trim() || null,
        multicastInterface: multicastInterface.trim() || null,
      };
    }
    return {
      transport: "serial",
      baudRate: strictInteger(baudRate, "Baud rate", 1, 4_000_000),
      dataBits: Number(dataBits) as 7 | 8,
      stopBits: Number(stopBits) as 1 | 2,
      parity,
      flowControl,
    };
  };

  const applyProfile = (profileId: string): void => {
    if (captureLocked) return;
    if (!profileId) {
      setSelectedProfileId("");
      setProfileDirty(false);
      setProfileEditorOpen(false);
      setIssue("");
      setNotice("");
      return;
    }
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return;
    const pack = verifyDecoderPackConformance(profile.decoderPack).pack;
    setDecoderPack(pack);
    if (!BUILT_IN_DECODER_PACKS.some(
      (candidate) => candidate.integrity.canonicalSha256 === pack.integrity.canonicalSha256,
    )) {
      setLocalDecoderPack(pack);
    }
    setTransport(profile.settings.transport);
    if (profile.settings.transport === "udp") {
      setUdpHost(profile.settings.host);
      setUdpPort(String(profile.settings.port));
      setMulticastGroup(profile.settings.multicastGroup ?? "");
      setMulticastInterface(profile.settings.multicastInterface ?? "");
    } else {
      setBaudRate(String(profile.settings.baudRate));
      setDataBits(String(profile.settings.dataBits) as "7" | "8");
      setStopBits(String(profile.settings.stopBits) as "1" | "2");
      setParity(profile.settings.parity);
      setFlowControl(profile.settings.flowControl);
    }
    setSelectedProfileId(profile.id);
    setProfileName(profile.name);
    setProfileDirty(false);
    setProfileEditorOpen(false);
    setPreflightSummary(null);
    setIssue("");
    setNotice(`Loaded ${profile.name}. Bridge credentials and session naming remain operator-entered.`);
  };

  const openProfileEditor = (): void => {
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    setProfileName(
      selected?.name
      ?? `${transport === "udp" ? "UDP" : "Serial"} · ${decoderPack.displayName}`,
    );
    setProfileEditorOpen(true);
    requestAnimationFrame(() => profileNameInputRef.current?.focus({ preventScroll: true }));
  };

  const persistProfile = (): void => {
    if (captureLocked) return;
    try {
      const existing = profiles.find((profile) => profile.id === selectedProfileId);
      const now = new Date().toISOString();
      const profile = createCaptureProfile({
        ...(existing ? { id: existing.id, createdAt: existing.createdAt } : {}),
        name: profileName,
        updatedAt: now,
        decoderPack,
        settings: profileSettings(),
      });
      const next = saveCaptureProfile(profile);
      setProfiles(next);
      setSelectedProfileId(profile.id);
      setProfileName(profile.name);
      setProfileDirty(false);
      setProfileEditorOpen(false);
      setProfileStorageIssue("");
      setIssue("");
      setNotice(`${profile.name} was saved locally without bridge credentials, device permissions, or telemetry payloads.`);
    } catch (cause) {
      setProfileStorageIssue(errorMessage(cause, "The capture profile could not be saved."));
    }
  };

  const deleteSelectedProfile = (): void => {
    if (captureLocked || !selectedProfileId) return;
    const selected = profiles.find((profile) => profile.id === selectedProfileId);
    try {
      setProfiles(removeCaptureProfile(selectedProfileId));
      setSelectedProfileId("");
      setProfileDirty(false);
      setProfileEditorOpen(false);
      setProfileStorageIssue("");
      setNotice(`${selected?.name ?? "The capture profile"} was removed. Current field values were kept.`);
    } catch (cause) {
      setProfileStorageIssue(errorMessage(cause, "The capture profile could not be removed."));
    }
  };

  const resetProfileStorage = (): void => {
    try {
      clearCaptureProfiles();
      setProfiles([]);
      setSelectedProfileId("");
      setProfileDirty(false);
      setProfileEditorOpen(false);
      setProfileStorageIssue("");
      setNotice("Saved capture profiles were reset. Current capture settings were not changed.");
    } catch (cause) {
      setProfileStorageIssue(errorMessage(cause, "Saved capture profiles could not be reset."));
    }
  };

  const blockedClose = () => setNotice(
    phase === "preflighting"
      ? "Stop the preflight source before closing this dialog."
      : "Stop and save the capture, or explicitly discard it, before closing this dialog.",
  );
  useDialogFocus(dialogRef, onClose, canDismiss, blockedClose);

  useEffect(() => {
    if (previousPhaseRef.current === phase) return;
    previousPhaseRef.current = phase;
    const frame = requestAnimationFrame(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>(`[data-capture-phase-focus="${phase}"]`);
      (preferred ?? captureStatusRef.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase !== "starting" && phase !== "preflighting" && phase !== "capturing") return;
    const flush = () => {
      const preflightAnalyzer = preflightAnalyzerRef.current;
      if (preflightAnalyzer && (phase === "preflighting" || startingPurposeRef.current === "preflight")) {
        setPreflightSummary(preflightAnalyzer.snapshot(nowMonotonicMs(), preflightConnectedRef.current));
      }
      const activeTransport = transportRef.current;
      const recorder = recorderRef.current;
      setTotals({
        inputUnits: activeTransport === "udp" ? observedUdpDatagramsRef.current : observedSerialReadsRef.current,
        inputBytes: activeTransport === "udp" ? observedUdpBytesRef.current : observedSerialBytesRef.current,
        records: recorder?.recordCount ?? 0,
        recordedBytes: recorder?.capturedBytes ?? 0,
      });
      setTimerTick((tick) => tick + 1);
    };
    flush();
    const timer = globalThis.setInterval(flush, 250);
    return () => globalThis.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "starting") return;
    const timeout = globalThis.setTimeout(() => {
      startCancelledRef.current = true;
      setNotice("Source setup timed out. Any late transport open will be closed without recording; dismiss the device chooser if it remains visible.");
      udpClientRef.current?.disconnect();
      setPhase("canceling");
    }, 20_000);
    return () => globalThis.clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (!confirmDiscard) return;
    const frame = requestAnimationFrame(() => discardKeepRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [confirmDiscard]);

  useEffect(() => {
    // React Strict Mode intentionally performs a setup/cleanup/setup cycle in
    // development. Restore this guard in setup so a real mounted dialog keeps
    // receiving asynchronous bridge and serial state updates.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startCancelledRef.current = true;
      const udpClient = udpClientRef.current;
      const ownedCaptureId = ownedUdpCaptureIdRef.current;
      if (udpClient && ownedCaptureId) {
        void stopUdpCaptureIfOwned(udpClient, ownedCaptureId)
          .catch(() => undefined)
          .finally(() => udpClient.disconnect());
      } else {
        udpClient?.disconnect();
      }
      const serialCapture = serialCaptureRef.current;
      if (serialCapture) void serialCapture.stop().catch(() => undefined);
    };
  }, []);

  const resetForStart = (nextTransport: CaptureTransport): void => {
    transportRef.current = nextTransport;
    // The transport establishes the capture epoch: the bridge's startedAt for
    // UDP, and Web Serial's synchronous onOpen callback for serial. Device
    // selection and connection setup are deliberately excluded.
    captureStartMsRef.current = 0;
    lastDurationUsRef.current = 0;
    lastRetainedOffsetUsRef.current = -1;
    verifiedStopDurationUsRef.current = 0;
    durationFrozenRef.current = false;
    frozenDurationUsRef.current = 0;
    captureInputClosedRef.current = false;
    ingestPausedRef.current = false;
    startCancelledRef.current = false;
    pendingFinalizedSessionRef.current = null;
    pendingFinalizationRef.current = null;
    pendingUdpDatagramsRef.current = [];
    pendingUdpBytesRef.current = 0;
    observedUdpDatagramsRef.current = 0;
    observedUdpBytesRef.current = 0;
    observedSerialReadsRef.current = 0;
    observedSerialBytesRef.current = 0;
    ownedUdpCaptureIdRef.current = null;
    lastUdpSequenceRef.current = -1;
    udpSequenceIssueRef.current = null;
    transportIntegrityIssueRef.current = null;
    pendingTransportEventsRef.current = [];
    recordedUdpErrorKeysRef.current = new Set();
    transportEventLogCompleteRef.current = true;
    transportReportedUnitsRef.current = null;
    transportReportedBytesRef.current = null;
    stopDispositionRef.current = "not-observed";
    shutdownEvidenceRef.current = undefined;
    finalizationIssueCodesRef.current = [];
    durationLimitEventRecordedRef.current = false;
    udpCaptureJournalRef.current = null;
    serialProvenanceRef.current = null;
    setTotals(EMPTY_TOTALS);
    setIssue("");
    setNotice("");
    setConfirmDiscard(false);
    setUdpStatus(null);
    udpStatusRef.current = null;
  };

  const resetForPreflight = (nextTransport: CaptureTransport): void => {
    resetForStart(nextTransport);
    const startedAtMs = nowMonotonicMs();
    startingPurposeRef.current = "preflight";
    preflightConnectedRef.current = false;
    preflightAnalyzerRef.current = new CapturePreflightAnalyzer(decoderPack, startedAtMs);
    setPreflightSummary(preflightAnalyzerRef.current.snapshot(startedAtMs, false));
  };

  const clearRuntime = (): void => {
    recorderRef.current = null;
    udpClientRef.current = null;
    udpRecorderConfigRef.current = null;
    ownedUdpCaptureIdRef.current = null;
    lastUdpSequenceRef.current = -1;
    udpSequenceIssueRef.current = null;
    transportIntegrityIssueRef.current = null;
    pendingTransportEventsRef.current = [];
    recordedUdpErrorKeysRef.current = new Set();
    transportEventLogCompleteRef.current = true;
    transportReportedUnitsRef.current = null;
    transportReportedBytesRef.current = null;
    stopDispositionRef.current = "not-observed";
    shutdownEvidenceRef.current = undefined;
    finalizationIssueCodesRef.current = [];
    durationLimitEventRecordedRef.current = false;
    udpCaptureJournalRef.current = null;
    serialProvenanceRef.current = null;
    pendingUdpDatagramsRef.current = [];
    pendingUdpBytesRef.current = 0;
    observedUdpDatagramsRef.current = 0;
    observedUdpBytesRef.current = 0;
    serialCaptureRef.current = null;
    serialPreflightDeviceRef.current = null;
    serialPreflightSettingsRef.current = null;
    serialPreflightAssemblerRef.current = null;
    serialAssemblerRef.current = null;
    serialDisconnectedRef.current = false;
    transportRef.current = null;
    ingestPausedRef.current = false;
    durationFrozenRef.current = false;
    frozenDurationUsRef.current = 0;
    captureInputClosedRef.current = false;
    startCancelledRef.current = false;
    captureStartMsRef.current = 0;
    lastDurationUsRef.current = 0;
    lastRetainedOffsetUsRef.current = -1;
    verifiedStopDurationUsRef.current = 0;
    preflightConnectedRef.current = false;
    preflightAnalyzerRef.current = null;
  };

  const captureEventOffsetUs = (): number => {
    const durationUs = durationFrozenRef.current
      ? frozenDurationUsRef.current
      : monotonicCaptureDurationUs(
          captureStartMsRef.current,
          nowMonotonicMs(),
          lastDurationUsRef.current,
          transportRef.current === "udp" ? udpStatusRef.current?.capture?.durationUs ?? 0 : 0,
        );
    // Session duration is an exclusive boundary, so an event observed at the
    // current edge belongs to the preceding active microsecond.
    return Math.max(0, durationUs - 1);
  };

  const recordTransportEvent = (event: TransportEventDraft): void => {
    const recorder = recorderRef.current;
    if (!recorder) {
      if (pendingTransportEventsRef.current.length < 256) pendingTransportEventsRef.current.push(event);
      else transportEventLogCompleteRef.current = false;
      return;
    }
    const boundedEvent = event.scope.kind === "point" && event.scope.offsetUs >= recorder.limits.maxDurationUs
      ? { ...event, scope: { kind: "point" as const, offsetUs: recorder.limits.maxDurationUs - 1 } } as TransportEventDraft
      : event;
    try {
      const appended = recorder.appendTransportEvent(boundedEvent);
      if (!appended) transportEventLogCompleteRef.current = false;
      else if (isDurationLimitEvent(boundedEvent)) durationLimitEventRecordedRef.current = true;
    } catch {
      transportEventLogCompleteRef.current = false;
      recorder.markEventLogIncomplete();
    }
  };

  const flushPendingTransportEvents = (recorder: CaptureRecorder): void => {
    const pending = pendingTransportEventsRef.current;
    pendingTransportEventsRef.current = [];
    for (const event of pending) {
      const boundedEvent = event.scope.kind === "point" && event.scope.offsetUs >= recorder.limits.maxDurationUs
        ? { ...event, scope: { kind: "point" as const, offsetUs: recorder.limits.maxDurationUs - 1 } } as TransportEventDraft
        : event;
      try {
        const appended = recorder.appendTransportEvent(boundedEvent);
        if (!appended) transportEventLogCompleteRef.current = false;
        else if (isDurationLimitEvent(boundedEvent)) durationLimitEventRecordedRef.current = true;
      } catch {
        transportEventLogCompleteRef.current = false;
        recorder.markEventLogIncomplete();
      }
    }
    if (!transportEventLogCompleteRef.current) recorder.markEventLogIncomplete();
  };

  const recordUdpError = (error: UdpBridgeErrorDetail | UdpBridgeProtocolError): void => {
    if (!ownedUdpCaptureIdRef.current) return;
    const code = error instanceof UdpBridgeProtocolError ? error.code : error.code;
    const message = error.message;
    const fatal = error instanceof UdpBridgeProtocolError ? true : error.fatal;
    const type = error instanceof UdpBridgeProtocolError && error.code === "event-stream-disconnected"
      ? "udp-event-stream-disconnected"
      : "udp-bridge-error";
    const key = `${type}\u0000${code}\u0000${error instanceof UdpBridgeProtocolError ? message : error.at}`;
    if (recordedUdpErrorKeysRef.current.has(key)) return;
    recordedUdpErrorKeysRef.current.add(key);
    recordTransportEvent({
      type,
      transport: "udp",
      scope: { kind: "point", offsetUs: captureEventOffsetUs() },
      severity: fatal ? "critical" : "warning",
      message: message.slice(0, 1_000),
      code: code.slice(0, 128),
      fatal,
    });
  };

  const pauseIngest = (cause: unknown): void => {
    if (ingestPausedRef.current) return;
    ingestPausedRef.current = true;
    const message = errorMessage(cause, "Captured input could not be retained.");
    transportIntegrityIssueRef.current = message;
    const recorderError = cause instanceof CaptureRecorderError ? cause : null;
    if (recorderError?.limit === "duration") durationLimitEventRecordedRef.current = true;
    recordTransportEvent({
      type: recorderError?.limit ? "capture-limit" : "capture-backpressure",
      transport: transportRef.current ?? transport,
      scope: { kind: "point", offsetUs: captureEventOffsetUs() },
      severity: "critical",
      message: message.slice(0, 1_000),
      component: "recorder",
      limit: recorderError?.limit ?? "unknown",
      limitValue: recorderError?.limitValue ?? null,
      observedValue: recorderError?.observedValue ?? null,
    });
    setIssue(`${message} Recording is paused; stop to preserve the records already retained.`);
  };

  const freezeCaptureDuration = (): number => {
    if (!durationFrozenRef.current) {
      const activeTransport = transportRef.current;
      const liveDurationUs = activeTransport !== null
        ? monotonicCaptureDurationUs(captureStartMsRef.current, nowMonotonicMs(), lastDurationUsRef.current)
        : lastDurationUsRef.current;
      frozenDurationUsRef.current = Math.max(1, liveDurationUs);
      durationFrozenRef.current = true;
    }
    return frozenDurationUsRef.current;
  };

  const appendCapturedBytes = (input: CapturedBytes, origin: CapturedInputOrigin = "live"): boolean => {
    if (!canRetainCapturedInput(
      captureInputClosedRef.current,
      ingestPausedRef.current,
      origin,
    )) return false;
    const recorder = recorderRef.current;
    if (!recorder) return false;
    try {
      recorder.append(input);
      lastRetainedOffsetUsRef.current = Math.max(lastRetainedOffsetUsRef.current, input.offsetUs);
      return true;
    } catch (cause) {
      pauseIngest(cause);
      return false;
    }
  };

  const acceptOwnedUdpDatagram = (datagram: UdpBridgeDatagram, allowPausedRetention = false): boolean => {
    const ownedCaptureId = ownedUdpCaptureIdRef.current;
    if (!ownedCaptureId || datagram.captureId !== ownedCaptureId) {
      setIssue("The bridge emitted a datagram from a capture this dialog does not own; it was left untouched and not retained.");
      return false;
    }
    const expectedSequence = lastUdpSequenceRef.current + 1;
    if (datagram.sequence !== expectedSequence && !udpSequenceIssueRef.current) {
      udpSequenceIssueRef.current = `SSE sequence ${datagram.sequence} arrived where ${expectedSequence} was expected`;
      recordTransportEvent(udpSequenceDiscontinuityEvent(datagram, expectedSequence));
      setIssue(`UDP event-stream sequence discontinuity detected at ${datagram.sequence}; clean save will be refused.`);
    }
    lastUdpSequenceRef.current = datagram.sequence;
    if (!durationFrozenRef.current) {
      lastDurationUsRef.current = Math.max(lastDurationUsRef.current, datagram.offsetUs + 1);
    }
    observedUdpDatagramsRef.current += 1;
    observedUdpBytesRef.current += datagram.byteLength;
    return appendCapturedBytes({
      offsetUs: datagram.offsetUs,
      bytes: datagram.data,
      wireBytes: datagram.byteLength,
      remoteEndpoint: {
        address: datagram.remoteAddress,
        port: datagram.remotePort,
        family: datagram.remoteFamily,
      },
    }, allowPausedRetention ? "pre-status-buffer" : "live");
  };

  const establishOwnedUdpCapture = (status: UdpBridgeStatus): void => {
    if (recorderRef.current) return;
    if (status.state !== "capturing" || !status.capture || !status.udp) {
      throw new UdpCaptureOwnershipError(
        "The successful bridge start response did not identify an active capture and bind address.",
      );
    }
    const config = udpRecorderConfigRef.current;
    if (!config) throw new Error("The pending UDP session metadata is unavailable.");
    // This is the sole ownership assignment. Event-stream hello/status events
    // can describe a foreign capture, so they never reach this path.
    ownedUdpCaptureIdRef.current = status.capture.id;
    const sourceAddress = status.multicast?.group ?? status.udp.host;
    const sourceLabel = status.multicast
      ? `UDP multicast ${status.multicast.group} · ${status.udp.host}:${status.udp.port}`
      : `UDP ${status.udp.host}:${status.udp.port}`;
    const recorder = new CaptureRecorder({
      sessionId: config.sessionId,
      title: config.title,
      startedAt: status.capture.startedAt,
      displayTimeZone: config.displayTimeZone,
      source: {
        id: `live-udp-${config.sessionId}`.slice(0, 128),
        kind: "udp",
        label: sourceLabel.slice(0, 200),
        address: sourceAddress,
        port: status.udp.port,
      },
      decoderPack: config.decoderPack,
    });
    recorderRef.current = recorder;
    flushPendingTransportEvents(recorder);
    captureStartMsRef.current = nowMonotonicMs() - status.capture.durationUs / 1_000;

    const pending = pendingUdpDatagramsRef.current;
    pendingUdpDatagramsRef.current = [];
    pendingUdpBytesRef.current = 0;
    flushOwnedBufferedUdpDatagrams(
      pending,
      status.capture.id,
      (datagram, allowPausedRetention) => acceptOwnedUdpDatagram(datagram, allowPausedRetention),
    );
  };

  const acceptUdpStatus = (status: UdpBridgeStatus): void => {
    udpStatusRef.current = status;
    if (mountedRef.current) setUdpStatus(status);
    const ownedCaptureId = ownedUdpCaptureIdRef.current;
    if (ownedCaptureId && status.capture?.id === ownedCaptureId) {
      udpCaptureJournalRef.current = ownedUdpCaptureJournal(status, ownedCaptureId);
      if (!durationFrozenRef.current) {
      lastDurationUsRef.current = Math.max(lastDurationUsRef.current, status.capture.durationUs);
      }
      if (status.lastError) {
        recordUdpError(status.lastError);
        if (mountedRef.current) setIssue(udpErrorMessage(status.lastError));
      }
    }
  };

  const acceptPreflightUdpDatagram = (datagram: UdpBridgeDatagram): void => {
    const ownedCaptureId = ownedUdpCaptureIdRef.current;
    if (!ownedCaptureId || datagram.captureId !== ownedCaptureId) return;
    const analyzer = preflightAnalyzerRef.current;
    if (!analyzer) return;
    const observedAtMs = nowMonotonicMs();
    analyzer.observeInput(datagram.byteLength, observedAtMs);
    analyzer.observeRecord({
      bytes: datagram.data,
      offsetUs: datagram.offsetUs,
      transport: "udp",
      remoteEndpoint: {
        address: datagram.remoteAddress,
        port: datagram.remotePort,
        family: datagram.remoteFamily,
      },
    });
    lastDurationUsRef.current = Math.max(lastDurationUsRef.current, datagram.offsetUs + 1);
  };

  const startUdpPreflight = async (): Promise<void> => {
    if (captureLocked || transportRef.current) return;
    if (operatorRuntime.mode === "invalid") {
      setIssue(operatorRuntime.message);
      return;
    }
    let port: number;
    try {
      port = strictInteger(udpPort, "UDP port", 0, 65_535);
    } catch (cause) {
      setIssue(errorMessage(cause, "The UDP preflight configuration is invalid."));
      return;
    }

    resetForPreflight("udp");
    setPhase("starting");
    let client: UdpBridgeClient;
    try {
      client = new UdpBridgeClient({
        baseUrl: bridgeUrl.trim(),
        ...(operatorRuntime.mode === "managed"
          ? { authentication: { mode: "same-origin-proxy" as const } }
          : { token: bridgeToken }),
        onStatus: (status) => {
          udpStatusRef.current = status;
          if (mountedRef.current) setUdpStatus(status);
          const ownedCaptureId = ownedUdpCaptureIdRef.current;
          if (ownedCaptureId && status.capture?.id === ownedCaptureId) {
            lastDurationUsRef.current = Math.max(lastDurationUsRef.current, status.capture.durationUs);
          }
          if (status.lastError && mountedRef.current) setIssue(udpErrorMessage(status.lastError));
        },
        onDatagram: (datagram) => {
          if (transportRef.current !== "udp") return;
          if (ownedUdpCaptureIdRef.current) {
            acceptPreflightUdpDatagram(datagram);
          } else if (
            pendingUdpDatagramsRef.current.length < MAX_PREFLIGHT_ANALYZED_RECORDS
            && pendingUdpBytesRef.current + datagram.byteLength <= MAX_PREFLIGHT_ANALYZED_BYTES
          ) {
            pendingUdpDatagramsRef.current.push(datagram);
            pendingUdpBytesRef.current += datagram.byteLength;
          } else if (mountedRef.current) {
            setIssue("UDP traffic exceeded the bounded preflight sample before ownership was confirmed. Stop and retry the preflight.");
          }
        },
        onError: (error) => {
          preflightConnectedRef.current = false;
          if (mountedRef.current) setIssue(udpErrorMessage(error));
        },
      });
    } catch (cause) {
      clearRuntime();
      setPhase("ready");
      setIssue(errorMessage(cause, "The local UDP bridge configuration is invalid."));
      return;
    }
    udpClientRef.current = client;

    try {
      const group = multicastGroup.trim();
      const interfaceAddress = multicastInterface.trim();
      const status = await client.start({
        host: udpHost.trim(),
        port,
        ...(group ? { multicastGroup: group } : {}),
        ...(interfaceAddress ? { multicastInterface: interfaceAddress } : {}),
      });
      if (startCancelledRef.current || !mountedRef.current) {
        if (status.state === "capturing" && status.capture) {
          ownedUdpCaptureIdRef.current = status.capture.id;
          await stopUdpCaptureIfOwned(client, status.capture.id).catch(() => undefined);
        }
        client.disconnect();
        clearRuntime();
        if (mountedRef.current) {
          setPhase("ready");
          setNotice("UDP preflight was cancelled before the source opened.");
        }
        return;
      }
      if (status.state !== "capturing" || !status.capture || !status.udp) {
        throw new UdpCaptureOwnershipError(
          "The bridge did not identify the UDP preflight capture and bind address.",
        );
      }
      ownedUdpCaptureIdRef.current = status.capture.id;
      preflightConnectedRef.current = true;
      captureStartMsRef.current = nowMonotonicMs() - status.capture.durationUs / 1_000;
      udpStatusRef.current = status;
      setUdpStatus(status);
      const pending = pendingUdpDatagramsRef.current;
      pendingUdpDatagramsRef.current = [];
      pendingUdpBytesRef.current = 0;
      for (const datagram of pending) acceptPreflightUdpDatagram(datagram);
      setPhase("preflighting");
    } catch (cause) {
      const cancelled = startCancelledRef.current;
      const ownedCaptureId = ownedUdpCaptureIdRef.current;
      if (ownedCaptureId) {
        await stopUdpCaptureIfOwned(client, ownedCaptureId).catch(() => undefined);
      }
      client.disconnect();
      clearRuntime();
      if (mountedRef.current) {
        setPhase("ready");
        if (cancelled) setNotice("UDP preflight was cancelled before the source opened.");
        else setIssue(errorMessage(cause, "The UDP preflight could not be started."));
      }
    }
  };

  const startUdpCapture = async (): Promise<void> => {
    if (transportRef.current) return;
    if (operatorRuntime.mode === "invalid") {
      setIssue(operatorRuntime.message);
      return;
    }
    let port: number;
    let resolvedTimeZone: string;
    const title = sessionTitle.trim();
    try {
      if (!title) throw new Error("Session title is required.");
      port = strictInteger(udpPort, "UDP port", 0, 65_535);
      resolvedTimeZone = validateTimeZone(timeZone);
    } catch (cause) {
      setIssue(errorMessage(cause, "The UDP capture configuration is invalid."));
      return;
    }

    resetForStart("udp");
    startingPurposeRef.current = "recording";
    udpRecorderConfigRef.current = {
      sessionId: createSessionId(),
      title,
      displayTimeZone: resolvedTimeZone,
      decoderPack,
    };
    setPhase("starting");
    let client: UdpBridgeClient;
    try {
      client = new UdpBridgeClient({
        baseUrl: bridgeUrl.trim(),
        ...(operatorRuntime.mode === "managed"
          ? { authentication: { mode: "same-origin-proxy" as const } }
          : { token: bridgeToken }),
        onStatus: acceptUdpStatus,
        onDatagram: (datagram) => {
          if (transportRef.current !== "udp") return;
          if (ownedUdpCaptureIdRef.current) {
            acceptOwnedUdpDatagram(datagram);
          } else if (
            pendingUdpDatagramsRef.current.length < MAX_CAPTURE_RECORDS
            && pendingUdpBytesRef.current + datagram.byteLength <= MAX_CAPTURE_BYTES
          ) {
            pendingUdpDatagramsRef.current.push(datagram);
            pendingUdpBytesRef.current += datagram.byteLength;
          } else {
            const message = "Early UDP datagrams exceeded the local pre-status buffer limit.";
            ingestPausedRef.current = true;
            transportIntegrityIssueRef.current = message;
            recordTransportEvent({
              type: "capture-backpressure",
              transport: "udp",
              scope: { kind: "session" },
              severity: "critical",
              message,
              component: "udp-prestatus-buffer",
              limit: pendingUdpDatagramsRef.current.length >= MAX_CAPTURE_RECORDS ? "records" : "captured-bytes",
              limitValue: pendingUdpDatagramsRef.current.length >= MAX_CAPTURE_RECORDS ? MAX_CAPTURE_RECORDS : MAX_CAPTURE_BYTES,
              observedValue: pendingUdpDatagramsRef.current.length >= MAX_CAPTURE_RECORDS
                ? pendingUdpDatagramsRef.current.length + 1
                : pendingUdpBytesRef.current + datagram.byteLength,
            });
            setIssue(`${message} Recording is paused; stop to preserve the records already retained.`);
          }
        },
        onError: (error) => {
          const transportEnded = error instanceof UdpBridgeProtocolError
            ? error.code === "event-stream-disconnected"
            : error.fatal;
          if (ownedUdpCaptureIdRef.current && transportEnded) {
            freezeCaptureDuration();
            captureInputClosedRef.current = true;
            transportIntegrityIssueRef.current = udpErrorMessage(error);
          }
          recordUdpError(error);
          setIssue(udpErrorMessage(error));
        },
      });
    } catch (cause) {
      clearRuntime();
      setPhase("ready");
      setIssue(errorMessage(cause, "The local UDP bridge configuration is invalid."));
      return;
    }
    udpClientRef.current = client;

    try {
      const group = multicastGroup.trim();
      const interfaceAddress = multicastInterface.trim();
      const status = await client.start({
        host: udpHost.trim(),
        port,
        ...(group ? { multicastGroup: group } : {}),
        ...(interfaceAddress ? { multicastInterface: interfaceAddress } : {}),
      });
      if (startCancelledRef.current || !mountedRef.current) {
        if (status.state === "capturing" && status.capture) {
          ownedUdpCaptureIdRef.current = status.capture.id;
          await stopUdpCaptureIfOwned(client, status.capture.id).catch(() => undefined);
        }
        client.disconnect();
        clearRuntime();
        if (mountedRef.current) {
          setPhase("ready");
          setNotice("UDP capture setup was cancelled before recording began.");
        }
        return;
      }
      // Ownership begins only after the POST /start promise resolves
      // successfully. Status/hello events observed during connect are not
      // sufficient proof and may belong to another operator.
      establishOwnedUdpCapture(status);
      acceptUdpStatus(status);
      if (mountedRef.current && transportRef.current === "udp") setPhase("capturing");
    } catch (cause) {
      const cancelled = startCancelledRef.current;
      const ownedCaptureId = ownedUdpCaptureIdRef.current;
      if (ownedCaptureId) {
        await stopUdpCaptureIfOwned(client, ownedCaptureId).catch(() => undefined);
      }
      client.disconnect();
      clearRuntime();
      if (mountedRef.current) {
        setPhase("ready");
        if (cancelled) setNotice("UDP capture setup was cancelled before recording began.");
        else setIssue(errorMessage(cause, "The UDP capture could not be started."));
      }
    }
  };

  const createSerialRecordingHandlers = (): SerialCaptureHandlers => ({
    onChunk: (bytes) => {
      if (transportRef.current !== "serial") return;
      const offsetUs = Math.max(0, Math.floor((nowMonotonicMs() - captureStartMsRef.current) * 1_000));
      if (!durationFrozenRef.current) lastDurationUsRef.current = Math.max(lastDurationUsRef.current, offsetUs + 1);
      observedSerialReadsRef.current += 1;
      observedSerialBytesRef.current += bytes.byteLength;
      if (captureInputClosedRef.current || ingestPausedRef.current) return;
      try {
        const assembler = serialAssemblerRef.current;
        if (!assembler) throw new Error("The serial frame assembler was not initialized before input arrived.");
        for (const assembly of assembler.push(bytes, offsetUs)) {
          appendCapturedBytes({ offsetUs: assembly.offsetUs, bytes: assembly.bytes });
        }
      } catch (cause) {
        pauseIngest(cause);
      }
    },
    onError: (error) => {
      freezeCaptureDuration();
      captureInputClosedRef.current = true;
      transportIntegrityIssueRef.current = error.message;
      recordTransportEvent(serialTransportFailureEvent(
        "serial-read-error",
        captureEventOffsetUs(),
        error.message,
        error.name || "serial-read-error",
      ));
      setSerialState("error");
      setIssue(`${error.message} Stop and save the records retained before the serial error.`);
    },
    onDisconnect: () => {
      freezeCaptureDuration();
      captureInputClosedRef.current = true;
      transportIntegrityIssueRef.current = "The serial stream disconnected before the operator stopped it.";
      recordTransportEvent(serialTransportFailureEvent(
        "serial-disconnected",
        captureEventOffsetUs(),
        "The serial stream disconnected before the operator stopped it.",
        "serial-stream-ended",
      ));
      serialDisconnectedRef.current = true;
      setSerialState("disconnected");
      setIssue("The serial stream disconnected. Stop and save the records retained before the disconnect.");
    },
  });

  const startSerialPreflight = (): void => {
    if (captureLocked || transportRef.current) return;
    const api = getBrowserSerialApi();
    if (!api) {
      setIssue("Web Serial is unavailable in this browser. Use a supported Chromium browser or the local UDP bridge.");
      return;
    }

    let parsedBaudRate: number;
    const captureDecoderPack = decoderPack;
    try {
      parsedBaudRate = strictInteger(baudRate, "Baud rate", 1, 4_000_000);
    } catch (cause) {
      setIssue(errorMessage(cause, "The serial preflight configuration is invalid."));
      return;
    }

    resetForPreflight("serial");
    const normalizedSerialSettings: Extract<CaptureTransportProvenanceEvidence, { transport: "serial" }>["settings"] = {
      baudRate: parsedBaudRate,
      dataBits: Number(dataBits) as 7 | 8,
      stopBits: Number(stopBits) as 1 | 2,
      parity,
      bufferSize: 65_536,
      flowControl,
    };
    const serialCapture = new WebSerialCapture(api);
    serialCaptureRef.current = serialCapture;
    serialPreflightSettingsRef.current = normalizedSerialSettings;
    serialPreflightAssemblerRef.current = createSerialAssembler(captureDecoderPack);
    serialDisconnectedRef.current = false;
    setSerialDevice("Waiting for operator selection");
    setSerialState("selecting");
    setPhase("starting");

    // Keep this call in the Preflight button's synchronous event path. WebSerialCapture
    // invokes navigator.serial.requestPort() before its first await so the browser's
    // transient user activation is retained for the device chooser.
    const startPromise = serialCapture.start(normalizedSerialSettings, {
      onOpen: (device) => {
        if (startCancelledRef.current || !mountedRef.current) {
          throw new Error("Serial setup was cancelled before preflight began.");
        }
        captureStartMsRef.current = nowMonotonicMs();
        lastDurationUsRef.current = 0;
        serialPreflightDeviceRef.current = device;
        preflightConnectedRef.current = true;
        setSerialDevice(device.label);
        setSerialState("open");
        setPhase("preflighting");
      },
      onChunk: (bytes) => {
        if (transportRef.current !== "serial") return;
        const offsetUs = Math.max(0, Math.floor((nowMonotonicMs() - captureStartMsRef.current) * 1_000));
        const analyzer = preflightAnalyzerRef.current;
        analyzer?.observeInput(bytes.byteLength, nowMonotonicMs());
        try {
          const assembler = serialPreflightAssemblerRef.current;
          if (!assembler) throw new Error("The serial preflight assembler was not initialized before input arrived.");
          for (const assembly of assembler.push(bytes, offsetUs)) {
            analyzer?.observeRecord({
              bytes: assembly.bytes,
              offsetUs: assembly.offsetUs,
              transport: "serial",
            });
          }
        } catch (cause) {
          preflightConnectedRef.current = false;
          setIssue(errorMessage(cause, "Serial preflight analysis failed."));
        }
      },
      onError: (error) => {
        preflightConnectedRef.current = false;
        setSerialState("error");
        setIssue(`${error.message} Stop the preflight and check the device and serial settings.`);
      },
      onDisconnect: () => {
        preflightConnectedRef.current = false;
        serialDisconnectedRef.current = true;
        setSerialState("disconnected");
        setIssue("The serial stream disconnected during preflight. Stop the preflight and check the device.");
      },
    });

    void startPromise.then((device) => {
      if (!mountedRef.current || transportRef.current !== "serial") return;
      setSerialDevice(device.label);
      if (!serialDisconnectedRef.current) setSerialState("open");
    }).catch((cause) => {
      const cancelled = startCancelledRef.current;
      clearRuntime();
      if (mountedRef.current) {
        setSerialState("error");
        setPhase("ready");
        if (cancelled) setNotice("Serial preflight was cancelled before the source opened.");
        else setIssue(errorMessage(cause, "The serial preflight could not be started."));
      }
    });
  };

  const stopActivePreflight = async (): Promise<void> => {
    if (transportRef.current === "udp") {
      const client = udpClientRef.current;
      const ownedCaptureId = ownedUdpCaptureIdRef.current;
      if (client && ownedCaptureId) await stopUdpCaptureIfOwned(client, ownedCaptureId);
      client?.disconnect();
      return;
    }
    if (transportRef.current === "serial") {
      await serialCaptureRef.current?.stop();
    }
  };

  const stopPreflight = async (): Promise<void> => {
    if (phase !== "preflighting" || finalizingRef.current) return;
    finalizingRef.current = true;
    setPhase("stopping");
    let stopWarning = "";
    try {
      await stopActivePreflight();
    } catch (cause) {
      stopWarning = ` The source did not confirm a clean preflight stop: ${errorMessage(cause, "unknown stop failure")}`;
      udpClientRef.current?.disconnect();
      await serialCaptureRef.current?.stop().catch(() => undefined);
    }
    clearRuntime();
    setUdpStatus(null);
    udpStatusRef.current = null;
    setSerialState("closed");
    setPhase("ready");
    setIssue("");
    setNotice(`Preflight stopped. Its sampled bytes were not added to a session.${stopWarning}`);
    finalizingRef.current = false;
  };

  const beginUdpRecording = async (): Promise<void> => {
    if (phase !== "preflighting" || transportRef.current !== "udp" || finalizingRef.current) return;
    const title = sessionTitle.trim();
    try {
      if (!title) throw new Error("Session title is required.");
      validateTimeZone(timeZone);
    } catch (cause) {
      setIssue(errorMessage(cause, "Session metadata is invalid."));
      return;
    }

    finalizingRef.current = true;
    startingPurposeRef.current = "recording";
    setPhase("starting");
    try {
      await stopActivePreflight();
    } catch (cause) {
      udpClientRef.current?.disconnect();
      clearRuntime();
      setPhase("ready");
      setIssue(`${errorMessage(cause, "UDP preflight did not stop cleanly.")} Recording was not started because a new evidence boundary could not be established.`);
      finalizingRef.current = false;
      return;
    }
    clearRuntime();
    finalizingRef.current = false;
    await startUdpCapture();
  };

  const beginSerialRecording = (): void => {
    if (phase !== "preflighting" || transportRef.current !== "serial") return;
    const serialCapture = serialCaptureRef.current;
    const device = serialPreflightDeviceRef.current;
    const settings = serialPreflightSettingsRef.current;
    let resolvedTimeZone: string;
    const title = sessionTitle.trim();
    try {
      if (!title) throw new Error("Session title is required.");
      resolvedTimeZone = validateTimeZone(timeZone);
      if (!serialCapture?.active || !device || !settings) {
        throw new Error("The serial preflight source is no longer open.");
      }
    } catch (cause) {
      setIssue(errorMessage(cause, "Session metadata is invalid."));
      return;
    }

    const sessionId = createSessionId();
    const captureDecoderPack = decoderPack;
    resetForStart("serial");
    startingPurposeRef.current = "recording";
    serialProvenanceRef.current = serialCaptureProvenance(device, settings);
    const recorder = new CaptureRecorder({
      sessionId,
      title,
      startedAt: new Date(),
      displayTimeZone: resolvedTimeZone,
      source: {
        id: `live-serial-${sessionId}`.slice(0, 128),
        kind: "serial",
        label: `${device.label} · ${settings.baudRate.toLocaleString("en-US")} baud`.slice(0, 200),
      },
      decoderPack: captureDecoderPack,
    });
    recorderRef.current = recorder;
    serialAssemblerRef.current = createSerialAssembler(captureDecoderPack);
    captureStartMsRef.current = nowMonotonicMs();
    lastDurationUsRef.current = 0;
    preflightConnectedRef.current = false;
    serialPreflightAssemblerRef.current = null;
    try {
      serialCapture.replaceHandlers(createSerialRecordingHandlers());
    } catch (cause) {
      recorderRef.current = null;
      serialAssemblerRef.current = null;
      setPhase("preflighting");
      setIssue(errorMessage(cause, "The serial evidence boundary could not be established."));
      return;
    }
    flushPendingTransportEvents(recorder);
    setSerialState("open");
    setPhase("capturing");
  };

  const beginRecording = (): void => {
    if (transport === "udp") void beginUdpRecording();
    else beginSerialRecording();
  };

  const stopTransport = async (): Promise<number> => {
    const activeTransport = transportRef.current;
    let verifiedDurationUs = verifiedCaptureDurationUs({
      frozenDurationUs: frozenDurationUsRef.current,
      lastRetainedOffsetUs: lastRetainedOffsetUsRef.current,
    });
    if (activeTransport === "udp") {
      const client = udpClientRef.current;
      if (!client) throw new Error("The UDP bridge client is no longer available.");
      const ownedCaptureId = ownedUdpCaptureIdRef.current;
      if (!ownedCaptureId) {
        throw new UdpCaptureOwnershipError("This dialog does not own the active bridge capture, so it was not stopped.");
      }
      const status = await stopUdpCaptureIfOwned(client, ownedCaptureId);
      acceptUdpStatus(status);
      // The stop response can overtake already-written SSE datagrams on a
      // separate local connection. Wait only until its final counters arrive,
      // bounded to one second so a broken event stream cannot hang the dialog.
      if (status.capture) {
        const drainDeadlineMs = nowMonotonicMs() + 1_000;
        while (
          (observedUdpDatagramsRef.current < status.capture.datagrams
            || observedUdpBytesRef.current < status.capture.bytes)
          && nowMonotonicMs() < drainDeadlineMs
        ) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 20));
        }
        if (
          observedUdpDatagramsRef.current < status.capture.datagrams
          || observedUdpBytesRef.current < status.capture.bytes
        ) {
          const message = "The UDP event stream did not deliver the bridge's final counters before the stop-drain deadline.";
          recordTransportEvent({
            type: "udp-event-stream-disconnected",
            transport: "udp",
            scope: { kind: "point", offsetUs: captureEventOffsetUs() },
            severity: "critical",
            message,
            code: "stop-drain-timeout",
            fatal: true,
          });
          transportIntegrityIssueRef.current = message;
        }
      }
      captureInputClosedRef.current = true;
      verifiedDurationUs = verifiedCaptureDurationUs({
        frozenDurationUs: verifiedDurationUs,
        bridgeDurationUs: status.capture?.durationUs,
        bridgeDatagrams: status.capture?.datagrams,
        lastRetainedOffsetUs: lastRetainedOffsetUsRef.current,
      });
      verifiedStopDurationUsRef.current = verifiedDurationUs;
      transportReportedUnitsRef.current = status.capture?.datagrams ?? null;
      transportReportedBytesRef.current = status.capture?.bytes ?? null;
      stopDispositionRef.current = status.state === "stopped" && status.capture?.id === ownedCaptureId
        ? "confirmed"
        : "unconfirmed";
      client.disconnect();
      udpClientRef.current = null;
      transportRef.current = null;
      captureStartMsRef.current = 0;
      const recorder = recorderRef.current;
      assertUdpCaptureIntegrity(status, ownedCaptureId, {
        observedDatagrams: observedUdpDatagramsRef.current,
        observedBytes: observedUdpBytesRef.current,
        retainedRecords: recorder?.recordCount ?? 0,
        retainedBytes: recorder?.capturedBytes ?? 0,
        lastSequence: lastUdpSequenceRef.current,
        sequenceIssue: udpSequenceIssueRef.current,
      });
    } else if (activeTransport === "serial") {
      const serialCapture = serialCaptureRef.current;
      if (!serialCapture) throw new Error("The serial capture connection is no longer available.");
      await serialCapture.stop();
      captureInputClosedRef.current = true;
      serialCaptureRef.current = null;
      setSerialState("closed");
      const assembler = serialAssemblerRef.current;
      if (assembler && !ingestPausedRef.current) {
        retainSerialAssemblerTail(assembler, appendCapturedBytes);
      }
      verifiedDurationUs = verifiedCaptureDurationUs({
        frozenDurationUs: verifiedDurationUs,
        lastRetainedOffsetUs: lastRetainedOffsetUsRef.current,
      });
      verifiedStopDurationUsRef.current = verifiedDurationUs;
      transportReportedUnitsRef.current = null;
      transportReportedBytesRef.current = null;
      stopDispositionRef.current = "confirmed";
      serialAssemblerRef.current = null;
      transportRef.current = null;
      captureStartMsRef.current = 0;
    } else {
      throw new Error("No active capture transport is available to stop.");
    }
    return verifiedDurationUs;
  };

  const deliverFinalizedSession = async (session: SessionDocument): Promise<void> => {
    pendingFinalizedSessionRef.current = session;
    setPhase("saving");
    let filename: string;
    try {
      filename = downloadSession(session);
    } catch (cause) {
      setPhase("save-error");
      setIssue(`${errorMessage(cause, "The session download could not be started.")} The finalized session remains in memory; retry the download or explicitly discard it.`);
      return;
    }

    pendingFinalizedSessionRef.current = null;
    try {
      await onComplete(session);
      if (mountedRef.current) {
        setNotice(`${filename} was downloaded and opened for replay.`);
        onClose();
      }
    } catch (cause) {
      if (mountedRef.current) {
        setPhase("ready");
        setIssue(`${errorMessage(cause, "The downloaded capture could not be opened automatically.")} The local .nlsession file is preserved.`);
      }
    }
  };

  const finalizeRetainedCapture = async (context: PendingFinalization): Promise<void> => {
    const recorder = recorderRef.current;
    pendingFinalizationRef.current = context;
    if (!recorder) {
      setPhase("finalize-error");
      setIssue("The retained capture recorder is unavailable. Explicitly discard this recovery state before closing.");
      return;
    }
    if (recorder.recordCount === 0) {
      setPhase("finalize-error");
      setIssue("The source stopped without producing a record, so there is no valid .nlsession to download. Explicitly discard this empty capture before closing or starting again.");
      return;
    }

    const boundedDuration = boundFinalizationDuration(context.durationUs, recorder.limits.maxDurationUs);
    let requestedDurationUs = boundedDuration.durationUs;
    let incompleteReason = context.incompleteReason;
    const issueCodes = new Set<CaptureIntegrityIssueCode>(context.evidence.issueCodes ?? []);
    if (boundedDuration.wasCapped) {
      const durationReason = `Capture ran for ${formatDurationUs(context.durationUs, true)}, beyond the ${formatDurationUs(recorder.limits.maxDurationUs)} session limit; the retained replay duration was capped and marked incomplete.`;
      incompleteReason = incompleteReason ? `${incompleteReason}; ${durationReason}` : durationReason;
      issueCodes.add("duration-capped");
      durationLimitEventRecordedRef.current = ensureDurationLimitTransportEvent(recorder, {
        alreadyRecorded: durationLimitEventRecordedRef.current,
        transport,
        maximumDurationUs: recorder.limits.maxDurationUs,
        observedDurationUs: context.durationUs,
        message: durationReason,
      });
    }
    const evidence: CaptureFinalizationEvidence = {
      ...context.evidence,
      stopOffsetUs: context.evidence.stopDisposition === "not-observed"
        ? null
        : Math.min(requestedDurationUs, context.evidence.stopOffsetUs ?? requestedDurationUs),
      issueCodes: [...issueCodes],
    };

    let finalized: SessionDocument;
    try {
      finalized = recorder.finalize(requestedDurationUs, evidence);
    } catch (cause) {
      pendingFinalizationRef.current = { durationUs: requestedDurationUs, incompleteReason, evidence };
      setPhase("finalize-error");
      setIssue(`${errorMessage(cause, "The retained capture could not be finalized.")} ${recorder.recordCount.toLocaleString()} retained records remain in memory; retry finalization or explicitly discard them.`);
      return;
    }

    const session = finalized;
    pendingFinalizationRef.current = null;
    setTotals({
      inputUnits: transport === "udp" ? observedUdpDatagramsRef.current : observedSerialReadsRef.current,
      inputBytes: transport === "udp" ? observedUdpBytesRef.current : observedSerialBytesRef.current,
      records: session.records.length,
      recordedBytes: session.records.reduce((sum, record) => sum + record.captureBytes, 0),
    });
    recorderRef.current = null;
    serialAssemblerRef.current = null;
    if (session.formatVersion === 2 && session.captureIntegrity.status === "incomplete") {
      const reason = incompleteReason ?? session.captureIntegrity.issueCodes.join(", ");
      setNotice(`Recovery capture includes durable integrity evidence: ${reason.slice(0, 800)}`);
    }
    await deliverFinalizedSession(session);
  };

  const stopAndSave = async (): Promise<void> => {
    if (phase !== "capturing" || finalizingRef.current) return;
    finalizingRef.current = true;
    const frozenDurationUs = freezeCaptureDuration();
    let finalDurationUs = frozenDurationUs;
    setPhase("stopping");
    setConfirmDiscard(false);
    setNotice("");
    let incompleteReason: string | null = transportIntegrityIssueRef.current;
    try {
      finalDurationUs = await stopTransport();
    } catch (cause) {
      const stopReason = errorMessage(cause, "The transport did not confirm a clean stop.");
      incompleteReason = incompleteReason ? `${incompleteReason}; ${stopReason}` : stopReason;
      if (stopDispositionRef.current !== "confirmed") {
        stopDispositionRef.current = "unconfirmed";
        shutdownEvidenceRef.current = {
          code: cause instanceof UdpBridgeProtocolError ? cause.code : "transport-stop-unconfirmed",
          message: stopReason,
        };
        recordTransportEvent({
          type: "shutdown-unconfirmed",
          transport,
          scope: { kind: "session" },
          severity: "critical",
          message: stopReason.slice(0, 1_000),
          code: shutdownEvidenceRef.current.code.slice(0, 128),
        });
      }
      captureInputClosedRef.current = true;
      udpClientRef.current?.disconnect();
      const serialCapture = serialCaptureRef.current;
      if (serialCapture) await serialCapture.stop().catch(() => undefined);
      const assembler = serialAssemblerRef.current;
      if (transportRef.current === "serial" && assembler && !ingestPausedRef.current) {
        try {
          retainSerialAssemblerTail(assembler, appendCapturedBytes);
        } catch (assemblyCause) {
          const tailReason = errorMessage(assemblyCause, "unknown assembly error");
          incompleteReason += ` Serial tail recovery also failed: ${tailReason}`;
          recordTransportEvent(serialTransportFailureEvent(
            "serial-tail-recovery-failed",
            captureEventOffsetUs(),
            tailReason,
            "serial-tail-recovery-failed",
          ));
        }
      }
      transportRef.current = null;
      captureStartMsRef.current = 0;
      finalDurationUs = Math.max(
        finalDurationUs,
        verifiedStopDurationUsRef.current,
        lastRetainedOffsetUsRef.current + 1,
      );
    }

    try {
      setPhase("saving");
      await finalizeRetainedCapture({
        durationUs: finalDurationUs,
        incompleteReason,
        evidence: captureFinalizationEvidence({
          transport,
          durationUs: finalDurationUs,
          stopDisposition: stopDispositionRef.current,
          eventLogComplete: transportEventLogCompleteRef.current,
          observedUnits: transport === "udp" ? observedUdpDatagramsRef.current : observedSerialReadsRef.current,
          observedBytes: transport === "udp" ? observedUdpBytesRef.current : observedSerialBytesRef.current,
          transportReportedUnits: transportReportedUnitsRef.current,
          transportReportedBytes: transportReportedBytesRef.current,
          issueCodes: finalizationIssueCodesRef.current,
          shutdown: shutdownEvidenceRef.current,
          transportProvenance: transport === "udp"
            ? { transport: "udp", journal: udpCaptureJournalRef.current }
            : serialProvenanceRef.current ?? undefined,
        }),
      });
    } catch (cause) {
      if (mountedRef.current) {
        setPhase("finalize-error");
        setIssue(`${errorMessage(cause, "The retained capture could not be finalized.")} Retry finalization or explicitly discard the retained capture.`);
      }
    } finally {
      finalizingRef.current = false;
    }
  };

  const retryRetainedFinalization = async (): Promise<void> => {
    const context = pendingFinalizationRef.current;
    if (!context || finalizingRef.current) return;
    finalizingRef.current = true;
    setIssue("");
    setPhase("saving");
    try {
      await finalizeRetainedCapture(context);
    } finally {
      finalizingRef.current = false;
    }
  };

  const discardRetainedCapture = async (): Promise<void> => {
    if (finalizingRef.current) return;
    finalizingRef.current = true;
    setPhase("stopping");
    let shutdownWarning = "";
    const udpClient = udpClientRef.current;
    const ownedCaptureId = ownedUdpCaptureIdRef.current;
    if (udpClient && ownedCaptureId) {
      await stopUdpCaptureIfOwned(udpClient, ownedCaptureId).catch((cause) => {
        shutdownWarning = ` Transport shutdown remained unconfirmed: ${errorMessage(cause, "unknown stop failure")}`;
      });
      udpClient.disconnect();
    }
    const serialCapture = serialCaptureRef.current;
    if (serialCapture) {
      await serialCapture.stop().catch((cause) => {
        shutdownWarning = ` Transport shutdown remained unconfirmed: ${errorMessage(cause, "unknown stop failure")}`;
      });
    }
    pendingFinalizationRef.current = null;
    pendingFinalizedSessionRef.current = null;
    recorderRef.current = null;
    clearRuntime();
    setTotals(EMPTY_TOTALS);
    setIssue("");
    setPhase("ready");
    setNotice(`The retained capture was explicitly discarded.${shutdownWarning}`);
    finalizingRef.current = false;
  };

  const retryFinalizedDownload = async (): Promise<void> => {
    const session = pendingFinalizedSessionRef.current;
    if (!session || finalizingRef.current) return;
    finalizingRef.current = true;
    try {
      await deliverFinalizedSession(session);
    } finally {
      finalizingRef.current = false;
    }
  };

  const discardCapture = async (): Promise<void> => {
    if (phase !== "capturing" || finalizingRef.current) return;
    finalizingRef.current = true;
    freezeCaptureDuration();
    captureInputClosedRef.current = true;
    setPhase("stopping");
    setNotice("");
    let stopFailure: unknown;
    try {
      await stopTransport();
    } catch (cause) {
      stopFailure = cause;
      // Explicit discard is the operator's escape hatch. A dead bridge or
      // device must not create an unrecoverable modal trap; disconnect local
      // control and make one final non-blocking close attempt.
      udpClientRef.current?.disconnect();
      const serialCapture = serialCaptureRef.current;
      if (serialCapture) void serialCapture.stop().catch(() => undefined);
    }
    clearRuntime();
    udpStatusRef.current = null;
    setUdpStatus(null);
    setTotals(EMPTY_TOTALS);
    setIssue("");
    setConfirmDiscard(false);
    setPhase("ready");
    try {
      if (stopFailure) {
        setNotice(`The local capture was discarded, but the transport did not confirm shutdown: ${errorMessage(stopFailure, "unknown stop failure")} Verify the bridge or device before starting another capture.`);
      } else {
        setNotice("The transport stopped and the local capture was discarded.");
      }
    } finally {
      finalizingRef.current = false;
    }
  };

  const cancelStartingCapture = (): void => {
    if (phase !== "starting") return;
    startCancelledRef.current = true;
    udpClientRef.current?.disconnect();
    setPhase("canceling");
    setNotice("Setup cancellation requested. Any late transport open will be closed without recording.");
  };

  const cancelDiscardConfirmation = (): void => {
    setConfirmDiscard(false);
    requestAnimationFrame(() => discardTriggerRef.current?.focus({ preventScroll: true }));
  };

  const chooseTransport = (nextTransport: CaptureTransport): void => {
    if (captureLocked) return;
    setTransport(nextTransport);
    markConfigurationChanged();
  };

  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (captureLocked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "udp" : "serial";
    chooseTransport(next);
    requestAnimationFrame(() => (next === "udp" ? udpTabRef : serialTabRef).current?.focus());
  };

  const formSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (phase !== "ready") return;
    if (transport === "udp") void startUdpPreflight();
  };

  const phaseLabel = capturePhaseLabel(
    phase,
    transport,
    issue,
    startingPurposeRef.current,
    preflightSummary,
  );
  const unitLabel = transport === "udp" ? "Datagrams received" : "Serial reads received";
  const transportDetail = transport === "udp"
    ? udpStatus?.udp
      ? `${udpStatus.udp.host}:${udpStatus.udp.port}${udpStatus.udp.family ? ` · ${udpStatus.udp.family}` : ""}`
      : phase === "starting" ? "Negotiating local bind" : "Not bound"
    : serialDevice;
  const preflightFamilyLabel = preflightSummary?.families.length
    ? preflightSummary.families.slice(0, 2).map((family) => `${family.name} (${family.count})`).join(", ")
    : "None observed";
  const preflightEndpointLabel = preflightSummary?.endpoints.length
    ? preflightSummary.endpoints
        .slice(0, 2)
        .map((endpoint) => `${endpoint.address}:${endpoint.port}`)
        .join(", ")
    : "None observed";
  const preflightActionLabel = preflightSummary?.readiness === "ready"
    ? "Start recording"
    : preflightSummary?.inputUnits
      ? "Record with warning"
      : "Start recording anyway";

  return createPortal(
    <div
      className="dialog-backdrop capture-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!canDismiss) blockedClose();
        else onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="bundle-dialog capture-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${descriptionId} ${statusId}${issue ? ` ${errorId}` : ""}`}
      >
        <button
          className="dialog-close capture-dialog-close"
          type="button"
          aria-label={!canDismiss ? "Close unavailable while capture is active" : "Close live capture dialog"}
          aria-describedby={!canDismiss ? statusId : undefined}
          disabled={!canDismiss}
          onClick={onClose}
        >
          <X size={17} />
        </button>

        <span className="dialog-kicker">Local capture</span>
        <h2 id={titleId}>Record live telemetry</h2>
        <p id={descriptionId}>Capture exact UDP datagrams or assembled serial records locally, decode them with an identified pack, then open the immutable session in the replay workspace.</p>

        <form className="capture-dialog-form" onSubmit={formSubmit}>
          <section className="capture-profile-picker" aria-label="Capture profile controls">
            <label>
              <span>Capture profile</span>
              <select
                value={selectedProfileId}
                disabled={captureLocked}
                onChange={(event) => applyProfile(event.target.value)}
              >
                <option value="">Unsaved setup</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.settings.transport.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-action capture-profile-save"
              type="button"
              disabled={captureLocked}
              aria-expanded={profileEditorOpen}
              aria-controls={profileEditorId}
              onClick={openProfileEditor}
            >
              <FloppyDisk size={16} aria-hidden="true" />
              {selectedProfileId ? "Update setup" : "Save setup"}
            </button>
            <button
              className="icon-button capture-profile-delete"
              type="button"
              disabled={captureLocked || !selectedProfileId}
              aria-label="Delete selected capture profile"
              title="Delete selected capture profile"
              onClick={deleteSelectedProfile}
            >
              <Trash size={16} aria-hidden="true" />
            </button>
            <p>
              {selectedProfileId
                ? `${profiles.find((profile) => profile.id === selectedProfileId)?.name ?? "Selected profile"}${profileDirty ? " · modified" : " · loaded"}`
                : "Profiles store transport settings and the exact decoder pack locally. Credentials, device permission, and telemetry are excluded."}
            </p>
            {profileEditorOpen && (
              <div id={profileEditorId} className="capture-profile-editor">
                <label>
                  <span>Profile name</span>
                  <input
                    ref={profileNameInputRef}
                    value={profileName}
                    maxLength={80}
                    disabled={captureLocked}
                    onChange={(event) => setProfileName(event.target.value)}
                  />
                </label>
                <button
                  className="secondary-action"
                  type="button"
                  onClick={() => setProfileEditorOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary-action"
                  type="button"
                  disabled={!profileName.trim()}
                  onClick={persistProfile}
                >
                  <FloppyDisk size={16} aria-hidden="true" /> Save profile
                </button>
              </div>
            )}
            {profileStorageIssue && (
              <div className="capture-profile-storage-error" role="alert">
                <span>{profileStorageIssue}</span>
                <button className="destructive-link" type="button" onClick={resetProfileStorage}>
                  Reset profiles
                </button>
              </div>
            )}
          </section>

          <div className="dialog-fields capture-session-fields">
            <label>
              <span>Session title</span>
              <input
                data-dialog-focus
                required
                maxLength={240}
                value={sessionTitle}
                disabled={captureLocked}
                onChange={(event) => setSessionTitle(event.target.value)}
              />
            </label>
            <label>
              <span>Display timezone</span>
              <input
                required
                maxLength={100}
                value={timeZone}
                disabled={captureLocked}
                onChange={(event) => setTimeZone(event.target.value)}
                spellCheck={false}
              />
              <small className="field-help">IANA name, such as America/Los_Angeles</small>
            </label>
          </div>

          <section className="capture-decoder-picker" aria-label="Decoder pack">
            <label>
              <span>Decoder pack</span>
              <select
                value={decoderPack.integrity.canonicalSha256}
                disabled={captureLocked}
                onChange={(event) => selectDecoderPack(event.target.value)}
              >
                {decoderPacks.map((pack) => (
                  <option key={pack.integrity.canonicalSha256} value={pack.integrity.canonicalSha256}>
                    {pack.displayName} · {pack.revision}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary-action capture-decoder-load"
              type="button"
              disabled={captureLocked}
              onClick={() => decoderPackInputRef.current?.click()}
            >
              <UploadSimple size={16} aria-hidden="true" /> Load pack
            </button>
            <input
              ref={decoderPackInputRef}
              className="visually-hidden"
              type="file"
              accept=".nldecoder,.json,application/json"
              aria-label="Decoder pack file"
              disabled={captureLocked}
              onChange={(event) => void loadDecoderPack(event)}
            />
            <p>
              {decoderPack.runtime.id} r{decoderPack.runtime.revision}
              {" · "}pack {decoderPack.integrity.canonicalSha256.slice(0, 12)}
              {" · "}{BUILT_IN_DECODER_PACKS.some((pack) => pack.integrity.canonicalSha256 === decoderPack.integrity.canonicalSha256) ? "bundled" : "local"}
            </p>
          </section>

          <div className="capture-transport-tabs" role="tablist" aria-label="Capture transport">
            <button
              ref={udpTabRef}
              id={udpTabId}
              className={transport === "udp" ? "capture-transport-tab active" : "capture-transport-tab"}
              type="button"
              role="tab"
              aria-selected={transport === "udp"}
              aria-controls={udpPanelId}
              tabIndex={transport === "udp" ? 0 : -1}
              disabled={captureLocked}
              onKeyDown={handleTabKey}
              onClick={() => chooseTransport("udp")}
            >
              UDP bridge
            </button>
            <button
              ref={serialTabRef}
              id={serialTabId}
              className={transport === "serial" ? "capture-transport-tab active" : "capture-transport-tab"}
              type="button"
              role="tab"
              aria-selected={transport === "serial"}
              aria-controls={serialPanelId}
              tabIndex={transport === "serial" ? 0 : -1}
              disabled={captureLocked}
              onKeyDown={handleTabKey}
              onClick={() => chooseTransport("serial")}
            >
              Serial port
            </button>
          </div>

          <div
            id={udpPanelId}
            className="capture-transport-panel"
            role="tabpanel"
            aria-labelledby={udpTabId}
            hidden={transport !== "udp"}
          >
            <div className="dialog-fields capture-transport-fields">
              {operatorRuntime.mode === "managed" ? (
                <div className="capture-managed-bridge capture-field-wide" role="status">
                  <strong>Managed local bridge · authenticated</strong>
                  <span>ReplayCase {operatorRuntime.version} · build {operatorRuntime.commit.slice(0, 12)}</span>
                </div>
              ) : operatorRuntime.mode === "invalid" ? (
                <p className="capture-capability-warning capture-field-wide" role="alert">
                  {operatorRuntime.message} UDP capture is unavailable; serial capture and replay remain local and usable.
                </p>
              ) : (
                <>
                  <label className="capture-field-wide">
                    <span>Bridge URL</span>
                    <input
                      type="url"
                      required={transport === "udp"}
                      value={bridgeUrl}
                      disabled={captureLocked}
                      onChange={(event) => {
                        setBridgeUrl(event.target.value);
                        markConnectionChanged();
                      }}
                      spellCheck={false}
                    />
                    <small className="field-help">Loopback HTTP origin only; telemetry is not sent to a remote service.</small>
                  </label>
                  <label className="capture-field-wide">
                    <span>Bridge token</span>
                    <input
                      type="password"
                      required={transport === "udp"}
                      minLength={16}
                      maxLength={256}
                      autoComplete="off"
                      value={bridgeToken}
                      disabled={captureLocked}
                      onChange={(event) => {
                        setBridgeToken(event.target.value);
                        markConnectionChanged();
                      }}
                      spellCheck={false}
                    />
                  </label>
                </>
              )}
              <label>
                <span>UDP bind host</span>
                <input
                  required={transport === "udp"}
                  maxLength={253}
                  value={udpHost}
                  disabled={captureLocked}
                  onChange={(event) => {
                    setUdpHost(event.target.value);
                    markConfigurationChanged();
                  }}
                  spellCheck={false}
                />
              </label>
              <label>
                <span>UDP port</span>
                <input
                  type="number"
                  required={transport === "udp"}
                  min={0}
                  max={65_535}
                  step={1}
                  inputMode="numeric"
                  value={udpPort}
                  disabled={captureLocked}
                  onChange={(event) => {
                    setUdpPort(event.target.value);
                    markConfigurationChanged();
                  }}
                />
                <small className="field-help">Use 0 to let the bridge choose an available local port.</small>
              </label>
              <label>
                <span>Multicast group (optional)</span>
                <input
                  maxLength={253}
                  value={multicastGroup}
                  disabled={captureLocked}
                  onChange={(event) => {
                    setMulticastGroup(event.target.value);
                    markConfigurationChanged();
                  }}
                  placeholder="239.255.42.99"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Multicast interface (optional)</span>
                <input
                  maxLength={253}
                  value={multicastInterface}
                  disabled={captureLocked}
                  onChange={(event) => {
                    setMulticastInterface(event.target.value);
                    markConfigurationChanged();
                  }}
                  placeholder="127.0.0.1"
                  spellCheck={false}
                />
                <small className="field-help">Leave blank to use the operating system's default interface.</small>
              </label>
            </div>
          </div>

          <div
            id={serialPanelId}
            className="capture-transport-panel"
            role="tabpanel"
            aria-labelledby={serialTabId}
            hidden={transport !== "serial"}
          >
            <div className="dialog-fields capture-transport-fields">
              <label className="capture-field-wide">
                <span>Baud rate</span>
                <input
                  type="number"
                  required={transport === "serial"}
                  min={1}
                  max={4_000_000}
                  step={1}
                  inputMode="numeric"
                  value={baudRate}
                  disabled={captureLocked}
                  onChange={(event) => {
                    setBaudRate(event.target.value);
                    markConfigurationChanged();
                  }}
                />
              </label>
              <label>
                <span>Data bits</span>
                <select value={dataBits} disabled={captureLocked} onChange={(event) => {
                  setDataBits(event.target.value as "7" | "8");
                  markConfigurationChanged();
                }}>
                  <option value="8">8</option>
                  <option value="7">7</option>
                </select>
              </label>
              <label>
                <span>Stop bits</span>
                <select value={stopBits} disabled={captureLocked} onChange={(event) => {
                  setStopBits(event.target.value as "1" | "2");
                  markConfigurationChanged();
                }}>
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </label>
              <label>
                <span>Parity</span>
                <select value={parity} disabled={captureLocked} onChange={(event) => {
                  setParity(event.target.value as SerialParity);
                  markConfigurationChanged();
                }}>
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </label>
              <label>
                <span>Flow control</span>
                <select value={flowControl} disabled={captureLocked} onChange={(event) => {
                  setFlowControl(event.target.value as SerialFlowControl);
                  markConfigurationChanged();
                }}>
                  <option value="none">None</option>
                  <option value="hardware">Hardware</option>
                </select>
              </label>
            </div>
            {!serialAvailable && (
              <p className="capture-capability-warning" role="note">Web Serial is unavailable here. UDP capture remains available.</p>
            )}
          </div>

          <section className="capture-live-status" aria-labelledby={statusId}>
            <div ref={captureStatusRef} className="capture-status-heading" role="status" aria-live="polite" tabIndex={-1}>
              <span id={statusId}>{phaseLabel}</span>
              {(phase === "starting" || phase === "stopping" || phase === "saving") && <SpinnerGap className="spin" size={16} aria-hidden="true" />}
            </div>
            {phase === "preflighting" || (phase === "starting" && startingPurposeRef.current === "preflight") ? (
              <dl className="capture-status-grid">
                <div><dt>Source</dt><dd>{transportDetail}</dd></div>
                <div>
                  <dt>Traffic</dt>
                  <dd>{(preflightSummary?.unitRate ?? 0).toFixed(1)}/s · {formatBytes(Math.round(preflightSummary?.byteRate ?? 0))}/s</dd>
                </div>
                <div>
                  <dt>Last input</dt>
                  <dd>
                    {preflightSummary?.lastInputAgeMs == null
                      ? "Not observed"
                      : preflightSummary.lastInputAgeMs < 1_000
                        ? "Now"
                        : `${(preflightSummary.lastInputAgeMs / 1_000).toFixed(1)}s ago`}
                  </dd>
                </div>
                <div><dt>Valid frames</dt><dd>{(preflightSummary?.completeFrames ?? 0).toLocaleString()}</dd></div>
                <div>
                  <dt>Malformed</dt>
                  <dd>
                    {(preflightSummary?.malformedFrames ?? 0).toLocaleString()}
                    {(preflightSummary?.checksumFailures ?? 0) > 0 ? ` · ${preflightSummary?.checksumFailures} checksum` : ""}
                  </dd>
                </div>
                <div><dt>Message families</dt><dd title={preflightFamilyLabel}>{preflightFamilyLabel}</dd></div>
              </dl>
            ) : (
              <dl className="capture-status-grid">
                <div><dt>Source</dt><dd>{transportDetail}</dd></div>
                <div><dt>Elapsed</dt><dd>{formatDurationUs(elapsedUs, true)}</dd></div>
                <div><dt>{unitLabel}</dt><dd>{totals.inputUnits.toLocaleString()}</dd></div>
                <div><dt>Input bytes</dt><dd>{formatBytes(totals.inputBytes)}</dd></div>
                <div><dt>Records retained</dt><dd>{totals.records.toLocaleString()}</dd></div>
                <div><dt>Bytes retained</dt><dd>{formatBytes(totals.recordedBytes)}</dd></div>
              </dl>
            )}
            <p className="capture-transport-state">
              Decoder: <strong>{decoderPack.displayName}</strong> · {decoderPack.revision} · {decoderPack.integrity.canonicalSha256.slice(0, 12)}
            </p>
            {phase === "preflighting" && preflightSummary && (
              <>
                <p className={`capture-preflight-assessment ${preflightSummary.readiness}`}>
                  {preflightSummary.message}
                </p>
                <p className="capture-transport-state">
                  Sampled: {preflightSummary.inputUnits.toLocaleString()} {transport === "udp" ? "datagrams" : "serial reads"} · {formatBytes(preflightSummary.inputBytes)}
                  {transport === "udp" ? ` · endpoints ${preflightEndpointLabel}` : ""}
                  {preflightSummary.analysisLimited ? " · analysis limit reached" : ""}
                </p>
                <p className="capture-evidence-boundary">
                  Preflight samples are not retained. {transport === "udp"
                    ? "Starting recording stops this probe and opens a new owned capture ID."
                    : "Starting recording resets framing and routes only future serial reads into the session."}
                </p>
              </>
            )}
            {transport === "udp" && udpStatus && (
              <p className="capture-transport-state">
                Bridge state: <strong>{udpStatus.state}</strong> · subscribers: {udpStatus.subscribers.toLocaleString()}
                {udpStatus.multicast ? ` · multicast ${udpStatus.multicast.group}${udpStatus.multicast.interface ? ` via ${udpStatus.multicast.interface}` : ""}` : ""}
              </p>
            )}
            {transport === "serial" && (
              <p className="capture-transport-state">Serial state: <strong>{serialState}</strong></p>
            )}
            {!canDismiss && (
              <p className="capture-lock-notice">
                {phase === "preflighting"
                  ? "Closing is locked while the preflight source is open."
                  : "Closing is locked until the source is stopped and the capture is saved or explicitly discarded."}
              </p>
            )}
          </section>

          {issue && <p id={errorId} className="dialog-error capture-dialog-error" role="alert"><WarningCircle size={16} aria-hidden="true" /> {issue}</p>}
          {notice && <p className="capture-dialog-notice" role="status">{notice}</p>}

          {confirmDiscard && phase === "capturing" && (
            <div className="capture-discard-confirm" role="group" aria-label="Confirm capture discard">
              <p>This permanently removes the unsaved local recording after the transport stops.</p>
              <button ref={discardKeepRef} className="secondary-action" type="button" onClick={cancelDiscardConfirmation}>Keep recording</button>
              <button className="destructive-action" type="button" onClick={() => void discardCapture()}>Confirm discard</button>
            </div>
          )}

          <div className="dialog-actions capture-dialog-actions">
            {phase === "ready" ? (
              <>
                <button className="secondary-action" type="button" onClick={onClose}>Cancel</button>
                {transport === "udp" ? (
                  <button
                    className="primary-action"
                    type="submit"
                    disabled={operatorRuntime.mode === "invalid"}
                    data-capture-phase-focus="ready"
                  >
                    Run UDP preflight
                  </button>
                ) : (
                  <button
                    className="primary-action"
                    type="button"
                    disabled={!serialAvailable}
                    onClick={startSerialPreflight}
                    data-capture-phase-focus="ready"
                  >
                    Select port &amp; preflight
                  </button>
                )}
              </>
            ) : phase === "preflighting" ? (
              <>
                <button className="secondary-action" type="button" onClick={() => void stopPreflight()}>
                  Stop preflight
                </button>
                <button
                  className="primary-action"
                  type="button"
                  onClick={beginRecording}
                  disabled={!preflightConnectedRef.current}
                  data-capture-phase-focus="preflighting"
                >
                  {preflightActionLabel}
                </button>
              </>
            ) : phase === "starting" ? (
              <button className="secondary-action" type="button" onClick={cancelStartingCapture} data-capture-phase-focus="starting">Cancel setup</button>
            ) : phase === "canceling" ? (
              <button className="secondary-action" type="button" onClick={onClose} data-capture-phase-focus="canceling">Close</button>
            ) : phase === "capturing" ? (
              <>
                {!confirmDiscard && <button ref={discardTriggerRef} className="secondary-action" type="button" onClick={() => setConfirmDiscard(true)}>Discard</button>}
                <button className="primary-action" type="button" onClick={() => void stopAndSave()} data-capture-phase-focus="capturing">
                  <DownloadSimple size={16} aria-hidden="true" /> Stop, save &amp; replay
                </button>
              </>
            ) : phase === "save-error" ? (
              <>
                <button className="secondary-action" type="button" onClick={() => void discardRetainedCapture()}>Discard finalized session</button>
                <button className="primary-action" type="button" onClick={() => void retryFinalizedDownload()} data-capture-phase-focus="save-error">
                  <DownloadSimple size={16} aria-hidden="true" /> Retry download
                </button>
              </>
            ) : phase === "finalize-error" ? (
              <>
                <button className="secondary-action" type="button" onClick={() => void discardRetainedCapture()}>
                  Discard {recorderRef.current?.recordCount === 0 ? "empty" : "retained"} capture
                </button>
                {(recorderRef.current?.recordCount ?? 0) > 0 && (
                  <button className="primary-action" type="button" onClick={() => void retryRetainedFinalization()}>
                    Retry finalization
                  </button>
                )}
              </>
            ) : (
              <p className="capture-action-progress">{phaseLabel}…</p>
            )}
          </div>
        </form>
      </section>
    </div>,
    document.body,
  );
}

export default CaptureDialog;
