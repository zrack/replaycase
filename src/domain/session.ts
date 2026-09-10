import {
  BUILT_IN_DECODER_PACKS,
  decodeRecord,
  getNumericField,
  resolveDecoderPack,
} from "./decoder";
import {
  DecoderPackValidationError,
  decoderDescriptorForPack,
} from "./decoder-pack";
import {
  incidentPresetSchema,
  MAX_SESSION_DURATION_US,
  sessionDocumentSchema,
  type CaptureIntegrityIssueCode,
  type CaptureIntegrityReceipt,
  type DecodedFrame,
  type DiagnosticEvent,
  type IncidentPreset,
  type IncidentProjection,
  type MetricBucket,
  type OffsetUs,
  type ParsedSession,
  type SessionDocument,
  type SessionDocumentV2,
  type TransportEvent,
  type TransportProvenance,
  type TransportProvenanceIssueCode,
  type UdpBridgeJournal,
  type UdpRemoteEndpoint,
} from "./types";

const SECOND_US = 1_000_000;
const DECODER_RELOCK_STABILITY_US = 40 * SECOND_US;
const DECODER_RELOCK_MIN_VALID_FRAMES = 3;

const TRANSPORT_EVENT_ISSUE_CODES: ReadonlySet<CaptureIntegrityIssueCode> = new Set([
  "udp-event-sequence-discontinuity",
  "udp-counter-mismatch",
  "udp-kernel-drops-observed",
  "udp-bridge-error",
  "udp-event-stream-disconnected",
  "capture-backpressure",
  "capture-limit",
  "serial-read-error",
  "serial-disconnected",
  "serial-tail-recovery-failed",
  "serial-counter-mismatch",
  "shutdown-unconfirmed",
]);

const UDP_CAPTURE_ISSUE_CODES: ReadonlySet<CaptureIntegrityIssueCode> = new Set([
  "udp-event-sequence-discontinuity",
  "udp-counter-mismatch",
  "udp-kernel-drops-observed",
  "udp-bridge-error",
  "udp-event-stream-disconnected",
  "capture-backpressure",
  "capture-limit",
  "shutdown-unconfirmed",
  "duration-capped",
  "event-log-incomplete",
  "transport-provenance-incomplete",
]);

const SERIAL_CAPTURE_ISSUE_CODES: ReadonlySet<CaptureIntegrityIssueCode> = new Set([
  "capture-backpressure",
  "capture-limit",
  "serial-read-error",
  "serial-disconnected",
  "serial-tail-recovery-failed",
  "serial-counter-mismatch",
  "shutdown-unconfirmed",
  "duration-capped",
  "event-log-incomplete",
  "transport-provenance-incomplete",
]);

const UDP_PROVENANCE_ISSUE_CODES: ReadonlySet<TransportProvenanceIssueCode> = new Set([
  "udp-bridge-journal-unavailable",
  "udp-bridge-journal-incomplete",
  "udp-bridge-journal-counter-mismatch",
  "udp-endpoint-attribution-incomplete",
  "udp-kernel-drop-counter-unavailable",
]);

const SERIAL_PROVENANCE_ISSUE_CODES: ReadonlySet<TransportProvenanceIssueCode> = new Set([
  "serial-device-identifiers-unavailable",
]);

export class SessionValidationError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "SessionValidationError";
    this.details = details;
  }
}

export type SessionDerivationPhase = "validating" | "decoding" | "aggregating";

export interface SessionDerivationObserver {
  report(phase: SessionDerivationPhase, completed: number, total: number): void;
}

function reportDerivationProgress(
  observer: SessionDerivationObserver | undefined,
  phase: SessionDerivationPhase,
  completed: number,
  total: number,
): void {
  if (
    observer
    && (completed === 0 || completed === total || completed % 2_048 === 0)
  ) {
    observer.report(phase, completed, total);
  }
}

function assertIncidentWithinDuration(incident: IncidentPreset, durationUs: OffsetUs): void {
  if (incident.endUs > durationUs) {
    throw new SessionValidationError("An incident falls outside the declared session duration.", [
      `${incident.id} ends at ${incident.endUs}µs; duration is ${durationUs}µs`,
    ]);
  }
}

export function validateIncidentPreset(input: unknown, durationUs: OffsetUs): IncidentPreset {
  if (
    !Number.isSafeInteger(durationUs)
    || durationUs <= 0
    || durationUs > MAX_SESSION_DURATION_US
  ) {
    throw new SessionValidationError("The incident range cannot be validated against an invalid session duration.", [
      `Received duration ${durationUs}µs`,
    ]);
  }

  const result = incidentPresetSchema.safeParse(input);
  if (!result.success) {
    throw new SessionValidationError(
      "The incident range is invalid.",
      result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "incident"}: ${issue.message}`),
    );
  }

  assertIncidentWithinDuration(result.data, durationUs);
  return result.data;
}

function transportEventStartUs(event: TransportEvent): number | null {
  if (event.scope.kind === "point") return event.scope.offsetUs;
  if (event.scope.kind === "interval") return event.scope.startUs;
  return null;
}

function udpEndpointKey(endpoint: UdpRemoteEndpoint): string {
  return JSON.stringify([endpoint.family, endpoint.address, endpoint.port]);
}

function sameUdpEndpoint(left: UdpRemoteEndpoint, right: UdpRemoteEndpoint): boolean {
  return left.address === right.address && left.port === right.port && left.family === right.family;
}

function assertProvenanceIssue(
  issueCodes: ReadonlySet<TransportProvenanceIssueCode>,
  code: TransportProvenanceIssueCode,
  required: boolean,
  message: string,
): void {
  if (issueCodes.has(code) !== required) {
    throw new SessionValidationError(message, [`Expected ${code}: ${required ? "present" : "absent"}`]);
  }
}

function assertUdpJournalStructure(document: SessionDocumentV2, journal: UdpBridgeJournal): void {
  if (journal.startedAt !== document.startedAt) {
    throw new SessionValidationError("UDP provenance journal start does not match the session start.", [
      `${journal.startedAt} does not match ${document.startedAt}`,
    ]);
  }
  const expectedSourceAddress = journal.multicast?.group ?? journal.bind.host;
  if (document.source.address !== expectedSourceAddress || document.source.port !== journal.bind.port) {
    throw new SessionValidationError("UDP provenance bind evidence does not match the declared session source.", [
      `Source ${document.source.address ?? "<missing>"}:${document.source.port ?? "<missing>"}; journal ${expectedSourceAddress}:${journal.bind.port}`,
    ]);
  }
  if (journal.multicast && journal.multicast.family !== journal.bind.family) {
    throw new SessionValidationError("UDP provenance multicast and bind address families do not match.");
  }
  if (journal.entriesComplete !== (journal.omittedEntries === 0)) {
    throw new SessionValidationError("UDP provenance journal completeness conflicts with its omitted-entry count.");
  }
  if (journal.state === "active" && journal.endedAt !== null) {
    throw new SessionValidationError("An active UDP provenance journal cannot declare an end timestamp.");
  }
  if (journal.state === "clean" && (journal.endedAt === null || !journal.entriesComplete)) {
    throw new SessionValidationError("A clean UDP provenance journal requires a complete terminal lifecycle.");
  }

  let previousSequence = -1;
  let previousOffsetUs = -1;
  let previousDatagrams = -1;
  let previousBytes = -1;
  let hasErrorEntry = false;
  for (const [index, entry] of journal.entries.entries()) {
    if (
      entry.sequence <= previousSequence
      || (journal.entriesComplete && entry.sequence !== index)
      || entry.offsetUs < previousOffsetUs
      || entry.offsetUs > document.durationUs
      || entry.datagrams < previousDatagrams
      || entry.bytes < previousBytes
      || entry.datagrams > journal.datagrams
      || entry.bytes > journal.bytes
    ) {
      throw new SessionValidationError("UDP provenance journal entries are not monotonic or conflict with terminal counters.", [
        `Entry ${entry.sequence} at retained position ${index}`,
      ]);
    }
    const errorEntry = entry.type === "bridge-error" || entry.type === "subscriber-backpressure";
    if (errorEntry) hasErrorEntry = true;
    if (errorEntry && (!entry.code || !entry.message || typeof entry.fatal !== "boolean")) {
      throw new SessionValidationError("UDP provenance journal error entries require code, message, and fatal evidence.", [
        `Entry ${entry.sequence} (${entry.type})`,
      ]);
    }
    previousSequence = entry.sequence;
    previousOffsetUs = entry.offsetUs;
    previousDatagrams = entry.datagrams;
    previousBytes = entry.bytes;
  }
  if (hasErrorEntry && journal.state !== "incomplete") {
    throw new SessionValidationError("UDP provenance journal error entries require incomplete journal state.");
  }

  const first = journal.entries[0];
  if (
    first?.type !== "capture-started"
    || first.sequence !== 0
    || first.at !== journal.startedAt
    || first.offsetUs !== 0
    || first.datagrams !== 0
    || first.bytes !== 0
  ) {
    throw new SessionValidationError("UDP provenance journal must begin with an exact capture-started entry.");
  }
  if (journal.endedAt !== null) {
    const last = journal.entries.at(-1);
    if (
      last?.type !== "capture-stopped"
      || last.at !== journal.endedAt
      || last.datagrams !== journal.datagrams
      || last.bytes !== journal.bytes
      || last.offsetUs > document.durationUs
      || (document.captureIntegrity.stopOffsetUs != null && last.offsetUs > document.captureIntegrity.stopOffsetUs)
    ) {
      throw new SessionValidationError("A terminal UDP provenance journal must end with final counter evidence within the session.");
    }
  }
}

function assertUdpByteAccounting(
  provenance: Extract<TransportProvenance, { transport: "udp" }>,
): void {
  if (provenance.schemaVersion === 1) return;
  const { journal, byteAccounting } = provenance;
  if ((journal === null) !== (byteAccounting === null)) {
    throw new SessionValidationError("UDP byte accounting availability does not match its bridge journal.");
  }
  if (!journal || !byteAccounting) return;
  const expectedUdpBytes = journal.bytes + (journal.datagrams * 8);
  const expectedIpHeaderBytes = journal.bind.family === "IPv4" ? 20 : 40;
  const expectedIpBytes = expectedUdpBytes + (journal.datagrams * expectedIpHeaderBytes);
  if (
    byteAccounting.datagrams !== journal.datagrams
    || byteAccounting.payload.bytes !== journal.bytes
    || byteAccounting.udp.bytes !== expectedUdpBytes
    || byteAccounting.ip.bytes !== expectedIpBytes
    || byteAccounting.ip.family !== journal.bind.family
    || byteAccounting.ip.headerBytesPerDatagram !== expectedIpHeaderBytes
  ) {
    throw new SessionValidationError("UDP byte accounting does not reconcile with immutable bridge counters.");
  }
}

function assertTransportProvenance(document: SessionDocumentV2): void {
  const provenance = document.transportProvenance;
  const receiptHasIncompleteCode = document.captureIntegrity.issueCodes.includes("transport-provenance-incomplete");
  if (!provenance) {
    if (receiptHasIncompleteCode) {
      throw new SessionValidationError("Capture integrity declares incomplete transport provenance that is not present.");
    }
    return;
  }
  if (provenance.sourceId !== document.source.id || provenance.transport !== document.source.kind) {
    throw new SessionValidationError("Transport provenance does not match the declared session source.", [
      `Provenance ${provenance.transport}:${provenance.sourceId}; source ${document.source.kind}:${document.source.id}`,
    ]);
  }
  const issueCodes = new Set(provenance.issueCodes);
  if (issueCodes.size !== provenance.issueCodes.length) {
    throw new SessionValidationError("Transport provenance contains duplicate issue codes.");
  }

  if (provenance.transport === "udp") {
    const invalidIssue = provenance.issueCodes.find((code) => !UDP_PROVENANCE_ISSUE_CODES.has(code));
    if (invalidIssue) {
      throw new SessionValidationError("A transport-provenance issue code does not apply to UDP.", [invalidIssue]);
    }
    const attributedEndpoints: UdpRemoteEndpoint[] = [];
    const distinctEndpoints = new Map<string, UdpRemoteEndpoint>();
    for (const record of document.records) {
      const endpoint = record.transport.remoteEndpoint;
      if (!endpoint) continue;
      attributedEndpoints.push(endpoint);
      if (!distinctEndpoints.has(udpEndpointKey(endpoint))) distinctEndpoints.set(udpEndpointKey(endpoint), endpoint);
    }
    const expectedDistinctEndpoints = [...distinctEndpoints.values()];
    const summary = provenance.endpointAttribution;
    if (
      summary.totalRecords !== document.records.length
      || summary.attributedRecords !== attributedEndpoints.length
      || summary.unattributedRecords !== document.records.length - attributedEndpoints.length
      || summary.attributedRecords + summary.unattributedRecords !== summary.totalRecords
      || summary.distinctEndpoints.length !== expectedDistinctEndpoints.length
      || summary.distinctEndpoints.some((endpoint, index) => !sameUdpEndpoint(endpoint, expectedDistinctEndpoints[index]!))
    ) {
      throw new SessionValidationError("UDP endpoint-attribution summary does not match immutable session records.");
    }

    const endpointAttributionIncomplete = summary.unattributedRecords > 0;
    const journalUnavailable = provenance.journal === null;
    let journalIncomplete = false;
    let journalCounterMismatch = false;
    if (provenance.journal) {
      assertUdpJournalStructure(document, provenance.journal);
      journalIncomplete = provenance.journal.state !== "clean"
        || !provenance.journal.entriesComplete
        || provenance.journal.omittedEntries > 0;
      journalCounterMismatch = provenance.journal.datagrams !== document.records.length
        || provenance.journal.bytes !== document.captureIntegrity.retained.bytes
        || provenance.journal.datagrams !== document.captureIntegrity.input.transportReportedUnits
        || provenance.journal.bytes !== document.captureIntegrity.input.transportReportedBytes;
    }
    assertProvenanceIssue(issueCodes, "udp-bridge-journal-unavailable", journalUnavailable,
      "UDP provenance journal availability and issue codes are inconsistent.");
    assertProvenanceIssue(issueCodes, "udp-bridge-journal-incomplete", journalIncomplete,
      "UDP provenance journal completeness and issue codes are inconsistent.");
    assertProvenanceIssue(issueCodes, "udp-bridge-journal-counter-mismatch", journalCounterMismatch,
      "UDP provenance journal counters and issue codes are inconsistent.");
    assertProvenanceIssue(issueCodes, "udp-endpoint-attribution-incomplete", endpointAttributionIncomplete,
      "UDP endpoint attribution and issue codes are inconsistent.");
    assertProvenanceIssue(issueCodes, "udp-kernel-drop-counter-unavailable", provenance.journal !== null
      && provenance.journal.kernelDroppedDatagrams === null,
      "UDP kernel-drop availability and provenance issue codes are inconsistent.");
    assertUdpByteAccounting(provenance);

    const kernelDrops = provenance.journal?.kernelDroppedDatagrams ?? 0;
    const dropEvents = document.transportEvents.filter((event) => event.type === "udp-kernel-drops-observed");
    const receiptHasDropCode = document.captureIntegrity.issueCodes.includes("udp-kernel-drops-observed");
    if (
      receiptHasDropCode !== (kernelDrops > 0)
      || dropEvents.length > 1
      || (kernelDrops === 0 && dropEvents.length > 0)
      || (kernelDrops > 0 && document.captureIntegrity.eventLogComplete && dropEvents.length !== 1)
      || dropEvents.some((event) => (
        event.kernelDroppedDatagrams !== kernelDrops
        || event.counterSource !== provenance.journal?.kernelDroppedDatagramsSource
      ))
    ) {
      throw new SessionValidationError("UDP kernel-drop evidence does not reconcile across the journal, event log, and receipt.");
    }

    const incomplete = journalUnavailable || journalIncomplete || journalCounterMismatch || endpointAttributionIncomplete;
    if ((provenance.status === "incomplete") !== incomplete) {
      throw new SessionValidationError("UDP transport-provenance status does not match its durable evidence.");
    }
  } else {
    const invalidIssue = provenance.issueCodes.find((code) => !SERIAL_PROVENANCE_ISSUE_CODES.has(code));
    if (invalidIssue) {
      throw new SessionValidationError("A transport-provenance issue code does not apply to serial.", [invalidIssue]);
    }
    const identifiersUnavailable = provenance.device.usbVendorId === null
      && provenance.device.usbProductId === null
      && provenance.device.bluetoothServiceClassId === null;
    assertProvenanceIssue(issueCodes, "serial-device-identifiers-unavailable", identifiersUnavailable,
      "Serial device identifiers and provenance issue codes are inconsistent.");
    if (provenance.status !== "verified") {
      throw new SessionValidationError("Complete serial settings must produce verified transport provenance.");
    }
  }

  if (receiptHasIncompleteCode !== (provenance.status === "incomplete")) {
    throw new SessionValidationError("Capture integrity and transport-provenance status are inconsistent.");
  }
}

function assertV2CaptureEvidence(document: SessionDocumentV2): void {
  const eventIds = new Set<string>();
  let previousTimedStartUs = -1;
  for (const [position, event] of document.transportEvents.entries()) {
    if (eventIds.has(event.id)) {
      throw new SessionValidationError("The replay contains duplicate transport event IDs.", [
        `Duplicate transport event ID: ${event.id}`,
      ]);
    }
    eventIds.add(event.id);
    if (event.index !== position) {
      throw new SessionValidationError("Transport event indices must be contiguous and zero-based.", [
        `${event.id} declares index ${event.index}; expected ${position}`,
      ]);
    }
    if (event.transport !== document.source.kind) {
      throw new SessionValidationError("A transport event does not match the declared session source.", [
        `${event.id} uses ${event.transport}; source uses ${document.source.kind}`,
      ]);
    }

    const startUs = transportEventStartUs(event);
    if (startUs != null) {
      if (startUs >= document.durationUs) {
        throw new SessionValidationError("A transport event falls outside the declared session duration.", [
          `${event.id} starts at ${startUs}µs; duration is ${document.durationUs}µs`,
        ]);
      }
      if (startUs < previousTimedStartUs) {
        throw new SessionValidationError("Transport event timestamps are not monotonic.", [
          `${event.id} at ${startUs}µs follows ${previousTimedStartUs}µs`,
        ]);
      }
      previousTimedStartUs = startUs;
    }
    if (event.scope.kind === "interval") {
      if (event.scope.endUs <= event.scope.startUs || event.scope.endUs > document.durationUs) {
        throw new SessionValidationError("A transport event interval is outside the declared session duration.", [
          `${event.id} declares [${event.scope.startUs}, ${event.scope.endUs}) within duration ${document.durationUs}µs`,
        ]);
      }
    }
    if (
      event.type === "udp-event-sequence-discontinuity"
      && event.expectedSequence === event.observedSequence
    ) {
      throw new SessionValidationError("A UDP sequence-discontinuity event does not describe a discontinuity.", [
        `${event.id} expected and observed sequence ${event.expectedSequence}`,
      ]);
    }
    if (event.type === "udp-counter-mismatch") {
      const countersReconcile = event.bridgeDatagrams === event.browserDatagrams
        && event.bridgeBytes === event.browserBytes
        && event.browserDatagrams === event.retainedRecords
        && event.browserBytes === event.retainedBytes;
      if (countersReconcile) {
        throw new SessionValidationError("A UDP counter-mismatch event contains matching counters.", [event.id]);
      }
    }
    if (event.type === "serial-counter-mismatch" && event.observedBytes === event.retainedBytes) {
      throw new SessionValidationError("A serial counter-mismatch event contains matching byte counts.", [event.id]);
    }
    if (
      (event.type === "capture-backpressure" || event.type === "capture-limit")
      && event.component === "udp-prestatus-buffer"
      && event.transport !== "udp"
    ) {
      throw new SessionValidationError("Only UDP events may reference the pre-status buffer.", [event.id]);
    }
  }

  const receipt = document.captureIntegrity;
  const retainedBytes = document.records.reduce((total, record) => total + record.captureBytes, 0);
  if (receipt.retained.records !== document.records.length || receipt.retained.bytes !== retainedBytes) {
    throw new SessionValidationError("The capture-integrity receipt does not match retained session records.", [
      `Receipt declares ${receipt.retained.records} records and ${receipt.retained.bytes} bytes; document contains ${document.records.length} records and ${retainedBytes} bytes`,
    ]);
  }
  if ((receipt.stopDisposition === "not-observed") !== (receipt.stopOffsetUs === null)) {
    throw new SessionValidationError("The capture-integrity stop disposition and offset are inconsistent.");
  }
  if (receipt.stopOffsetUs != null && receipt.stopOffsetUs > document.durationUs) {
    throw new SessionValidationError("The capture-integrity stop offset exceeds the session duration.", [
      `${receipt.stopOffsetUs}µs exceeds ${document.durationUs}µs`,
    ]);
  }

  const issueCodes = new Set(receipt.issueCodes);
  if (issueCodes.size !== receipt.issueCodes.length) {
    throw new SessionValidationError("The capture-integrity receipt contains duplicate issue codes.");
  }
  const eventTypes = new Set(document.transportEvents.map((event) => event.type));
  for (const event of document.transportEvents) {
    if (!issueCodes.has(event.type)) {
      throw new SessionValidationError("A transport event is not represented in the capture-integrity receipt.", [
        `${event.id} requires issue code ${event.type}`,
      ]);
    }
    if (event.type === "udp-counter-mismatch") {
      const input = receipt.input;
      if (
        event.bridgeDatagrams !== input.transportReportedUnits
        || event.bridgeBytes !== input.transportReportedBytes
        || event.browserDatagrams !== input.observedUnits
        || event.browserBytes !== input.observedBytes
        || event.retainedRecords !== receipt.retained.records
        || event.retainedBytes !== receipt.retained.bytes
      ) {
        throw new SessionValidationError("A UDP counter-mismatch event conflicts with the capture-integrity receipt.", [event.id]);
      }
    }
    if (event.type === "serial-counter-mismatch") {
      const input = receipt.input;
      if (
        event.observedReads !== input.observedUnits
        || event.observedBytes !== input.observedBytes
        || event.retainedRecords !== receipt.retained.records
        || event.retainedBytes !== receipt.retained.bytes
      ) {
        throw new SessionValidationError("A serial counter-mismatch event conflicts with the capture-integrity receipt.", [event.id]);
      }
    }
  }

  if (document.source.kind !== "file") {
    const allowedIssueCodes = document.source.kind === "udp" ? UDP_CAPTURE_ISSUE_CODES : SERIAL_CAPTURE_ISSUE_CODES;
    const invalidIssueCode = receipt.issueCodes.find((code) => !allowedIssueCodes.has(code));
    if (invalidIssueCode) {
      throw new SessionValidationError("A capture-integrity issue code does not apply to the declared live source.", [
        `${invalidIssueCode} is not valid for ${document.source.kind}`,
      ]);
    }
    if (receipt.eventLogComplete === issueCodes.has("event-log-incomplete")) {
      throw new SessionValidationError("The capture-integrity event-log status and issue codes are inconsistent.");
    }
    for (const code of issueCodes) {
      if (
        receipt.eventLogComplete
        && TRANSPORT_EVENT_ISSUE_CODES.has(code)
        && !eventTypes.has(code as TransportEvent["type"])
      ) {
        throw new SessionValidationError("A capture-integrity issue code is not represented by a transport event.", [code]);
      }
    }
  }

  if ((receipt.stopDisposition === "unconfirmed") !== issueCodes.has("shutdown-unconfirmed")) {
    throw new SessionValidationError("The capture-integrity shutdown status and issue codes are inconsistent.");
  }
  const shutdownEvents = document.transportEvents.filter((event) => event.type === "shutdown-unconfirmed");
  if (
    (receipt.stopDisposition === "unconfirmed" && (
      shutdownEvents.length > 1
      || (receipt.eventLogComplete && shutdownEvents.length !== 1)
    ))
    || (receipt.stopDisposition !== "unconfirmed" && shutdownEvents.length !== 0)
  ) {
    throw new SessionValidationError("The capture-integrity shutdown status is not represented by its terminal transport event.");
  }

  const durationLimitEvents = document.transportEvents.filter(
    (event) => event.type === "capture-limit" && event.limit === "duration",
  );
  const hasDurationCappedCode = issueCodes.has("duration-capped");
  if (
    durationLimitEvents.length > 1
    || (!hasDurationCappedCode && durationLimitEvents.length > 0)
    || (hasDurationCappedCode && receipt.eventLogComplete && durationLimitEvents.length !== 1)
  ) {
    throw new SessionValidationError("The duration-capped receipt issue and capture-limit event are inconsistent.");
  }

  const input = receipt.input;
  const udpMismatchEvents = document.transportEvents.filter((event) => event.type === "udp-counter-mismatch");
  const serialMismatchEvents = document.transportEvents.filter((event) => event.type === "serial-counter-mismatch");
  if (document.source.kind === "udp") {
    if (input.unit !== "datagram") {
      throw new SessionValidationError("A UDP capture-integrity receipt requires datagram counters.");
    }
    if (receipt.assessmentBasis === "udp-bridge-reconciled") {
      if (
        input.observedUnits == null
        || input.observedBytes == null
        || input.transportReportedUnits == null
        || input.transportReportedBytes == null
      ) {
        throw new SessionValidationError("A bridge-assessed UDP receipt requires bridge and browser counters.");
      }
      const countersReconcile = input.observedUnits === input.transportReportedUnits
        && input.observedBytes === input.transportReportedBytes
        && receipt.retained.records === input.observedUnits
        && receipt.retained.bytes === input.observedBytes;
      const hasMismatchCode = issueCodes.has("udp-counter-mismatch");
      if (countersReconcile && (hasMismatchCode || udpMismatchEvents.length > 0)) {
        throw new SessionValidationError("A reconciled UDP receipt declares a counter mismatch.");
      }
      if (!countersReconcile && (
        !hasMismatchCode
        || udpMismatchEvents.length > 1
        || (receipt.eventLogComplete && udpMismatchEvents.length !== 1)
      )) {
        throw new SessionValidationError("Unreconciled UDP counters require one matching counter-mismatch issue and event.");
      }
    } else if (receipt.assessmentBasis === "udp-browser-observed") {
      if (
        receipt.status !== "incomplete"
        || receipt.stopDisposition !== "unconfirmed"
        || input.observedUnits == null
        || input.observedBytes == null
        || input.transportReportedUnits !== null
        || input.transportReportedBytes !== null
      ) {
        throw new SessionValidationError("A browser-observed UDP receipt must honestly describe unavailable terminal bridge counters.");
      }
      if (issueCodes.has("udp-counter-mismatch") || udpMismatchEvents.length > 0) {
        throw new SessionValidationError("A browser-only UDP receipt cannot claim bridge counter reconciliation or mismatch.");
      }
    } else if (receipt.assessmentBasis === "recorder-only") {
      if (
        receipt.status !== "incomplete"
        || receipt.stopDisposition !== "unconfirmed"
        || receipt.eventLogComplete
        || input.observedUnits !== null
        || input.observedBytes !== null
        || input.transportReportedUnits !== null
        || input.transportReportedBytes !== null
      ) {
        throw new SessionValidationError("A recorder-only UDP receipt must remain incomplete and contain no adapter observations.");
      }
      if (issueCodes.has("udp-counter-mismatch") || udpMismatchEvents.length > 0) {
        throw new SessionValidationError("A recorder-only UDP receipt cannot claim a counter mismatch without observations.");
      }
    } else {
      throw new SessionValidationError("A UDP session contains capture-integrity provenance for another source.");
    }
  } else if (document.source.kind === "serial") {
    if (input.unit !== "serial-read") {
      throw new SessionValidationError("A serial capture-integrity receipt requires serial-read counters.");
    }
    if (receipt.assessmentBasis === "web-serial-observed") {
      if (
        input.observedUnits == null
        || input.observedBytes == null
        || input.transportReportedUnits !== null
        || input.transportReportedBytes !== null
      ) {
        throw new SessionValidationError("A Web Serial capture-integrity receipt contains invalid input counters.");
      }
      const bytesReconcile = receipt.retained.bytes === input.observedBytes;
      const hasMismatchCode = issueCodes.has("serial-counter-mismatch");
      if (bytesReconcile && (hasMismatchCode || serialMismatchEvents.length > 0)) {
        throw new SessionValidationError("A reconciled serial receipt declares a counter mismatch.");
      }
      if (!bytesReconcile && (
        !hasMismatchCode
        || serialMismatchEvents.length > 1
        || (receipt.eventLogComplete && serialMismatchEvents.length !== 1)
      )) {
        throw new SessionValidationError("Unreconciled serial byte counts require one matching counter-mismatch issue and event.");
      }
    } else if (receipt.assessmentBasis === "recorder-only") {
      if (
        receipt.status !== "incomplete"
        || receipt.stopDisposition !== "unconfirmed"
        || receipt.eventLogComplete
        || input.observedUnits !== null
        || input.observedBytes !== null
        || input.transportReportedUnits !== null
        || input.transportReportedBytes !== null
      ) {
        throw new SessionValidationError("A recorder-only serial receipt must remain incomplete and contain no adapter observations.");
      }
      if (issueCodes.has("serial-counter-mismatch") || serialMismatchEvents.length > 0) {
        throw new SessionValidationError("A recorder-only serial receipt cannot claim a counter mismatch without observations.");
      }
    } else {
      throw new SessionValidationError("A serial session contains capture-integrity provenance for another source.");
    }
  } else {
    if (
      receipt.assessmentBasis !== "file-source-unassessed"
      || receipt.status !== "unknown"
      || receipt.stopDisposition !== "not-observed"
      || receipt.eventLogComplete
      || document.transportEvents.length > 0
      || input.unit !== "unknown"
      || input.observedUnits !== null
      || input.observedBytes !== null
      || input.transportReportedUnits !== null
      || input.transportReportedBytes !== null
      || receipt.issueCodes.length !== 1
      || receipt.issueCodes[0] !== "file-source-unassessed"
    ) {
      throw new SessionValidationError("A file-source session must declare unassessed capture integrity.");
    }
  }

  if (receipt.status === "verified") {
    if (
      receipt.stopDisposition !== "confirmed"
      || !receipt.eventLogComplete
      || receipt.issueCodes.length > 0
      || document.transportEvents.length > 0
    ) {
      throw new SessionValidationError("A verified capture-integrity receipt contains unresolved issues.");
    }
  } else if (receipt.status === "incomplete") {
    if (
      receipt.issueCodes.length === 0
      && document.transportEvents.length === 0
      && receipt.eventLogComplete
      && receipt.stopDisposition === "confirmed"
    ) {
      throw new SessionValidationError("An incomplete capture-integrity receipt does not identify an integrity issue.");
    }
  } else if (document.source.kind !== "file") {
    throw new SessionValidationError("Only an unassessed file-source session may use unknown capture integrity in version 2.");
  }

  assertTransportProvenance(document);
}

export function validateSessionDocument(
  input: unknown,
  observer?: SessionDerivationObserver,
): SessionDocument {
  reportDerivationProgress(observer, "validating", 0, 1);
  const result = sessionDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new SessionValidationError(
      "The replay file does not match ReplayCase session format version 1 or 2.",
      result.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".") || "document"}: ${issue.message}`),
    );
  }

  const document = result.data;
  try {
    resolveDecoderPack(
      document.decoder,
      document.formatVersion === 2 ? document.decoderPack : undefined,
    );
  } catch (error) {
    const details = error instanceof DecoderPackValidationError ? error.details : [];
    throw new SessionValidationError("The replay references an unsupported decoder schema or unavailable decoder pack.", [
      `Received ${document.decoder.id} ${document.decoder.revision} (${document.decoder.schemaHash})`,
      ...details,
      ...BUILT_IN_DECODER_PACKS.map((pack) => {
        const descriptor = decoderDescriptorForPack(pack);
        return `Supported ${pack.id} ${pack.revision} (${descriptor.schemaHash})`;
      }),
    ]);
  }
  const seenIds = new Set<string>();
  let previousOffset = -1;
  const recordTotal = document.records.length;

  for (const [position, record] of document.records.entries()) {
    if (seenIds.has(record.id)) {
      throw new SessionValidationError("The replay contains duplicate record IDs.", [`Duplicate record ID: ${record.id}`]);
    }
    seenIds.add(record.id);

    if (record.index !== position) {
      throw new SessionValidationError("Replay record indices must be contiguous and zero-based.", [
        `${record.id} declares index ${record.index}; expected ${position}`,
      ]);
    }

    if (record.sourceId !== document.source.id) {
      throw new SessionValidationError("A replay record references an unknown source.", [
        `${record.id} references ${record.sourceId}; expected ${document.source.id}`,
      ]);
    }
    if (record.offsetUs < previousOffset) {
      throw new SessionValidationError("Replay timestamps are not monotonic.", [
        `${record.id} at ${record.offsetUs}µs follows ${previousOffset}µs`,
      ]);
    }
    if (record.offsetUs >= document.durationUs) {
      throw new SessionValidationError("A replay record falls outside the declared session duration.", [
        `${record.id} at ${record.offsetUs}µs exceeds duration ${document.durationUs}µs`,
      ]);
    }
    if (record.captureBytes !== record.dataHex.length / 2) {
      throw new SessionValidationError("A replay record has inconsistent byte counts.", [
        `${record.id} declares ${record.captureBytes} bytes but contains ${record.dataHex.length / 2}`,
      ]);
    }
    if (record.wireBytes < record.captureBytes) {
      throw new SessionValidationError("A replay record declares fewer wire bytes than captured bytes.", [
        `${record.id} declares ${record.wireBytes} wire bytes and ${record.captureBytes} captured bytes`,
      ]);
    }
    if (record.transport.kind !== document.source.kind) {
      throw new SessionValidationError("A replay record transport does not match the declared source.", [
        `${record.id} uses ${record.transport.kind}; source uses ${document.source.kind}`,
      ]);
    }
    previousOffset = record.offsetUs;
    reportDerivationProgress(observer, "validating", position + 1, recordTotal);
  }

  const incidentIds = new Set<string>();
  for (const incident of document.incidents) {
    if (incidentIds.has(incident.id)) {
      throw new SessionValidationError("The replay contains duplicate incident IDs.", [`Duplicate incident ID: ${incident.id}`]);
    }
    incidentIds.add(incident.id);
    assertIncidentWithinDuration(incident, document.durationUs);
  }

  if (document.formatVersion === 2) assertV2CaptureEvidence(document);

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: document.displayTimeZone }).format();
  } catch {
    throw new SessionValidationError("The replay declares an invalid IANA time zone.", [document.displayTimeZone]);
  }

  reportDerivationProgress(observer, "validating", recordTotal, recordTotal);
  return document;
}

function numericField(frame: DecodedFrame, fieldName: string): number | null {
  return frame.status === "complete" ? getNumericField(frame, fieldName) : null;
}

function isTrustedMetricFrame(frame: DecodedFrame): boolean {
  return frame.status === "complete" && frame.integrity.status === "valid";
}

function createMetricBuckets(document: SessionDocument, frames: readonly DecodedFrame[]): MetricBucket[] {
  const bucketCount = Math.ceil(document.durationUs / SECOND_US);
  const bucketRows = Array.from({ length: bucketCount }, (_, index) => ({
    offsetUs: index * SECOND_US,
    received: 0,
    transportMissing: 0,
    sequenceMissing: 0,
    rssiTotal: 0,
    rssiCount: 0,
    jitterMs: null as number | null,
    latitude: null as number | null,
    longitude: null as number | null,
    altitudeM: null as number | null,
    radioTempC: null as number | null,
    busVoltageV: null as number | null,
    familyCounts: {} as Record<string, number>,
  }));

  let previousSequence: number | null = null;
  let previousTransitMs: number | null = null;
  let untrustedFramesSinceSequence = 0;
  let jitterMs = 0;
  let previousDropCounter: number | null = null;
  for (const frame of frames) {
    const bucketIndex = Math.min(bucketRows.length - 1, Math.floor(frame.offsetUs / SECOND_US));
    const bucket = bucketRows[bucketIndex];
    if (!bucket) continue;
    bucket.received += 1;

    const dropCounter = frame.sourceRecord.transport.kernelDropCounter;
    if (dropCounter != null) {
      if (previousDropCounter != null && dropCounter >= previousDropCounter) {
        bucket.transportMissing += dropCounter - previousDropCounter;
      }
      previousDropCounter = dropCounter;
    }

    const rssi = frame.sourceRecord.signal?.rssiDbm;
    if (typeof rssi === "number") {
      bucket.rssiTotal += rssi;
      bucket.rssiCount += 1;
    }

    if (isTrustedMetricFrame(frame) && frame.sequence != null && frame.deviceTimeMs != null) {
      if (previousSequence != null) {
        const delta = (frame.sequence - previousSequence + 65_536) % 65_536;
        if (delta > 1 && delta <= 32_768) {
          bucket.sequenceMissing += Math.max(0, delta - 1 - untrustedFramesSinceSequence);
        }
      }
      previousSequence = frame.sequence;
      untrustedFramesSinceSequence = 0;

      const transitMs = frame.offsetUs / 1000 - frame.deviceTimeMs;
      if (previousTransitMs != null) {
        const delta = Math.abs(transitMs - previousTransitMs);
        jitterMs += (delta - jitterMs) / 16;
      }
      previousTransitMs = transitMs;
      bucket.jitterMs = jitterMs;
    } else {
      untrustedFramesSinceSequence += 1;
    }

    const latitude = numericField(frame, "latitude");
    const longitude = numericField(frame, "longitude");
    const altitude = numericField(frame, "altitude");
    const radioTemp = numericField(frame, "radioTemp");
    const busVoltage = numericField(frame, "busVoltage");
    if (latitude != null) bucket.latitude = latitude;
    if (longitude != null) bucket.longitude = longitude;
    if (altitude != null) bucket.altitudeM = altitude;
    if (radioTemp != null) bucket.radioTempC = radioTemp;
    if (busVoltage != null) bucket.busVoltageV = busVoltage;

    const familyName = frame.familyName;
    bucket.familyCounts[familyName] = (bucket.familyCounts[familyName] ?? 0) + 1;
  }

  let carriedLatitude: number | null = null;
  let carriedLongitude: number | null = null;
  let carriedAltitude: number | null = null;
  let carriedRadioTemp: number | null = null;
  let carriedBusVoltage: number | null = null;
  for (const bucket of bucketRows) {
    if (bucket.latitude != null) carriedLatitude = bucket.latitude;
    if (bucket.longitude != null) carriedLongitude = bucket.longitude;
    if (bucket.altitudeM != null) carriedAltitude = bucket.altitudeM;
    if (bucket.radioTempC != null) carriedRadioTemp = bucket.radioTempC;
    if (bucket.busVoltageV != null) carriedBusVoltage = bucket.busVoltageV;
    bucket.latitude = carriedLatitude;
    bucket.longitude = carriedLongitude;
    bucket.altitudeM = carriedAltitude;
    bucket.radioTempC = carriedRadioTemp;
    bucket.busVoltageV = carriedBusVoltage;
  }

  return bucketRows.map((bucket) => {
    // Kernel-drop and sequence-gap signals may describe the same missing frames.
    // Use the larger per-second estimate so both sources contribute without double counting.
    const missing = Math.max(bucket.transportMissing, bucket.sequenceMissing);
    const expected = bucket.received + missing;
    return {
      offsetUs: bucket.offsetUs,
      received: bucket.received,
      missing,
      throughput: bucket.received,
      lossPct: expected > 0 ? (missing / expected) * 100 : 0,
      rssiDbm: bucket.rssiCount > 0 ? bucket.rssiTotal / bucket.rssiCount : null,
      jitterMs: bucket.jitterMs,
      latitude: bucket.latitude,
      longitude: bucket.longitude,
      altitudeM: bucket.altitudeM,
      radioTempC: bucket.radioTempC,
      busVoltageV: bucket.busVoltageV,
      familyCounts: bucket.familyCounts,
    };
  });
}

function makeDiagnostic(
  type: Exclude<DiagnosticEvent["type"], "capture-path-event">,
  severity: DiagnosticEvent["severity"],
  startUs: number,
  title: string,
  description: string,
  frameIds: string[] = [],
): DiagnosticEvent {
  const domain: DiagnosticEvent["domain"] = type === "link-degraded"
    || type === "loss-burst"
    || type === "recovery"
    ? "link"
    : type === "crc-failure" || type === "checksum-failure" || type === "partial-frame"
      ? "unknown"
      : "decoder";
  return {
    id: `${type}-${startUs}${frameIds.length > 0 ? `-${frameIds.join("-")}` : ""}`,
    type,
    domain,
    severity,
    startUs,
    title,
    description,
    frameIds,
  };
}

const TRANSPORT_EVENT_TITLES: Record<TransportEvent["type"], string> = {
  "udp-event-sequence-discontinuity": "UDP event-stream sequence discontinuity",
  "udp-counter-mismatch": "UDP capture counters did not reconcile",
  "udp-kernel-drops-observed": "Host UDP socket reported dropped datagrams",
  "udp-bridge-error": "UDP bridge error",
  "udp-event-stream-disconnected": "UDP event stream disconnected",
  "capture-backpressure": "Capture backpressure",
  "capture-limit": "Capture limit reached",
  "serial-read-error": "Serial read error",
  "serial-disconnected": "Serial device disconnected",
  "serial-tail-recovery-failed": "Serial tail recovery failed",
  "serial-counter-mismatch": "Serial capture bytes did not reconcile",
  "shutdown-unconfirmed": "Capture shutdown unconfirmed",
};

function transportEventDiagnostic(event: TransportEvent, durationUs: number): DiagnosticEvent {
  const bounds = event.scope.kind === "point"
    ? { startUs: event.scope.offsetUs }
    : event.scope.kind === "interval"
      ? { startUs: event.scope.startUs, endUs: event.scope.endUs }
      : { startUs: 0, endUs: durationUs };
  return {
    id: `transport-${event.id}`,
    type: "capture-path-event",
    domain: "capture-path",
    severity: event.severity,
    ...bounds,
    title: TRANSPORT_EVENT_TITLES[event.type],
    description: event.message,
    frameIds: [],
  };
}

function transportProvenanceDiagnostic(
  provenance: TransportProvenance,
  durationUs: number,
): DiagnosticEvent | null {
  if (provenance.status !== "incomplete") return null;
  return {
    id: "transport-provenance-incomplete",
    type: "capture-path-event",
    domain: "capture-path",
    severity: "warning",
    startUs: 0,
    endUs: durationUs,
    title: "Transport provenance incomplete",
    description: `Transport provenance could not be fully reconciled: ${provenance.issueCodes.join(", ")}.`,
    frameIds: [],
  };
}

function deriveDiagnostics(
  frames: readonly DecodedFrame[],
  buckets: readonly MetricBucket[],
  decoderId: string,
): DiagnosticEvent[] {
  const events: DiagnosticEvent[] = [];
  let lowRssiBuckets = 0;
  let recoveryBuckets = 0;
  let lossBuckets = 0;
  let linkDegraded = false;
  let lossBurst = false;

  for (const bucket of buckets) {
    if (bucket.rssiDbm != null && bucket.rssiDbm < -90) {
      lowRssiBuckets += 1;
      recoveryBuckets = 0;
    } else if (bucket.rssiDbm != null && bucket.rssiDbm > -78) {
      recoveryBuckets += 1;
      lowRssiBuckets = 0;
    } else {
      lowRssiBuckets = 0;
      recoveryBuckets = 0;
    }

    if (!linkDegraded && lowRssiBuckets === 2) {
      linkDegraded = true;
      events.push(makeDiagnostic("link-degraded", "warning", bucket.offsetUs - SECOND_US, "Link quality degraded", `RSSI remained below −90 dBm; observed ${bucket.rssiDbm?.toFixed(0)} dBm.`));
    }
    if (linkDegraded && recoveryBuckets === 5) {
      linkDegraded = false;
      events.push(makeDiagnostic("recovery", "info", bucket.offsetUs - 4 * SECOND_US, "Link recovered", `RSSI stabilized above −78 dBm with ${bucket.lossPct.toFixed(1)}% loss.`));
    }

    if (bucket.lossPct >= 5) lossBuckets += 1;
    else lossBuckets = 0;
    if (!lossBurst && lossBuckets === 3) {
      lossBurst = true;
      events.push(makeDiagnostic("loss-burst", "critical", bucket.offsetUs - 2 * SECOND_US, "Sequence loss burst", `Missing sequences reached ${bucket.lossPct.toFixed(1)}% in the one-second window.`));
    }
    if (lossBurst && bucket.lossPct < 1) lossBurst = false;
  }

  let consecutiveInvalid = 0;
  let consecutiveValidAfterResync = 0;
  let validRecoveryStartedUs: number | null = null;
  let resyncing = false;
  for (const frame of frames) {
    if (frame.status !== "complete") {
      consecutiveInvalid += 1;
      consecutiveValidAfterResync = 0;
      validRecoveryStartedUs = null;
      const isCrcFailure = frame.integrity.status === "crc-failed";
      const isChecksumFailure = frame.integrity.status === "checksum-failed";
      const isIntegrityFailure = isCrcFailure || isChecksumFailure;
      events.push(makeDiagnostic(
        isCrcFailure ? "crc-failure" : isChecksumFailure ? "checksum-failure" : "partial-frame",
        isIntegrityFailure ? "critical" : "warning",
        frame.offsetUs,
        isCrcFailure ? "CRC failure" : isChecksumFailure ? "Checksum failure" : "Partial frame retained",
        isIntegrityFailure ? "The record checksum did not match the value calculated by the declared decoder pack." : "The frame could not be decoded completely and remains available for inspection.",
        [frame.id],
      ));
      if (!resyncing && consecutiveInvalid === 2) {
        resyncing = true;
        events.push(makeDiagnostic("decoder-resync", "warning", frame.offsetUs, "Decoder resync", `Two consecutive invalid boundaries forced ${decoderId} into resynchronization.`, [frame.id]));
      }
    } else {
      consecutiveInvalid = 0;
      if (resyncing) {
        if (validRecoveryStartedUs == null) validRecoveryStartedUs = frame.offsetUs;
        consecutiveValidAfterResync += 1;
        const stableForUs = frame.offsetUs - validRecoveryStartedUs;
        if (
          consecutiveValidAfterResync >= DECODER_RELOCK_MIN_VALID_FRAMES
          && stableForUs >= DECODER_RELOCK_STABILITY_US
        ) {
          resyncing = false;
          validRecoveryStartedUs = null;
          events.push(makeDiagnostic(
            "decoder-locked",
            "info",
            frame.offsetUs,
            "Decoder locked",
            "At least three valid checksummed records over 40 uninterrupted seconds restored decoder boundary lock.",
            [frame.id],
          ));
        }
      }
    }
  }

  return events.sort((left, right) => left.startUs - right.startUs);
}

function missingFramesInRange(frames: readonly DecodedFrame[], startUs: number, endUs: number): number {
  const startIndex = lowerBoundByOffset(frames, startUs);
  const endIndex = lowerBoundByOffset(frames, endUs);
  const rangeFrames = frames.slice(startIndex, endIndex);
  let previousCounter = startIndex > 0
    ? (frames[startIndex - 1]?.sourceRecord.transport.kernelDropCounter ?? null)
    : null;
  let transportMissing = 0;
  for (const frame of rangeFrames) {
    const counter = frame.sourceRecord.transport.kernelDropCounter;
    if (counter != null && previousCounter != null && counter >= previousCounter) transportMissing += counter - previousCounter;
    if (counter != null) previousCounter = counter;
  }

  let previousSequence: number | null = null;
  let untrustedFramesSinceSequence = 0;
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const preceding = frames[index];
    if (preceding && isTrustedMetricFrame(preceding) && preceding.sequence != null) {
      previousSequence = preceding.sequence;
      for (let between = index + 1; between < startIndex; between += 1) {
        const frame = frames[between];
        if (frame && !isTrustedMetricFrame(frame)) untrustedFramesSinceSequence += 1;
      }
      break;
    }
  }
  let sequenceMissing = 0;
  for (const frame of rangeFrames) {
    if (isTrustedMetricFrame(frame) && frame.sequence != null) {
      if (previousSequence != null) {
        const delta = (frame.sequence - previousSequence + 65_536) % 65_536;
        if (delta > 1 && delta <= 32_768) sequenceMissing += Math.max(0, delta - 1 - untrustedFramesSinceSequence);
      }
      previousSequence = frame.sequence;
      untrustedFramesSinceSequence = 0;
    } else {
      untrustedFramesSinceSequence += 1;
    }
  }
  // Both counters can describe the same loss episode; retain the stronger estimate without summing overlap.
  return Math.max(transportMissing, sequenceMissing);
}

function peakJitterInRange(frames: readonly DecodedFrame[]): number | null {
  let previousTransitMs: number | null = null;
  let jitterMs = 0;
  let peak: number | null = null;
  for (const frame of frames) {
    if (!isTrustedMetricFrame(frame) || frame.deviceTimeMs == null) continue;
    const transitMs = frame.offsetUs / 1000 - frame.deviceTimeMs;
    if (previousTransitMs != null) {
      const delta = Math.abs(transitMs - previousTransitMs);
      jitterMs += (delta - jitterMs) / 16;
      peak = peak == null ? jitterMs : Math.max(peak, jitterMs);
    }
    previousTransitMs = transitMs;
  }
  return peak;
}

function linkAvailabilityInRange(frames: readonly DecodedFrame[], startUs: number, endUs: number): number | null {
  const bucketCount = Math.ceil((endUs - startUs) / SECOND_US);
  if (bucketCount <= 0) return null;
  const samples = new Map<number, { total: number; count: number }>();
  for (const frame of frames) {
    const rssi = frame.sourceRecord.signal?.rssiDbm;
    if (rssi == null) continue;
    const bucketIndex = Math.floor((frame.offsetUs - startUs) / SECOND_US);
    const sample = samples.get(bucketIndex) ?? { total: 0, count: 0 };
    sample.total += rssi;
    sample.count += 1;
    samples.set(bucketIndex, sample);
  }
  if (samples.size === 0) return null;
  const healthyBuckets = [...samples.values()].filter((sample) => sample.total / sample.count >= -90).length;
  return (healthyBuckets / bucketCount) * 100;
}

function diagnosticIntersectsRange(event: DiagnosticEvent, startUs: number, endUs: number): boolean {
  return event.endUs == null
    ? event.startUs >= startUs && event.startUs < endUs
    : event.startUs < endUs && event.endUs > startUs;
}

export function projectIncident(
  preset: Readonly<IncidentPreset>,
  frames: readonly DecodedFrame[],
  diagnostics: readonly DiagnosticEvent[],
): IncidentProjection {
  const incidentFrames = rowsInRange(frames, preset.startUs, preset.endUs);
  const incidentDiagnostics = diagnostics.filter((event) => diagnosticIntersectsRange(event, preset.startUs, preset.endUs));
  const completePackets = incidentFrames.filter((frame) => frame.status === "complete").length;
  const missingFrames = missingFramesInRange(frames, preset.startUs, preset.endUs);
  const expectedFrames = incidentFrames.length + missingFrames;
  let lowestRssiDbm: number | null = null;
  for (const frame of incidentFrames) {
    const sample = frame.sourceRecord.signal?.rssiDbm;
    if (sample != null && (lowestRssiDbm == null || sample < lowestRssiDbm)) lowestRssiDbm = sample;
  }
  const durationSeconds = (preset.endUs - preset.startUs) / SECOND_US;

  return {
    ...preset,
    diagnostics: incidentDiagnostics,
    stats: {
      receivedFrames: incidentFrames.length,
      expectedFrames,
      missingFrames,
      completePackets,
      lossPct: expectedFrames > 0 ? (missingFrames / expectedFrames) * 100 : null,
      decodeConfidencePct: incidentFrames.length > 0 ? (completePackets / incidentFrames.length) * 100 : null,
      lowestRssiDbm,
      peakJitterMs: peakJitterInRange(incidentFrames),
      averageThroughput: durationSeconds > 0 ? incidentFrames.length / durationSeconds : null,
      linkAvailabilityPct: linkAvailabilityInRange(incidentFrames, preset.startUs, preset.endUs),
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedCaptureEvidence(document: SessionDocument): {
  transportEvents: readonly TransportEvent[];
  captureIntegrity: CaptureIntegrityReceipt;
} {
  if (document.formatVersion === 2) {
    return {
      transportEvents: document.transportEvents,
      captureIntegrity: document.captureIntegrity,
    };
  }
  const retainedBytes = document.records.reduce((total, record) => total + record.captureBytes, 0);
  return deepFreeze({
    transportEvents: [] as TransportEvent[],
    captureIntegrity: {
      schemaVersion: 1,
      status: "unknown",
      assessmentBasis: "legacy-v1",
      stopDisposition: "not-observed",
      stopOffsetUs: null,
      eventLogComplete: false,
      input: {
        unit: "unknown",
        observedUnits: null,
        observedBytes: null,
        transportReportedUnits: null,
        transportReportedBytes: null,
      },
      retained: {
        records: document.records.length,
        bytes: retainedBytes,
      },
      issueCodes: ["legacy-session-unassessed"],
    } satisfies CaptureIntegrityReceipt,
  });
}

export function parseSession(
  input: unknown,
  observer?: SessionDerivationObserver,
): ParsedSession {
  const document = deepFreeze(validateSessionDocument(input, observer));
  const decoderPack = deepFreeze(resolveDecoderPack(
    document.decoder,
    document.formatVersion === 2 ? document.decoderPack : undefined,
  ));
  const captureEvidence = normalizedCaptureEvidence(document);
  const transportProvenance = document.formatVersion === 2 ? document.transportProvenance : undefined;
  const frames: DecodedFrame[] = [];
  reportDerivationProgress(observer, "decoding", 0, document.records.length);
  for (const [ordinal, record] of document.records.entries()) {
    frames.push(decodeRecord(record, ordinal, decoderPack));
    reportDerivationProgress(observer, "decoding", ordinal + 1, document.records.length);
  }
  reportDerivationProgress(observer, "aggregating", 0, 4);
  const buckets = createMetricBuckets(document, frames);
  reportDerivationProgress(observer, "aggregating", 1, 4);
  const provenanceDiagnostic = transportProvenance == null
    ? null
    : transportProvenanceDiagnostic(transportProvenance, document.durationUs);
  const diagnostics = [
    ...deriveDiagnostics(frames, buckets, document.decoder.id),
    ...captureEvidence.transportEvents.map((event) => transportEventDiagnostic(event, document.durationUs)),
    ...(provenanceDiagnostic == null ? [] : [provenanceDiagnostic]),
  ].sort((left, right) => left.startUs - right.startUs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  reportDerivationProgress(observer, "aggregating", 2, 4);
  const incidentPresets: IncidentPreset[] = document.incidents.length > 0
    ? document.incidents
    : [{ id: "full-session", title: "Full session review", startUs: 0, endUs: document.durationUs, severity: "info" }];
  const incidents = incidentPresets.map((preset) => projectIncident(preset, frames, diagnostics));
  reportDerivationProgress(observer, "aggregating", 3, 4);
  const framesById = new Map(frames.map((frame) => [frame.id, frame]));
  reportDerivationProgress(observer, "aggregating", 4, 4);
  return {
    document,
    decoderPack,
    transportEvents: captureEvidence.transportEvents,
    captureIntegrity: captureEvidence.captureIntegrity,
    ...(transportProvenance == null ? {} : { transportProvenance }),
    frames,
    buckets,
    diagnostics,
    incidents,
    framesById,
  };
}

export function lowerBoundByOffset<T extends { offsetUs: number }>(rows: readonly T[], offsetUs: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows[middle];
    if (row && row.offsetUs < offsetUs) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function rowsInRange<T extends { offsetUs: number }>(rows: readonly T[], startUs: number, endUs: number): T[] {
  return rows.slice(lowerBoundByOffset(rows, startUs), lowerBoundByOffset(rows, endUs));
}
