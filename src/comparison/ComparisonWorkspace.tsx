import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowsLeftRight,
  Circle,
  DownloadSimple,
  FileArrowUp,
  Package,
  SpinnerGap,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

import {
  buildComparisonFinding,
  createReceiverComparisonSource,
  createSessionComparisonSource,
  downloadComparisonFinding,
  MAX_COMPARISON_CONCLUSION_LENGTH,
  suggestComparisonFindingFilename,
  type ComparisonAlignment,
  type ComparisonMetric,
  type ComparisonModel,
  type ComparisonSource,
  type ComparisonStatus,
} from "../domain/comparison";
import type { ParsedSession } from "../domain/types";
import { loadSessionFile, SessionLoadError } from "../data/load-session";
import type { SessionProcessingProgress } from "../processing/contracts";
import { SessionProcessingCancelledError } from "../processing/process-session";
import {
  compareSourcesInWorker,
  ComparisonProcessingCancelledError,
  type ComparisonProcessingProgress,
} from "../processing/comparison-processing";
import {
  EvidenceBundleLoadError,
  loadEvidenceBundleFile,
} from "../receiver/load-evidence-bundle";
import { formatDurationUs } from "../lib/time";

type CandidateState =
  | { status: "idle" }
  | { status: "loading"; fileName: string; progress: SessionProcessingProgress | null }
  | { status: "error"; fileName: string; message: string; details: readonly string[] }
  | {
      status: "session";
      fileName: string;
      session: ParsedSession;
      incidentId: string;
    }
  | {
      status: "evidence";
      fileName: string;
      source: ComparisonSource;
    };

type ComparisonBuildState =
  | { status: "idle" }
  | { status: "building"; progress: ComparisonProcessingProgress };

export interface ComparisonSetupDialogProps {
  baseline: ComparisonSource;
  onClose: () => void;
  onStart: (model: ComparisonModel) => void;
}

export interface ComparisonWorkspaceProps {
  model: ComparisonModel;
  onNewComparison: () => void;
  onReturn: () => void;
  onOpenReplay: () => void;
  onOpenBundle: () => void;
}

function shortHash(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-10)}`;
}

function humanize(value: string): string {
  return value
    .split("-")
    .map((part) => part ? `${part[0]?.toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
}

function sourceLabel(source: ComparisonSource): string {
  return source.kind === "session" ? "Validated replay" : "Verified evidence bundle";
}

function exactOffset(value: number): string {
  const sign = value < 0 ? "−" : "+";
  return `${sign}${formatDurationUs(Math.abs(value), true)}`;
}

function metricValue(value: number | null, unit: string): string {
  if (value == null) return "Unavailable";
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 1 : magnitude >= 10 ? 2 : 3;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${unit}`;
}

function statusTone(status: ComparisonStatus): "good" | "warn" | "bad" | "muted" {
  if (status === "comparable") return "good";
  if (status === "review-required") return "warn";
  if (status === "not-comparable") return "bad";
  return "muted";
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

function candidateSource(candidate: CandidateState): ComparisonSource | null {
  if (candidate.status === "evidence") return candidate.source;
  if (candidate.status !== "session") return null;
  const incident = candidate.session.incidents.find((item) => item.id === candidate.incidentId);
  return incident == null ? null : createSessionComparisonSource(candidate.session, incident);
}

function useDialogFocus(
  dialogRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    )];
    requestAnimationFrame(() => (dialog.querySelector<HTMLElement>("[data-dialog-focus]") ?? dialog).focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus({ preventScroll: true });
    };
  }, [dialogRef, onClose]);
}

function SourceSummary({
  label,
  source,
}: {
  label: string;
  source: ComparisonSource;
}) {
  return (
    <section className="comparison-source-summary">
      <div>
        <span>{label}</span>
        <strong>{source.title}</strong>
        <small>{source.range.title}</small>
      </div>
      <dl>
        <div><dt>Input</dt><dd>{sourceLabel(source)}</dd></div>
        <div><dt>Range</dt><dd>{formatDurationUs(source.range.endUs - source.range.startUs, true)}</dd></div>
        <div><dt>Decoder</dt><dd>{source.decoder.id} {source.decoder.revision}</dd></div>
        <div><dt>Identity</dt><dd title={source.identity}>{shortHash(source.identity)}</dd></div>
      </dl>
    </section>
  );
}

export function ComparisonSetupDialog({
  baseline,
  onClose,
  onStart,
}: ComparisonSetupDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const candidateControllerRef = useRef<AbortController | null>(null);
  const comparisonControllerRef = useRef<AbortController | null>(null);
  const candidateOperationRef = useRef(0);
  const [candidate, setCandidate] = useState<CandidateState>({ status: "idle" });
  const [comparisonBuild, setComparisonBuild] = useState<ComparisonBuildState>({ status: "idle" });
  const [alignmentMode, setAlignmentMode] = useState<ComparisonAlignment["mode"]>("range-start");
  const [anchorLabel, setAnchorLabel] = useState("");
  const [baselineAnchorUs, setBaselineAnchorUs] = useState(baseline.range.startUs);
  const [candidateAnchorUs, setCandidateAnchorUs] = useState(0);
  const [contractError, setContractError] = useState("");
  useDialogFocus(dialogRef, onClose);
  useEffect(() => () => {
    candidateControllerRef.current?.abort();
    comparisonControllerRef.current?.abort();
  }, []);

  const loadedCandidate = useMemo(() => candidateSource(candidate), [candidate]);
  const busy = candidate.status === "loading" || comparisonBuild.status === "building";
  useEffect(() => {
    if (loadedCandidate != null) setCandidateAnchorUs(loadedCandidate.range.startUs);
  }, [loadedCandidate]);

  const loadCandidate = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    candidateControllerRef.current?.abort();
    const controller = new AbortController();
    candidateControllerRef.current = controller;
    candidateOperationRef.current += 1;
    const operation = candidateOperationRef.current;
    setContractError("");
    setCandidate({ status: "loading", fileName: file.name, progress: null });
    try {
      if (file.name.toLowerCase().endsWith(".nlb")) {
        const document = await loadEvidenceBundleFile(file);
        if (controller.signal.aborted || operation !== candidateOperationRef.current) return;
        setCandidate({
          status: "evidence",
          fileName: file.name,
          source: createReceiverComparisonSource(document),
        });
        return;
      }
      const session = await loadSessionFile(file, {
        signal: controller.signal,
        onProgress(progress) {
          if (!controller.signal.aborted && operation === candidateOperationRef.current) {
            setCandidate({ status: "loading", fileName: file.name, progress });
          }
        },
      });
      if (controller.signal.aborted || operation !== candidateOperationRef.current) return;
      const firstIncident = session.incidents[0];
      if (!firstIncident) throw new SessionLoadError("The candidate replay has no comparable range.");
      setCandidate({
        status: "session",
        fileName: file.name,
        session,
        incidentId: firstIncident.id,
      });
    } catch (cause) {
      if (cause instanceof SessionProcessingCancelledError || controller.signal.aborted) {
        if (operation === candidateOperationRef.current) setCandidate({ status: "idle" });
        return;
      }
      if (operation !== candidateOperationRef.current) return;
      const known = cause instanceof SessionLoadError || cause instanceof EvidenceBundleLoadError;
      setCandidate({
        status: "error",
        fileName: file.name,
        message: known ? cause.message : "ReplayCase could not validate the candidate input.",
        details: known ? cause.details : [cause instanceof Error ? cause.message : "Unknown candidate error."],
      });
    } finally {
      if (candidateControllerRef.current === controller) candidateControllerRef.current = null;
    }
  };

  const cancelCandidate = () => {
    candidateControllerRef.current?.abort();
    candidateControllerRef.current = null;
    candidateOperationRef.current += 1;
    setCandidate({ status: "idle" });
  };

  const cancelComparison = () => {
    comparisonControllerRef.current?.abort();
    comparisonControllerRef.current = null;
    setComparisonBuild({ status: "idle" });
  };

  const start = async () => {
    if (loadedCandidate == null) return;
    comparisonControllerRef.current?.abort();
    const controller = new AbortController();
    comparisonControllerRef.current = controller;
    try {
      const alignment: ComparisonAlignment = alignmentMode === "range-start"
        ? { mode: "range-start" }
        : {
            mode: "shared-event",
            label: anchorLabel,
            baselineAnchorUs,
            candidateAnchorUs,
          };
      setComparisonBuild({
        status: "building",
        progress: { percent: 0, message: "Preparing bounded comparison evidence" },
      });
      const model = await compareSourcesInWorker(baseline, loadedCandidate, alignment, {
        signal: controller.signal,
        onProgress(progress) {
          if (!controller.signal.aborted) setComparisonBuild({ status: "building", progress });
        },
      });
      if (!controller.signal.aborted) onStart(model);
    } catch (cause) {
      if (cause instanceof ComparisonProcessingCancelledError || controller.signal.aborted) {
        setComparisonBuild({ status: "idle" });
        return;
      }
      setContractError(cause instanceof Error ? cause.message : "The comparison contract is invalid.");
      setComparisonBuild({ status: "idle" });
    } finally {
      if (comparisonControllerRef.current === controller) comparisonControllerRef.current = null;
    }
  };

  return createPortal(
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section
        ref={dialogRef}
        className="bundle-dialog comparison-setup-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="comparison-setup-title"
        aria-describedby="comparison-setup-description"
        aria-busy={busy}
      >
        <button className="dialog-close" type="button" aria-label="Close comparison setup" onClick={onClose}><X size={17} /></button>
        <div className="dialog-icon"><ArrowsLeftRight size={24} /></div>
        <span className="dialog-kicker">Comparative replay</span>
        <h2 id="comparison-setup-title" data-dialog-focus tabIndex={-1}>Define two bounded inputs</h2>
        <p id="comparison-setup-description">ReplayCase compares only the explicit aligned overlap. It does not infer synchronized clocks or comparable decoder semantics.</p>

        <SourceSummary label="Baseline" source={baseline} />

        <section className="comparison-candidate-picker">
          <div>
            <span>Candidate</span>
            <small>Validated `.nlsession` or independently verified `.nlb`</small>
          </div>
          <label className="secondary-action">
            <FileArrowUp size={16} />
            {candidate.status === "idle" ? "Choose candidate" : "Replace candidate"}
            <input
              className="visually-hidden"
              type="file"
              accept=".nlsession,.json,.nlb,application/json,application/zip"
              disabled={busy}
              onChange={(event) => void loadCandidate(event)}
            />
          </label>
        </section>

        {candidate.status === "loading" && (
          <div className="comparison-load-status comparison-load-progress" role="status">
            <SpinnerGap className="spin" size={17} />
            <div><strong>{candidate.progress?.message ?? `Validating ${candidate.fileName}`}</strong>{candidate.progress && <div className="processing-meter processing-meter-dialog"><progress max={100} value={candidate.progress.percent} aria-label="Candidate replay processing progress" /><span>{Math.floor(candidate.progress.percent)}%</span></div>}</div>
            <button className="secondary-action" type="button" onClick={cancelCandidate}>Cancel</button>
          </div>
        )}
        {comparisonBuild.status === "building" && (
          <div className="comparison-load-status comparison-load-progress" role="status">
            <SpinnerGap className="spin" size={17} />
            <div><strong>{comparisonBuild.progress.message}</strong><div className="processing-meter processing-meter-dialog"><progress max={100} value={comparisonBuild.progress.percent} aria-label="Comparison construction progress" /><span>{Math.floor(comparisonBuild.progress.percent)}%</span></div></div>
            <button className="secondary-action" type="button" onClick={cancelComparison}>Cancel</button>
          </div>
        )}
        {candidate.status === "error" && (
          <div className="comparison-input-error" role="alert">
            <WarningCircle size={17} />
            <div><strong>{candidate.message}</strong>{candidate.details.map((detail) => <span key={detail}>{detail}</span>)}</div>
          </div>
        )}
        {loadedCandidate != null && <SourceSummary label="Candidate" source={loadedCandidate} />}

        {candidate.status === "session" && (
          <label className="comparison-incident-picker">
            Candidate incident
            <select
              value={candidate.incidentId}
              onChange={(event) => setCandidate({ ...candidate, incidentId: event.target.value })}
            >
              {candidate.session.incidents.map((incident) => (
                <option key={incident.id} value={incident.id}>
                  {incident.title} · {formatDurationUs(incident.endUs - incident.startUs, true)}
                </option>
              ))}
            </select>
          </label>
        )}

        {loadedCandidate != null && (
          <fieldset className="comparison-alignment">
            <legend>Alignment basis</legend>
            <div className="comparison-segmented">
              <label>
                <input type="radio" name="comparison-alignment" value="range-start" checked={alignmentMode === "range-start"} onChange={() => setAlignmentMode("range-start")} />
                Range starts
              </label>
              <label>
                <input type="radio" name="comparison-alignment" value="shared-event" checked={alignmentMode === "shared-event"} onChange={() => setAlignmentMode("shared-event")} />
                Shared event anchors
              </label>
            </div>
            {alignmentMode === "range-start" ? (
              <p>Each selected range start becomes relative t=0. This is explicit alignment, not a source-clock synchronization claim.</p>
            ) : (
              <div className="comparison-anchor-fields">
                <label>
                  Shared event label
                  <input value={anchorLabel} maxLength={240} placeholder="First heartbeat after radio reset" onChange={(event) => setAnchorLabel(event.target.value)} />
                </label>
                <label>
                  Baseline anchor (µs)
                  <input type="number" step={1} min={baseline.range.startUs} max={baseline.range.endUs - 1} value={baselineAnchorUs} onChange={(event) => setBaselineAnchorUs(Number(event.target.value))} />
                </label>
                <label>
                  Candidate anchor (µs)
                  <input type="number" step={1} min={loadedCandidate.range.startUs} max={loadedCandidate.range.endUs - 1} value={candidateAnchorUs} onChange={(event) => setCandidateAnchorUs(Number(event.target.value))} />
                </label>
              </div>
            )}
          </fieldset>
        )}

        {contractError && <p className="comparison-contract-error" role="alert">{contractError}</p>}
        <div className="dialog-actions comparison-dialog-actions">
          <button className="secondary-action" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-action" type="button" disabled={loadedCandidate == null || busy} onClick={() => void start()}>
            {comparisonBuild.status === "building" ? <SpinnerGap className="spin" size={17} /> : <ArrowsLeftRight size={17} />} Open comparison
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ComparisonRail({ model, onNewComparison }: Pick<ComparisonWorkspaceProps, "model" | "onNewComparison">) {
  const rows = [
    { label: "Baseline", source: model.baseline },
    { label: "Candidate", source: model.candidate },
  ];
  return (
    <aside className="left-rail comparison-rail" aria-label="Comparison inputs">
      <div className="brand-lockup">
        <img src="/replaycase-mark.svg" alt="ReplayCase" />
        <div><strong>ReplayCase</strong><span>Comparison workspace</span></div>
      </div>
      <div className="rail-scroll">
        {rows.map(({ label, source }) => (
          <section className="rail-section comparison-rail-source" key={label}>
            <div className="section-kicker-row"><span>{label}</span><b>{source.kind === "session" ? "Replay" : "Bundle"}</b></div>
            <strong>{source.title}</strong>
            <small>{source.range.title}</small>
            <code title={source.identity}>{shortHash(source.identity)}</code>
            <dl>
              <div><dt>Range</dt><dd>{formatDurationUs(source.range.endUs - source.range.startUs, true)}</dd></div>
              <div><dt>Decoder</dt><dd>{source.decoder.id}</dd></div>
              <div><dt>Capture</dt><dd>{humanize(source.captureIntegrity.status)}</dd></div>
            </dl>
          </section>
        ))}
        <section className="rail-section comparison-overlap">
          <div className="section-kicker-row"><span>Aligned intersection</span></div>
          <strong>{formatDurationUs(model.alignment.overlap.durationUs, true)}</strong>
          <small>{model.alignment.label}</small>
          <dl>
            <div><dt>Baseline t0</dt><dd>{model.alignment.baselineAnchorUs.toLocaleString()} µs</dd></div>
            <div><dt>Candidate t0</dt><dd>{model.alignment.candidateAnchorUs.toLocaleString()} µs</dd></div>
          </dl>
        </section>
      </div>
      <button className="settings-button" type="button" onClick={onNewComparison}><ArrowsLeftRight size={16} /> New comparison</button>
    </aside>
  );
}

function ComparisonTopBar(props: ComparisonWorkspaceProps) {
  return (
    <header className="topbar comparison-topbar">
      <div className="session-title">
        <span>Comparative replay <i>•</i> Explicit alignment</span>
        <div><h1 className="workspace-heading" tabIndex={-1}>{props.model.baseline.sessionId} vs {props.model.candidate.sessionId}</h1><ArrowsLeftRight className="decorative-icon" size={16} aria-hidden="true" /></div>
      </div>
      <div className="session-meta">
        {props.model.alignment.label} <i>•</i> {formatDurationUs(props.model.alignment.overlap.durationUs, true)} overlap <i>•</i> {props.model.metrics.length} bounded measures
      </div>
      <div className="header-actions">
        <button className="secondary-action" type="button" onClick={props.onReturn}>Return</button>
        <button className="secondary-action" type="button" onClick={props.onOpenReplay}><UploadSimple size={15} /> Open replay</button>
        <button className="secondary-action" type="button" onClick={props.onOpenBundle}><Package size={15} /> Open evidence</button>
        <button className="primary-action" type="button" onClick={props.onNewComparison}><ArrowsLeftRight size={16} /> New comparison</button>
      </div>
    </header>
  );
}

function ComparabilityStrip({ model }: { model: ComparisonModel }) {
  return (
    <section className="comparison-strip" aria-label="Comparison eligibility">
      <div className={`comparison-assessment ${model.assessment}`}>
        <span>Bounded finding</span>
        <strong><Circle size={8} weight="fill" /> {humanize(model.assessment)}</strong>
      </div>
      {model.areas.map((area) => (
        <div className="comparison-area" key={area.id} title={area.reason}>
          <span>{area.label}</span>
          <strong className={statusTone(area.status)}><Circle size={7} weight="fill" /> {humanize(area.status)}</strong>
        </div>
      ))}
    </section>
  );
}

function relativePercent(offsetUs: number, anchorUs: number, model: ComparisonModel): number {
  const relativeUs = offsetUs - anchorUs;
  return Math.max(0, Math.min(100, (
    (relativeUs - model.alignment.overlap.startRelativeUs)
    / model.alignment.overlap.durationUs
  ) * 100));
}

function ComparisonTimeline({
  model,
  cursorRelativeUs,
  onSeek,
}: {
  model: ComparisonModel;
  cursorRelativeUs: number;
  onSeek: (value: number) => void;
}) {
  const sourceRows = [
    { label: "Baseline", source: model.baseline, anchorUs: model.alignment.baselineAnchorUs },
    { label: "Candidate", source: model.candidate, anchorUs: model.alignment.candidateAnchorUs },
  ];
  const ticks = Array.from({ length: 5 }, (_, index) =>
    model.alignment.overlap.startRelativeUs
    + (model.alignment.overlap.durationUs * index) / 4);
  const playheadPercent = (
    (cursorRelativeUs - model.alignment.overlap.startRelativeUs)
    / model.alignment.overlap.durationUs
  ) * 100;
  return (
    <section className="comparison-timeline" aria-label="Aligned comparison timeline">
      <header>
        <div>
          <span>Aligned evidence</span>
          <strong>{model.alignment.label}</strong>
        </div>
        <p>Numeric deltas use only the common shaded intersection.</p>
      </header>
      <div className="comparison-ruler" aria-hidden="true">
        {ticks.map((tick) => <span key={tick}>{exactOffset(Math.round(tick))}</span>)}
      </div>
      <div className="comparison-timeline-body">
        <input
          className="comparison-scrubber"
          type="range"
          min={model.alignment.overlap.startRelativeUs}
          max={model.alignment.overlap.endRelativeUs - 1}
          step={1}
          value={cursorRelativeUs}
          aria-label="Aligned comparison position"
          aria-valuetext={`${exactOffset(cursorRelativeUs)} from the declared anchor`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        {sourceRows.map(({ label, source, anchorUs }) => {
          const absoluteStart = anchorUs + model.alignment.overlap.startRelativeUs;
          const absoluteEnd = anchorUs + model.alignment.overlap.endRelativeUs;
          const alignedFrames = source.frames.filter((frame) =>
            frame.offsetUs >= absoluteStart && frame.offsetUs < absoluteEnd);
          const alignedDiagnostics = source.diagnostics.filter((diagnostic) => diagnostic.endUs == null
            ? diagnostic.startUs >= absoluteStart && diagnostic.startUs < absoluteEnd
            : diagnostic.startUs < absoluteEnd && diagnostic.endUs > absoluteStart);
          const frames = alignedFrames.slice(0, 600);
          const diagnostics = alignedDiagnostics.slice(0, 300);
          return (
            <div className="comparison-source-lanes" key={label}>
              <div className="comparison-source-label">
                <strong>{label}</strong>
                <span>{source.sessionId}</span>
              </div>
              <div className="comparison-source-tracks">
                <div>
                  <span title={`${alignedFrames.length.toLocaleString()} aligned packets`}>
                    Packets{frames.length < alignedFrames.length ? ` ${frames.length}/${alignedFrames.length}` : ""}
                  </span>
                  <div className="comparison-track">
                    <i className="comparison-playhead" style={{ left: `${playheadPercent}%` }} />
                    {frames.map((frame) => (
                      <i
                        className={`comparison-mark packet ${frame.integrityStatus === "valid" ? "valid" : "invalid"}`}
                        key={frame.id}
                        style={{ left: `${relativePercent(frame.offsetUs, anchorUs, model)}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    {frames.length === 0 && <em>No decoded packets in overlap</em>}
                  </div>
                </div>
                <div>
                  <span title={`${alignedDiagnostics.length.toLocaleString()} aligned diagnostics`}>
                    Diagnostics{diagnostics.length < alignedDiagnostics.length ? ` ${diagnostics.length}/${alignedDiagnostics.length}` : ""}
                  </span>
                  <div className="comparison-track">
                    <i className="comparison-playhead" style={{ left: `${playheadPercent}%` }} />
                    {diagnostics.map((diagnostic) => (
                      <i
                        className={`comparison-mark diagnostic ${diagnostic.severity}`}
                        key={diagnostic.id}
                        style={{ left: `${relativePercent(diagnostic.startUs, anchorUs, model)}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    {diagnostics.length === 0 && <em>No diagnostics in overlap</em>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <footer>
        <span>Aligned cursor</span>
        <strong>{exactOffset(cursorRelativeUs)}</strong>
        <span>Baseline {(model.alignment.baselineAnchorUs + cursorRelativeUs).toLocaleString()} µs · Candidate {(model.alignment.candidateAnchorUs + cursorRelativeUs).toLocaleString()} µs</span>
      </footer>
    </section>
  );
}

function MetricTable({
  model,
  selectedMetricId,
  onSelect,
}: {
  model: ComparisonModel;
  selectedMetricId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="comparison-metrics">
      <header>
        <div><span>Bounded measures</span><strong>{model.metrics.length} measures</strong></div>
        <p>Deltas are withheld when the evidence contract does not support them.</p>
      </header>
      <p id="comparison-table-scroll-instructions" className="visually-hidden">This comparison table scrolls horizontally in narrow layouts. Use Left and Right Arrow keys when the region is focused.</p>
      <div className="comparison-table-scroll keyboard-scroll-region" tabIndex={0} role="region" aria-label="Scrollable comparison measures" aria-describedby="comparison-table-scroll-instructions" onKeyDown={handleHorizontalScrollKey}>
        <table>
          <thead><tr><th>Measure</th><th>Baseline</th><th>Candidate</th><th>Delta</th><th>Finding</th></tr></thead>
          <tbody>
            {model.metrics.map((metric) => (
              <tr className={metric.id === selectedMetricId ? "active" : ""} key={metric.id}>
                <td><button type="button" onClick={() => onSelect(metric.id)}>{metric.label}</button><small>{humanize(metric.status)}</small></td>
                <td>{metricValue(metric.baseline, metric.unit)}</td>
                <td>{metricValue(metric.candidate, metric.unit)}</td>
                <td>{metric.delta == null ? "Withheld" : metricValue(metric.delta, metric.unit)}</td>
                <td><span className={`comparison-finding ${metric.assessment}`}>{humanize(metric.assessment)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvidenceList({
  label,
  ids,
  totalCount,
}: {
  label: string;
  ids: readonly string[];
  totalCount: number;
}) {
  return (
    <section className="comparison-evidence-ids">
      <div><span>{label}</span><b>{ids.length} / {totalCount}</b></div>
      {ids.length === 0 ? <p>No source rows support this measure in the aligned overlap.</p> : (
        <>
          {ids.length < totalCount && <p>Showing the first {ids.length} IDs from the bounded source range.</p>}
          <ul>{ids.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
        </>
      )}
    </section>
  );
}

function ComparisonInspector({
  model,
  metric,
}: {
  model: ComparisonModel;
  metric: ComparisonMetric;
}) {
  const [conclusion, setConclusion] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    setConclusion("");
    setNotice("");
  }, [model]);
  const exportFinding = () => {
    try {
      const finding = buildComparisonFinding(model, conclusion);
      downloadComparisonFinding(finding, suggestComparisonFindingFilename(model));
      setNotice(`Finding downloaded · ${finding.identity.canonicalSha256.slice(0, 12)}…`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The finding could not be exported.");
    }
  };
  return (
    <aside className="comparison-inspector" aria-label="Comparison finding inspector">
      <header>
        <span>Traceable finding</span>
        <strong className={metric.assessment}>{humanize(metric.assessment)}</strong>
      </header>
      <section className="comparison-metric-detail">
        <span>{humanize(metric.category)}</span>
        <h2>{metric.label}</h2>
        <dl>
          <div><dt>Baseline</dt><dd>{metricValue(metric.baseline, metric.unit)}</dd></div>
          <div><dt>Candidate</dt><dd>{metricValue(metric.candidate, metric.unit)}</dd></div>
          <div><dt>Delta</dt><dd>{metric.delta == null ? "Withheld" : metricValue(metric.delta, metric.unit)}</dd></div>
          <div><dt>Eligibility</dt><dd>{humanize(metric.status)}</dd></div>
        </dl>
        <p>{metric.reason}</p>
      </section>
      <p id="comparison-evidence-scroll-instructions" className="visually-hidden">
        The source evidence and limitation lists scroll vertically. Focus this region and use Arrow keys, Page Up, Page Down, Home, or End to review all rows.
      </p>
      <div
        className="comparison-evidence-scroll"
        tabIndex={0}
        role="region"
        aria-label="Comparison source evidence and limitations"
        aria-describedby="comparison-evidence-scroll-instructions"
      >
        <EvidenceList label="Baseline evidence IDs" ids={metric.baselineEvidenceIds} totalCount={metric.baselineEvidenceCount} />
        <EvidenceList label="Candidate evidence IDs" ids={metric.candidateEvidenceIds} totalCount={metric.candidateEvidenceCount} />
        <section className="comparison-limitations">
          <div><span>Recorded limitations</span><b>{model.limitations.length}</b></div>
          <ul>{model.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
        </section>
      </div>
      <section className="comparison-conclusion">
        <label htmlFor="comparison-conclusion">Operator conclusion</label>
        <textarea
          id="comparison-conclusion"
          value={conclusion}
          maxLength={MAX_COMPARISON_CONCLUSION_LENGTH}
          placeholder="State what changed, what did not, and what remains unresolved."
          onChange={(event) => setConclusion(event.target.value)}
        />
        <div><span>{conclusion.length.toLocaleString()} / {MAX_COMPARISON_CONCLUSION_LENGTH.toLocaleString()}</span><button className="primary-action" type="button" onClick={exportFinding}><DownloadSimple size={16} /> Export finding</button></div>
        <p className="comparison-export-notice" role="status">{notice}</p>
      </section>
    </aside>
  );
}

export function ComparisonWorkspace(props: ComparisonWorkspaceProps) {
  const { model } = props;
  const [cursorRelativeUs, setCursorRelativeUs] = useState(Math.max(
    model.alignment.overlap.startRelativeUs,
    Math.min(0, model.alignment.overlap.endRelativeUs - 1),
  ));
  const [selectedMetricId, setSelectedMetricId] = useState(model.metrics[0]?.id ?? "");
  useEffect(() => {
    setCursorRelativeUs(Math.max(
      model.alignment.overlap.startRelativeUs,
      Math.min(0, model.alignment.overlap.endRelativeUs - 1),
    ));
    setSelectedMetricId(model.metrics[0]?.id ?? "");
  }, [model]);
  const selectedMetric = model.metrics.find((metric) => metric.id === selectedMetricId) ?? model.metrics[0];
  if (!selectedMetric) return null;

  return (
    <main className="app-shell comparison-shell" aria-label="Comparative telemetry evidence workspace">
      <ComparisonRail model={model} onNewComparison={props.onNewComparison} />
      <ComparisonTopBar {...props} />
      <ComparabilityStrip model={model} />
      <ComparisonTimeline model={model} cursorRelativeUs={cursorRelativeUs} onSeek={setCursorRelativeUs} />
      <MetricTable model={model} selectedMetricId={selectedMetric.id} onSelect={setSelectedMetricId} />
      <ComparisonInspector model={model} metric={selectedMetric} />
      <div className="visually-hidden" role="status" aria-live="polite">
        Aligned comparison position {exactOffset(cursorRelativeUs)}
      </div>
    </main>
  );
}
