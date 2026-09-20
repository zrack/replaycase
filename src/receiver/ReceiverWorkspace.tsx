import {
  type KeyboardEvent as ReactKeyboardEvent,
  useMemo,
  useState,
} from "react";
import {
  ArrowsLeftRight,
  Check,
  Circle,
  Database,
  FileText,
  Package,
  UploadSimple,
  X,
} from "@phosphor-icons/react";

import {
  formatBytes,
  formatClockOffset,
  formatDurationUs,
  formatSessionDate,
  timeZoneAbbreviation,
} from "../lib/time";
import type { TransportEvent } from "../domain/types";
import type { VerifiedDecodedPacket } from "../../verifier/evidence-verifier";
import {
  clearReceiverNotes,
  loadReceiverNotes,
  MAX_RECEIVER_NOTES_LENGTH,
  saveReceiverNotes,
} from "./receiver-storage";
import type {
  ReceiverDocument,
  ReceiverEvidenceGroup,
} from "./receiver-document";

type ReceiverTab = "evidence" | "provenance" | "notes";
type NotePersistence = "stored" | "memory-only";

export interface ReceiverWorkspaceProps {
  onOpenCases?: () => void;
  document: ReceiverDocument;
  fileName: string;
  onOpenBundle: () => void;
  onOpenReplay: () => void;
  onLoadBundledReplay: () => void;
  onCompare: (document: ReceiverDocument) => void;
}

const EVIDENCE_GROUPS: Array<{
  id: ReceiverEvidenceGroup;
  label: string;
}> = [
  { id: "rawRecords", label: "Raw records" },
  { id: "decodedPackets", label: "Decoded packets" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "markers", label: "Markers" },
  { id: "notes", label: "Source notes" },
  { id: "schema", label: "Decoder schema" },
  { id: "transportEvidence", label: "Transport evidence" },
];

function clampPercent(offsetUs: number, startUs: number, endUs: number): number {
  return Math.max(0, Math.min(100, ((offsetUs - startUs) / (endUs - startUs)) * 100));
}

function sampleEvenly<T>(values: readonly T[], maximum: number): readonly T[] {
  if (values.length <= maximum) return values;
  return Array.from(
    { length: maximum },
    (_, index) => values[Math.floor((index * values.length) / maximum)]!,
  );
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

function humanize(value: string): string {
  return value
    .split("-")
    .map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

function transportOffset(event: TransportEvent, selectionStartUs: number): number {
  if (event.scope.kind === "point") return event.scope.offsetUs;
  if (event.scope.kind === "interval") return event.scope.startUs;
  return selectionStartUs;
}

function exactClock(document: ReceiverDocument, offsetUs: number): string {
  const base = formatClockOffset(
    document.sourceSession.startedAt,
    offsetUs,
    document.sourceSession.displayTimeZone,
  );
  const absoluteUs = Date.parse(document.sourceSession.startedAt) * 1_000 + offsetUs;
  const remainder = ((absoluteUs % 1_000) + 1_000) % 1_000;
  return `${base}${remainder.toString().padStart(3, "0")}`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function claimLabel(value: string): string {
  return humanize(value);
}

function claimTone(value: string): "good" | "warn" | "muted" {
  if (value === "internally-consistent" || value === "verified") return "good";
  if (value === "incomplete") return "warn";
  return "muted";
}

function nearestByOffset<T>(
  values: readonly T[],
  offsetUs: number,
  getOffset: (value: T) => number,
): T | null {
  let nearest: T | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const value of values) {
    const candidateDistance = Math.abs(getOffset(value) - offsetUs);
    if (candidateDistance < distance) {
      nearest = value;
      distance = candidateDistance;
    }
  }
  return nearest;
}

function ReceiverRail({
  document,
  fileName,
  onOpenBundle,
  onOpenReplay,
  onLoadBundledReplay,
}: ReceiverWorkspaceProps) {
  return (
    <aside className="left-rail receiver-rail" aria-label="Received evidence navigation">
      <div className="brand-lockup">
        <img src="/replaycase-mark.svg" alt="ReplayCase" />
        <div><strong>ReplayCase</strong><span>Evidence receiver</span></div>
      </div>
      <div className="rail-scroll">
        <section className="rail-section">
          <div className="section-kicker-row"><span>Received bundle</span><b>1</b></div>
          <button className="receiver-open-row" type="button" onClick={onOpenBundle}>
            <Package size={15} />
            <span><strong>Open evidence bundle</strong><small>Verify before inspection</small></span>
          </button>
          <button className="receiver-open-row secondary" type="button" onClick={onOpenReplay}>
            <UploadSimple size={15} />
            <span><strong>Open replay</strong><small>Switch to session review</small></span>
          </button>
        </section>
        <section className="rail-section receiver-loaded">
          <div className="section-kicker-row"><span>Loaded evidence</span></div>
          <strong>{document.incident.title ?? document.sourceSession.title}</strong>
          <small title={fileName}>{fileName}</small>
          <code title={document.bundle.sha256}>{shortHash(document.bundle.sha256)}</code>
        </section>
        <section className="rail-section receiver-artifacts">
          <div className="section-kicker-row"><span>Artifact groups</span></div>
          <ul>
            {EVIDENCE_GROUPS.map(({ id, label }) => {
              const group = document.availability[id];
              return (
                <li className={group.included ? "included" : "excluded"} key={id}>
                  {group.included ? <Check size={12} weight="bold" /> : <X size={12} />}
                  <span>{label}</span>
                  <b>{group.included ? group.records.toLocaleString() : "Not included"}</b>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="rail-section session-info receiver-session-info">
          <div className="section-kicker-row"><span>Source session</span></div>
          <dl>
            <div><dt>Session</dt><dd>{document.sourceSession.id}</dd></div>
            <div><dt>Decoder</dt><dd>{document.sourceSession.decoderId}</dd></div>
            <div><dt>Revision</dt><dd>{document.sourceSession.decoderRevision}</dd></div>
            <div><dt>Bundle</dt><dd>{formatBytes(document.bundle.bytes)}</dd></div>
            <div><dt>Range</dt><dd>{formatDurationUs(document.incident.endUs - document.incident.startUs, true)}</dd></div>
          </dl>
        </section>
      </div>
      <button className="settings-button" type="button" onClick={onLoadBundledReplay}>
        <Database size={16} /> Return to demo session
      </button>
    </aside>
  );
}

function ReceiverTopBar({
  onOpenCases,
  document,
  onOpenBundle,
  onOpenReplay,
  onCompare,
}: Pick<ReceiverWorkspaceProps, "document" | "onOpenBundle" | "onOpenReplay" | "onCompare" | "onOpenCases">) {
  const zone = timeZoneAbbreviation(
    document.sourceSession.startedAt,
    document.sourceSession.displayTimeZone,
    document.incident.startUs,
  );
  return (
    <header className="topbar receiver-topbar">
      <div className="session-title">
        <span>Evidence receiver <i>•</i> Verified archive</span>
        <div>
          <h1 className="workspace-heading" tabIndex={-1}>
            {document.incident.title ?? document.sourceSession.title}
          </h1>
          <FileText className="decorative-icon" size={15} aria-hidden="true" />
        </div>
      </div>
      <div className="session-meta">
        {formatSessionDate(document.sourceSession.startedAt, document.sourceSession.displayTimeZone)}
        {" "}<i>•</i>{" "}
        {exactClock(document, document.incident.startUs)} – {exactClock(document, document.incident.endUs)} {zone}
        {" "}<i>•</i>{" "}
        {formatDurationUs(document.incident.endUs - document.incident.startUs, true)}
      </div>
      <div className="header-actions">
        {onOpenCases && <button className="secondary-action" type="button" onClick={onOpenCases}><Package size={15} /> Cases</button>}
        <button className="secondary-action" type="button" onClick={() => onCompare(document)}>
          <ArrowsLeftRight size={16} /> Compare
        </button>
        <button className="secondary-action" type="button" onClick={onOpenReplay}>
          <UploadSimple size={15} /> Open replay
        </button>
        <button className="primary-action" type="button" onClick={onOpenBundle}>
          <Package size={16} /> Open evidence
        </button>
      </div>
    </header>
  );
}

function VerificationStrip({ document }: { document: ReceiverDocument }) {
  const claims = [
    {
      label: "Internal consistency",
      value: document.claims.internalConsistency,
      detail: "Archive structure, checksums, schemas, and cross-artifact semantics passed.",
    },
    {
      label: "Evidence completeness",
      value: document.claims.evidenceCompleteness,
      detail: "Capture and provenance evidence are assessed independently from archive integrity.",
    },
    {
      label: "Source authenticity",
      value: document.claims.authenticity,
      detail: "Checksums do not establish who created the bundle or how it was delivered.",
    },
  ];
  return (
    <section className="receiver-verification" aria-label="Evidence verification claims">
      {claims.map((claim) => (
        <div key={claim.label}>
          <span>{claim.label}</span>
          <strong className={claimTone(claim.value)}>
            <Circle size={7} weight="fill" /> {claimLabel(claim.value)}
          </strong>
          <p>{claim.detail}</p>
        </div>
      ))}
    </section>
  );
}

interface TimelineProps {
  document: ReceiverDocument;
  playheadUs: number;
  onSeek: (offsetUs: number) => void;
}

function ReceiverTimeline({ document, playheadUs, onSeek }: TimelineProps) {
  const { startUs, endUs } = document.incident;
  const ticks = Array.from({ length: 6 }, (_, index) => startUs + ((endUs - startUs) * index) / 5);
  const packets = sampleEvenly(document.evidence.decodedPackets, 500);
  const diagnostics = sampleEvenly(document.evidence.diagnostics, 300);
  const markers = sampleEvenly(document.evidence.markers, 200);
  const transport = sampleEvenly(document.evidence.transportEvents, 300);
  const playheadPercent = clampPercent(playheadUs, startUs, endUs);

  const emptyLabel = (group: ReceiverEvidenceGroup, noun: string) => (
    <span className="receiver-lane-empty">
      {document.availability[group].included
        ? `No ${noun} in the selected range`
        : `${noun} not included in the received bundle`}
    </span>
  );

  return (
    <section className="receiver-timeline" aria-label="Received incident timeline">
      <header>
        <div>
          <span>Received incident timeline</span>
          <strong>{exactClock(document, startUs)} – {exactClock(document, endUs)}</strong>
        </div>
        <p>Only evidence carried by the verified archive is projected here.</p>
      </header>
      <div className="receiver-time-ruler" aria-hidden="true">
        {ticks.map((offset) => <span key={offset}>{exactClock(document, offset)}</span>)}
      </div>
      <div className="receiver-lanes">
        <input
          className="receiver-scrubber"
          type="range"
          min={startUs}
          max={endUs - 1}
          step={1}
          value={playheadUs}
          aria-label="Received incident position"
          aria-valuetext={`${exactClock(document, playheadUs)} in the received incident`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        <div className="receiver-lane">
          <div><strong>Transport</strong><span>capture path</span></div>
          <div className="receiver-lane-track">
            <span className="receiver-lane-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true" />
            {transport.length === 0 && emptyLabel("transportEvidence", "transport events")}
            {transport.map((event) => {
              const offset = transportOffset(event, startUs);
              return (
                <span
                  className="receiver-mark transport"
                  key={event.id}
                  style={{ left: `${clampPercent(offset, startUs, endUs)}%` }}
                  aria-hidden="true"
                  title={humanize(event.type)}
                />
              );
            })}
          </div>
        </div>
        <div className="receiver-lane">
          <div><strong>Packets</strong><span>decoded evidence</span></div>
          <div className="receiver-lane-track">
            <span className="receiver-lane-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true" />
            {packets.length === 0 && emptyLabel("decodedPackets", "decoded packets")}
            {packets.map((packet) => (
              <span
                className={`receiver-mark packet ${packet.status}`}
                key={packet.id}
                style={{ left: `${clampPercent(packet.offsetUs, startUs, endUs)}%` }}
                aria-hidden="true"
                title={`${packet.familyName} · ${packet.integrityStatus}`}
              />
            ))}
          </div>
        </div>
        <div className="receiver-lane">
          <div><strong>Diagnostics</strong><span>derived findings</span></div>
          <div className="receiver-lane-track">
            <span className="receiver-lane-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true" />
            {diagnostics.length === 0 && emptyLabel("diagnostics", "diagnostics")}
            {diagnostics.map((diagnostic) => (
              <span
                className={`receiver-mark diagnostic ${diagnostic.severity}`}
                key={diagnostic.id}
                style={{ left: `${clampPercent(diagnostic.startUs, startUs, endUs)}%` }}
                aria-hidden="true"
                title={diagnostic.title}
              />
            ))}
          </div>
        </div>
        <div className="receiver-lane">
          <div><strong>Annotations</strong><span>source operator</span></div>
          <div className="receiver-lane-track">
            <span className="receiver-lane-playhead" style={{ left: `${playheadPercent}%` }} aria-hidden="true" />
            {markers.length === 0 && emptyLabel("markers", "source markers")}
            {markers.map((marker) => (
              <span
                className="receiver-mark annotation"
                key={marker.id}
                style={{ left: `${clampPercent(marker.offsetUs, startUs, endUs)}%` }}
                aria-hidden="true"
                title={marker.title}
              />
            ))}
          </div>
        </div>
      </div>
      <footer>
        <span>Playhead</span>
        <strong>{exactClock(document, playheadUs)}</strong>
        <span>{(playheadUs - startUs).toLocaleString()} µs from received range start</span>
      </footer>
    </section>
  );
}

function packetFieldSummary(packet: VerifiedDecodedPacket): string {
  const fields = packet.fields
    .filter((field) => field.value != null)
    .slice(0, 3)
    .map((field) => `${field.name}=${String(field.value)}${field.unit ? ` ${field.unit}` : ""}`);
  return fields.join(" · ") || "No decoded values";
}

interface EvidenceTableProps {
  document: ReceiverDocument;
  playheadUs: number;
  onSeek: (offsetUs: number) => void;
}

function ReceiverEvidenceTable({ document, playheadUs, onSeek }: EvidenceTableProps) {
  const packets = sampleEvenly(document.evidence.decodedPackets, 250);
  const rawRecords = sampleEvenly(document.evidence.rawRecords, 250);
  const showPackets = document.availability.decodedPackets.included;
  return (
    <section className="receiver-evidence-table">
      <header>
        <div>
          <span>{showPackets ? "Decoded packet evidence" : "Raw record evidence"}</span>
          <strong>
            {showPackets
              ? `${document.evidence.decodedPackets.length.toLocaleString()} packet rows`
              : `${document.evidence.rawRecords.length.toLocaleString()} raw records`}
          </strong>
        </div>
        <p>
          {showPackets && packets.length < document.evidence.decodedPackets.length
            ? `Showing a deterministic ${packets.length.toLocaleString()}-row projection.`
            : !showPackets && rawRecords.length < document.evidence.rawRecords.length
              ? `Showing a deterministic ${rawRecords.length.toLocaleString()}-row projection.`
              : "Every included row is available in this view."}
        </p>
      </header>
      <p id="receiver-table-keyboard-scroll-instructions" className="visually-hidden">
        This received evidence table scrolls horizontally in narrow layouts. When the table region is focused, use the Left and Right Arrow keys to reveal columns or Home and End to move to either edge.
      </p>
      <div
        className="receiver-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Scrollable received evidence rows"
        aria-describedby="receiver-table-keyboard-scroll-instructions"
        onKeyDown={handleHorizontalScrollKey}
      >
        {showPackets ? (
          <table>
            <thead><tr><th>Time</th><th>Family</th><th>Integrity</th><th>Decoded fields</th></tr></thead>
            <tbody>
              {packets.map((packet) => (
                <tr className={Math.abs(packet.offsetUs - playheadUs) < 1_000 ? "active" : ""} key={packet.id}>
                  <td><button type="button" onClick={() => onSeek(packet.offsetUs)}>{exactClock(document, packet.offsetUs)}</button></td>
                  <td>{packet.familyName}</td>
                  <td><span className={`receiver-integrity ${packet.status}`}>{packet.integrityStatus}</span></td>
                  <td>{packetFieldSummary(packet)}</td>
                </tr>
              ))}
              {packets.length === 0 && <tr><td colSpan={4}>Decoded packets were not included or this range contains no packet rows.</td></tr>}
            </tbody>
          </table>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Record</th><th>Transport</th><th>Bytes</th></tr></thead>
            <tbody>
              {rawRecords.map((record) => (
                <tr className={Math.abs(record.offsetUs - playheadUs) < 1_000 ? "active" : ""} key={record.id}>
                  <td><button type="button" onClick={() => onSeek(record.offsetUs)}>{exactClock(document, record.offsetUs)}</button></td>
                  <td>{record.id}</td>
                  <td>{record.transport.kind.toUpperCase()}</td>
                  <td>{record.captureBytes.toLocaleString()}</td>
                </tr>
              ))}
              {rawRecords.length === 0 && <tr><td colSpan={4}>Raw records were not included in this bundle.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

interface InspectorProps {
  document: ReceiverDocument;
  playheadUs: number;
}

function ReceiverInspector({ document, playheadUs }: InspectorProps) {
  const [tab, setTab] = useState<ReceiverTab>("evidence");
  const loadedNotes = useMemo(
    () => loadReceiverNotes(document.bundle.sha256),
    [document.bundle.sha256],
  );
  const [receiverNotes, setReceiverNotes] = useState(loadedNotes.text);
  const [notePersistence, setNotePersistence] = useState<NotePersistence>(
    loadedNotes.storageAvailable ? "stored" : "memory-only",
  );
  const nearestPacket = nearestByOffset(
    document.evidence.decodedPackets,
    playheadUs,
    (packet) => packet.offsetUs,
  );
  const nearestRaw = nearestByOffset(
    document.evidence.rawRecords,
    playheadUs,
    (record) => record.offsetUs,
  );
  const nearbyDiagnostics = document.evidence.diagnostics
    .filter((diagnostic) => {
      const endUs = diagnostic.endUs ?? diagnostic.startUs + 1;
      return diagnostic.startUs <= playheadUs && endUs > playheadUs;
    })
    .slice(0, 8);
  const transportProvenance = document.evidence.transportProvenance.availability === "available"
    ? document.evidence.transportProvenance.provenance
    : null;
  const udpProvenance = transportProvenance?.transport === "udp" ? transportProvenance : null;
  const udpAccounting = udpProvenance?.schemaVersion === 2 ? udpProvenance.byteAccounting : null;
  const udpJournal = udpProvenance?.journal ?? null;

  const changeNotes = (value: string) => {
    setReceiverNotes(value);
    setNotePersistence(
      saveReceiverNotes(document.bundle.sha256, value)
        ? "stored"
        : "memory-only",
    );
  };

  const clearNotes = () => {
    const cleared = clearReceiverNotes(document.bundle.sha256);
    setReceiverNotes("");
    setNotePersistence(cleared ? "stored" : "memory-only");
  };

  return (
    <aside className="receiver-inspector" aria-label="Received evidence inspector">
      <div className="receiver-inspector-heading">
        <span>Evidence inspector</span>
        <strong>{exactClock(document, playheadUs)}</strong>
      </div>
      <div className="receiver-tabs" role="tablist" aria-label="Receiver information">
        {(["evidence", "provenance", "notes"] as const).map((candidate) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            key={candidate}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      {tab === "evidence" && (
        <div className="receiver-tab-panel" role="tabpanel" aria-label="evidence">
          <section>
            <span>Nearest decoded packet</span>
            {nearestPacket ? (
              <>
                <strong>{nearestPacket.familyName}</strong>
                <dl>
                  <div><dt>Offset</dt><dd>{nearestPacket.offsetUs.toLocaleString()} µs</dd></div>
                  <div><dt>Status</dt><dd>{nearestPacket.status}</dd></div>
                  <div><dt>Integrity</dt><dd>{nearestPacket.integrityStatus}</dd></div>
                  <div><dt>Record</dt><dd>{nearestPacket.sourceRecordId}</dd></div>
                </dl>
                <ul className="receiver-field-list">
                  {nearestPacket.fields.slice(0, 16).map((field) => (
                    <li key={field.name}>
                      <span>{field.name}</span>
                      <strong>{field.value == null ? "Unavailable" : String(field.value)}{field.unit ? ` ${field.unit}` : ""}</strong>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p>Decoded packet evidence is unavailable at this position.</p>}
          </section>
          <section>
            <span>Nearest raw record</span>
            {nearestRaw ? (
              <>
                <strong>{nearestRaw.id}</strong>
                <code>{nearestRaw.dataHex.slice(0, 120)}{nearestRaw.dataHex.length > 120 ? "…" : ""}</code>
              </>
            ) : <p>Raw source records were not included.</p>}
          </section>
          <section>
            <span>Diagnostics at playhead</span>
            {nearbyDiagnostics.length > 0 ? nearbyDiagnostics.map((diagnostic) => (
              <div className={`receiver-diagnostic ${diagnostic.severity}`} key={diagnostic.id}>
                <strong>{diagnostic.title}</strong>
                <p>{diagnostic.description}</p>
              </div>
            )) : <p>No diagnostic overlaps this exact position.</p>}
          </section>
        </div>
      )}
      {tab === "provenance" && (
        <div className="receiver-tab-panel" role="tabpanel" aria-label="provenance">
          <section>
            <span>Declared source</span>
            <dl>
              <div><dt>Session</dt><dd>{document.sourceSession.id}</dd></div>
              <div><dt>Source</dt><dd>{document.sourceSession.sourceId}</dd></div>
              <div><dt>Decoder</dt><dd>{document.sourceSession.decoderId}</dd></div>
              <div><dt>Schema</dt><dd title={document.sourceSession.schemaHash}>{shortHash(document.sourceSession.schemaHash)}</dd></div>
              <div><dt>Pack</dt><dd>{document.sourceSession.packHash ? shortHash(document.sourceSession.packHash) : "Legacy identity"}</dd></div>
            </dl>
          </section>
          <section>
            <span>Capture evidence</span>
            <strong>{claimLabel(document.claims.captureEvidence)}</strong>
            <p>{document.evidence.integrityReceipt.issueCodes.join(", ") || "No capture-integrity issue codes."}</p>
          </section>
          <section>
            <span>Transport provenance</span>
            {transportProvenance ? (
              <>
                <strong>{transportProvenance.transport.toUpperCase()} · {transportProvenance.status}</strong>
                <dl>
                  <div><dt>Source</dt><dd>{transportProvenance.sourceId}</dd></div>
                  {udpProvenance && <div><dt>Kernel drops</dt><dd>{udpJournal?.kernelDroppedDatagrams == null ? `Unavailable · ${udpJournal?.kernelDroppedDatagramsSource ?? "no journal"}` : `${udpJournal.kernelDroppedDatagrams.toLocaleString()} datagrams · Linux socket counter`}</dd></div>}
                  {udpProvenance && <div><dt>Payload</dt><dd>{udpAccounting ? `${formatBytes(udpAccounting.payload.bytes)} · observed` : "Unavailable"}</dd></div>}
                  {udpProvenance && <div><dt>UDP estimate</dt><dd>{udpAccounting ? formatBytes(udpAccounting.udp.bytes) : "Unavailable"}</dd></div>}
                  {udpProvenance && <div><dt>IP minimum</dt><dd>{udpAccounting ? `${formatBytes(udpAccounting.ip.bytes)} · ${udpAccounting.ip.family}` : "Unavailable"}</dd></div>}
                  {udpProvenance && <div><dt>Link / radio</dt><dd>{udpAccounting ? "Unavailable · not observed at UDP socket" : "Unavailable"}</dd></div>}
                </dl>
                <p>{transportProvenance.issueCodes.join(", ") || "No provenance reconciliation issues."}</p>
              </>
            ) : <p>Structured transport provenance is unavailable for this source session.</p>}
          </section>
          <section>
            <span>Known limitations</span>
            <ul className="receiver-limitations">
              {document.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
            </ul>
          </section>
        </div>
      )}
      {tab === "notes" && (
        <div className="receiver-tab-panel receiver-notes" role="tabpanel" aria-label="notes">
          <section>
            <span>Source notes</span>
            {document.evidence.sourceNotes.length > 0
              ? document.evidence.sourceNotes.map((note) => (
                  <div className="receiver-source-note" key={note.id}>
                    {note.title && <strong>{note.title}</strong>}
                    <p>{note.body}</p>
                  </div>
                ))
              : <p>Source notes were not included or none were authored.</p>}
          </section>
          <section>
            <div className="receiver-note-heading">
              <span>Receiver finding</span>
              <b className={notePersistence}>{notePersistence === "stored" ? "Stored separately" : "Memory only"}</b>
            </div>
            <label>
              <span className="visually-hidden">Receiver finding for this evidence bundle</span>
              <textarea
                value={receiverNotes}
                maxLength={MAX_RECEIVER_NOTES_LENGTH}
                onChange={(event) => changeNotes(event.target.value)}
                placeholder="Record what you verified, inferred, or still need to resolve."
              />
            </label>
            <div className="receiver-note-footer">
              <span>{receiverNotes.length.toLocaleString()} / {MAX_RECEIVER_NOTES_LENGTH.toLocaleString()}</span>
              <button type="button" onClick={clearNotes} disabled={receiverNotes.length === 0}>
                <X size={12} /> Clear
              </button>
            </div>
            <p className="receiver-note-boundary">
              Stored under this bundle SHA-256 in the browser. This text never modifies or becomes source evidence inside the received archive.
            </p>
          </section>
        </div>
      )}
    </aside>
  );
}

export function ReceiverWorkspace(props: ReceiverWorkspaceProps) {
  const { document } = props;
  const [playheadUs, setPlayheadUs] = useState(document.incident.startUs);

  return (
    <main className="app-shell receiver-shell" aria-label="Received incident evidence workspace">
      <ReceiverRail {...props} />
      <ReceiverTopBar
        onOpenCases={props.onOpenCases}
        document={document}
        onOpenBundle={props.onOpenBundle}
        onOpenReplay={props.onOpenReplay}
        onCompare={props.onCompare}
      />
      <VerificationStrip document={document} />
      <ReceiverTimeline document={document} playheadUs={playheadUs} onSeek={setPlayheadUs} />
      <ReceiverEvidenceTable document={document} playheadUs={playheadUs} onSeek={setPlayheadUs} />
      <ReceiverInspector document={document} playheadUs={playheadUs} />
      <div className="visually-hidden" role="status" aria-live="polite">
        Received evidence position {exactClock(document, playheadUs)}
      </div>
    </main>
  );
}
