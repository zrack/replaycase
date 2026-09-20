import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowsLeftRight,
  DownloadSimple,
  FloppyDisk,
  FolderOpen,
  LinkSimple,
  NotePencil,
  Plus,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";

import {
  CASE_LIMITS,
  caseContent,
  newCaseContent,
  resolveCaseCitation,
  type CaseCitation,
  type CaseContent,
  type CaseFinding,
  type VerifiedCase,
} from "../domain/case";
import {
  createReceiverComparisonSource,
  type ComparisonFinding,
  type ComparisonModel,
} from "../domain/comparison";
import {
  ComparisonSetupDialog,
  ComparisonWorkspace,
} from "../comparison/ComparisonWorkspace";
import { compareSourcesInWorker } from "../processing/comparison-processing";
import { ReceiverWorkspace } from "../receiver/ReceiverWorkspace";
import {
  createCaseLibrary,
  type CaseLibraryEntry,
} from "../storage/case-library";
import { processCase, readCaseFile, type CaseRequest } from "./case-processing";
import "./cases.css";

const library = createCaseLibrary();
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The case operation failed.";
const shortHash = (hash: string) => `${hash.slice(0, 12)}...${hash.slice(-8)}`;
const citeLabel = (citation: CaseCitation) =>
  citation.kind === "range"
    ? `[${citation.startUs}, ${citation.endUs}) us`
    : citation.kind === "record"
      ? citation.recordId
      : citation.diagnosticId;

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(
    new Blob([Uint8Array.from(bytes)], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function CaseWorkspace({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState<VerifiedCase | null>(null);
  const [savedHash, setSavedHash] = useState<string | null>(null);
  const [entries, setEntries] = useState<CaseLibraryEntry[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, message: "" });
  const [storageBusy, setStorageBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bundlesInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [selectedHash, setSelectedHash] = useState("");
  const [candidateHash, setCandidateHash] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [setup, setSetup] = useState(false);
  const [comparison, setComparison] = useState<ComparisonModel | null>(null);
  const [comparisonConclusion, setComparisonConclusion] = useState("");
  const [citation, setCitation] = useState<CaseCitation | null>(null);
  const [findingDraft, setFindingDraft] = useState<CaseFinding | null>(null);
  const dirty = !!active && active.archiveHash !== savedHash;
  const draftDirty =
    !!findingDraft ||
    (!!active &&
      (title !== active.manifest.title || summary !== active.manifest.summary));
  const locked = busy || storageBusy;
  const selected = active?.bundles.find(
    (bundle) => bundle.document.bundle.sha256 === selectedHash,
  );
  const candidate = active?.bundles.find(
    (bundle) => bundle.document.bundle.sha256 === candidateHash,
  );

  const refresh = async () => {
    try {
      setEntries(await library.list());
    } catch (cause) {
      setError(message(cause));
    }
  };
  useEffect(() => {
    void refresh();
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty || draftDirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, draftDirty]);
  const accept = (value: VerifiedCase, persisted: string | null) => {
    setActive(value);
    setSavedHash(persisted);
    setTitle(value.manifest.title);
    setSummary(value.manifest.summary);
    setSelectedHash(value.manifest.bundles[0]?.sha256 ?? "");
    setCandidateHash(value.manifest.bundles[1]?.sha256 ?? "");
    setFindingDraft(null);
    setCitation(null);
    setComparison(null);
    setInspecting(false);
  };
  const allowReplace = () =>
    !(dirty || draftDirty) ||
    window.confirm(
      "Discard unsaved case changes? Export or save the case first to retain them.",
    );
  const run = async (
    operation: (
      signal: AbortSignal,
      onProgress: typeof setProgress,
    ) => Promise<VerifiedCase>,
  ) => {
    if (controller.current)
      throw new Error("Another case operation is running.");
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    setError("");
    setNotice("");
    setProgress({ percent: 0, message: "Preparing case" });
    try {
      const value = await operation(next.signal, setProgress);
      if (next.signal.aborted)
        throw new DOMException("Case operation canceled.", "AbortError");
      return value;
    } finally {
      if (controller.current === next) {
        controller.current = null;
        setBusy(false);
      }
    }
  };
  const process = (request: CaseRequest) =>
    run((signal, onProgress) => processCase(request, { signal, onProgress }));
  const report = (cause: unknown) => {
    if (cause instanceof Error && cause.name === "AbortError")
      setNotice("Operation canceled. The active case is unchanged.");
    else setError(message(cause));
  };
  const update = async (
    content: CaseContent,
    bundleBytes = active?.bundles.map((bundle) => bundle.bytes) ?? [],
  ) => {
    const value = await process({
      kind: "build",
      content: { ...content, updatedAt: new Date().toISOString() },
      bundles: bundleBytes,
    });
    setActive(value);
    return value;
  };
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!allowReplace()) return;
    const name = String(
      new FormData(event.currentTarget).get("caseName") ?? "",
    );
    try {
      accept(
        await process({
          kind: "build",
          content: newCaseContent(
            name,
            crypto.randomUUID(),
            new Date().toISOString(),
          ),
          bundles: [],
        }),
        null,
      );
    } catch (cause) {
      report(cause);
    }
  };
  const open = async (entry: CaseLibraryEntry) => {
    if (!allowReplace()) return;
    try {
      const value = await run((signal, onProgress) =>
        library.load(entry.id, { signal, onProgress }),
      );
      accept(value, value.archiveHash);
    } catch (cause) {
      report(cause);
    }
  };
  const importCase = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !allowReplace()) return;
    try {
      const value = await run(async (signal, onProgress) =>
        processCase(
          { kind: "import", archive: await readCaseFile(file) },
          { signal, onProgress },
        ),
      );
      accept(value, null);
      setNotice("Case verified and open in memory. Not yet saved locally.");
    } catch (cause) {
      report(cause);
    }
  };
  const addBundles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!active || files.length === 0) return;
    try {
      const value = await run(async (signal, onProgress) => {
        if (
          files.length > CASE_LIMITS.bundles ||
          files.reduce((total, file) => total + file.size, 0) >
            CASE_LIMITS.bundleBytes
        )
          throw new Error(
            "Selection exceeds the 16-file / 48 MiB import limit.",
          );
        const additions = [];
        for (const file of files) {
          if (signal.aborted) throw new DOMException("Canceled", "AbortError");
          additions.push({
            fileName: file.name,
            bytes: await readCaseFile(file, CASE_LIMITS.bundleBytes),
          });
        }
        return processCase(
          {
            kind: "build",
            content: {
              ...caseContent(active.manifest),
              updatedAt: new Date().toISOString(),
            },
            bundles: active.bundles.map((bundle) => bundle.bytes),
            additions,
          },
          { signal, onProgress },
        );
      });
      if (value.bundles.length !== active.bundles.length) setActive(value);
      setSelectedHash(selectedHash || value.manifest.bundles[0]?.sha256 || "");
      setCandidateHash(
        candidateHash || value.manifest.bundles[1]?.sha256 || "",
      );
      setNotice(
        `${value.bundles.length - active.bundles.length} distinct bundles added. Exact duplicates were not added again.`,
      );
    } catch (cause) {
      report(cause);
    }
  };
  const save = async () => {
    if (!active || locked || controller.current) return;
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setProgress({ percent: 0, message: "Verifying case before saving" });
    setStorageBusy(true);
    setError("");
    setNotice("");
    try {
      await library.save(active, savedHash, {
        signal: operation.signal,
        onProgress: setProgress,
      });
      setSavedHash(active.archiveHash);
      setNotice("Case saved locally.");
      await refresh();
    } catch (cause) {
      report(cause);
    } finally {
      if (controller.current === operation) controller.current = null;
      setBusy(false);
      setStorageBusy(false);
    }
  };
  const remove = async (entry: CaseLibraryEntry) => {
    if (
      !window.confirm(
        `Remove saved case "${entry.title}" and its embedded bundles and findings? The open in-memory case and exported files remain unchanged.`,
      )
    )
      return;
    setStorageBusy(true);
    try {
      await library.remove(entry.id, entry.archiveHash);
      if (active?.manifest.id === entry.id) setSavedHash(null);
      await refresh();
      setNotice("Saved case removed. Exported files were not changed.");
    } catch (cause) {
      report(cause);
    } finally {
      setStorageBusy(false);
    }
  };
  const exportCase = async () => {
    if (!active) return;
    try {
      const verified = await process({
        kind: "import",
        archive: active.archive,
        expectedHash: active.archiveHash,
      });
      download(
        verified.archive,
        `${
          verified.manifest.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .slice(0, 80) || "investigation"
        }.nlcase`,
      );
      setNotice(`Case exported: ${shortHash(verified.archiveHash)}.`);
    } catch (cause) {
      report(cause);
    }
  };
  const removeBundle = async (hash: string) => {
    if (!active) return;
    if (findingDraft) {
      setError("Apply or cancel the finding draft before removing evidence.");
      return;
    }
    const cited =
      active.manifest.findings.some((finding) =>
        finding.citations.some((item) => item.bundleHash === hash),
      ) ||
      active.manifest.comparisons.some((finding) =>
        [
          finding.inputs.baseline.identity,
          finding.inputs.candidate.identity,
        ].includes(`sha256:${hash}`),
      );
    if (cited) {
      setError(
        "This bundle is cited by a finding, question, or comparison. Remove those references first.",
      );
      return;
    }
    if (
      !window.confirm(
        "Remove this uncited bundle from the open case? The original file is unchanged.",
      )
    )
      return;
    try {
      await update(
        {
          ...caseContent(active.manifest),
          bundles: active.manifest.bundles.filter(
            (bundle) => bundle.sha256 !== hash,
          ),
        },
        active.bundles
          .filter((bundle) => bundle.document.bundle.sha256 !== hash)
          .map((bundle) => bundle.bytes),
      );
      if (selectedHash === hash) setSelectedHash("");
      if (candidateHash === hash) setCandidateHash("");
      if (citation?.bundleHash === hash) setCitation(null);
    } catch (cause) {
      report(cause);
    }
  };
  const saveComparison = async (finding: ComparisonFinding) => {
    if (!active) return;
    if (
      active.manifest.comparisons.some(
        (item) =>
          item.identity.canonicalSha256 === finding.identity.canonicalSha256,
      )
    )
      return;
    await update({
      ...caseContent(active.manifest),
      comparisons: [...active.manifest.comparisons, finding],
    });
  };
  const reopenComparison = async (finding: ComparisonFinding) => {
    if (!active) return;
    const baseline = active.bundles.find(
      (bundle) =>
        `sha256:${bundle.document.bundle.sha256}` ===
        finding.inputs.baseline.identity,
    )!;
    const other = active.bundles.find(
      (bundle) =>
        `sha256:${bundle.document.bundle.sha256}` ===
        finding.inputs.candidate.identity,
    )!;
    try {
      let model: ComparisonModel | undefined;
      await run(async (signal, onProgress) => {
        model = await compareSourcesInWorker(
          createReceiverComparisonSource(baseline.document),
          createReceiverComparisonSource(other.document),
          finding.alignment,
          { signal, onProgress },
        );
        return active;
      });
      if (model) {
        setComparison(model);
        setComparisonConclusion(finding.conclusion);
      }
    } catch (cause) {
      report(cause);
    }
  };
  const chrome = (
    <>
      {busy && (
        <div className="case-processing" role="status">
          <span>{progress.message}</span>
          <progress
            max={100}
            value={progress.percent}
            aria-label="Case processing progress"
          />
          <button type="button" onClick={() => controller.current?.abort()}>
            <X size={14} /> Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="case-message error" role="alert">
          {error}
          <button
            type="button"
            aria-label="Dismiss case error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </p>
      )}
    </>
  );
  const inputs = (
    <>
      <input
        ref={input}
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        accept=".nlcase"
        aria-label="Choose a ReplayCase case archive"
        onChange={(event) => void importCase(event)}
      />
      <input
        ref={bundlesInput}
        className="visually-hidden"
        tabIndex={-1}
        type="file"
        accept=".nlb"
        multiple
        aria-label="Choose case evidence bundles"
        onChange={(event) => void addBundles(event)}
      />
    </>
  );
  if (comparison)
    return (
      <>
        {inputs}
        <ComparisonWorkspace
          model={comparison}
          initialConclusion={comparisonConclusion}
          onSaveFinding={saveComparison}
          onReturn={() => setComparison(null)}
          onNewComparison={() => {
            setComparison(null);
            setSetup(true);
          }}
          onOpenCases={() => setComparison(null)}
          onOpenReplay={onClose}
          onOpenBundle={() => {
            setComparison(null);
            bundlesInput.current?.click();
          }}
        />
        {chrome}
      </>
    );
  if (inspecting && selected)
    return (
      <>
        {inputs}
        <ReceiverWorkspace
          document={selected.document}
          fileName={
            active!.manifest.bundles.find(
              (bundle) => bundle.sha256 === selectedHash,
            )!.fileName
          }
          onOpenCases={() => setInspecting(false)}
          onOpenBundle={() => {
            setInspecting(false);
            bundlesInput.current?.click();
          }}
          onOpenReplay={onClose}
          onLoadBundledReplay={onClose}
          onCompare={() => {
            setInspecting(false);
            if (!candidate || candidateHash === selectedHash) {
              setSetup(false);
              setNotice("Select a distinct candidate bundle to compare.");
            } else setSetup(true);
          }}
        />
        {chrome}
      </>
    );

  return (
    <main className="case-shell" aria-label="Case workspace">
      <header className="case-header">
        <div className="brand-lockup">
          <img src="/replaycase-mark.svg" alt="ReplayCase" />
          <div>
            <strong>ReplayCase</strong>
            <span>Case workspace</span>
          </div>
        </div>
        <div className="case-heading">
          <span>Investigation</span>
          <h1 tabIndex={-1}>{active?.manifest.title ?? "Local cases"}</h1>
          <small>
            {active
              ? dirty
                ? "Unsaved changes"
                : "Saved locally"
              : "No case open"}
          </small>
        </div>
        <div className="case-actions">
          <button
            className="secondary-action"
            disabled={locked}
            onClick={onClose}
          >
            <ArrowLeft size={15} /> Replay
          </button>
          <button
            className="secondary-action"
            disabled={locked}
            onClick={() => input.current?.click()}
          >
            <UploadSimple size={15} /> Import case
          </button>
          <button
            className="secondary-action"
            disabled={locked || !active || draftDirty}
            onClick={() => void save()}
          >
            <FloppyDisk size={15} /> Save case
          </button>
          <button
            className="primary-action"
            disabled={locked || !active || draftDirty}
            onClick={() => void exportCase()}
          >
            <DownloadSimple size={15} /> Export case
          </button>
        </div>
      </header>
      {inputs}
      <aside className="case-library" aria-label="Saved cases">
        <form onSubmit={(event) => void create(event)}>
          <label>
            New case title
            <input name="caseName" required maxLength={240} disabled={locked} />
          </label>
          <button className="secondary-action" disabled={locked}>
            <Plus size={15} /> Create case
          </button>
        </form>
        <div className="section-kicker-row">
          <span>Saved cases</span>
          <button
            className="icon-button"
            disabled={locked}
            title="Refresh saved cases"
            aria-label="Refresh saved cases"
            onClick={() => void refresh()}
          >
            <FolderOpen size={16} />
          </button>
        </div>
        {entries.map((entry) => (
          <div className="case-library-row" key={entry.id}>
            <button disabled={locked} onClick={() => void open(entry)}>
              <strong>{entry.title}</strong>
              <small>
                {entry.bundleCount} bundles / {entry.updatedAt.slice(0, 10)}
              </small>
            </button>
            <button
              className="icon-button"
              disabled={locked}
              aria-label={`Remove saved case ${entry.title}`}
              title="Remove saved case"
              onClick={() => void remove(entry)}
            >
              <Trash size={15} />
            </button>
          </div>
        ))}
        {!entries.length && <p>No saved cases.</p>}
      </aside>
      <div className="case-content">
        {notice && (
          <p className="case-notice" role="status">
            {notice}
          </p>
        )}
        {draftDirty && (
          <p className="case-notice">
            Unapplied draft. Apply or cancel the edit before saving or
            exporting.
          </p>
        )}
        {!active ? (
          <div className="case-empty">
            <FolderOpen size={36} />
            <h2>No case open</h2>
            <button
              className="secondary-action"
              disabled={locked}
              onClick={() => input.current?.click()}
            >
              <UploadSimple size={16} /> Import case
            </button>
          </div>
        ) : (
          <>
            <section className="case-section">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void update({
                    ...caseContent(active.manifest),
                    title,
                    summary,
                  })
                    .then((value) => {
                      setTitle(value.manifest.title);
                      setSummary(value.manifest.summary);
                      setNotice("Case details updated in memory.");
                    })
                    .catch(report);
                }}
              >
                <fieldset disabled={locked}>
                  <legend>Case details</legend>
                  <label>
                    Case title
                    <input
                      required
                      maxLength={240}
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <label>
                    Investigation summary
                    <textarea
                      maxLength={4_000}
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                    />
                  </label>
                  <div className="case-actions">
                    <button
                      className="secondary-action"
                      type="submit"
                      disabled={
                        title === active.manifest.title &&
                        summary === active.manifest.summary
                      }
                    >
                      <FloppyDisk size={15} /> Apply details
                    </button>
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={() => {
                        setTitle(active.manifest.title);
                        setSummary(active.manifest.summary);
                      }}
                    >
                      Cancel edit
                    </button>
                  </div>
                </fieldset>
              </form>
            </section>
            <section className="case-section" aria-label="Case evidence">
              <div className="case-section-heading">
                <h2>
                  Evidence bundles{" "}
                  <small>
                    {active.bundles.length} / {CASE_LIMITS.bundles}
                  </small>
                </h2>
                <button
                  className="secondary-action"
                  disabled={locked}
                  onClick={() => bundlesInput.current?.click()}
                >
                  <Plus size={15} /> Add bundles
                </button>
              </div>
              <div
                className="case-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Case evidence table"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Bundle</th>
                      <th>Capture</th>
                      <th>Evidence</th>
                      <th>Identity</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.manifest.bundles.map((descriptor, index) => {
                      const bundle = active.bundles[index]!;
                      return (
                        <tr key={descriptor.sha256}>
                          <td>
                            <strong>{descriptor.label}</strong>
                            <small>
                              {bundle.document.incident.title ??
                                bundle.document.sourceSession.title}
                            </small>
                          </td>
                          <td>{bundle.document.claims.captureEvidence}</td>
                          <td>{bundle.document.claims.evidenceCompleteness}</td>
                          <td>
                            <code title={descriptor.sha256}>
                              {shortHash(descriptor.sha256)}
                            </code>
                          </td>
                          <td>
                            <div className="case-actions">
                              <button
                                className="icon-button"
                                disabled={locked}
                                title="Inspect bundle"
                                aria-label={`Inspect ${descriptor.label}`}
                                onClick={() => {
                                  setSelectedHash(descriptor.sha256);
                                  setInspecting(true);
                                }}
                              >
                                <FolderOpen size={17} />
                              </button>
                              <button
                                className="icon-button"
                                disabled={locked}
                                title="Remove bundle"
                                aria-label={`Remove bundle ${descriptor.label}`}
                                onClick={() =>
                                  void removeBundle(descriptor.sha256)
                                }
                              >
                                <Trash size={16} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="case-limitations">
                Internal consistency verified per bundle. Source authenticity is
                not established. Capture completeness and clock alignment remain
                separate claims.
              </p>
              <fieldset
                className="case-compare"
                disabled={locked || active.bundles.length < 2}
              >
                <legend>Compare evidence</legend>
                <label>
                  Baseline bundle
                  <select
                    value={selectedHash}
                    onChange={(event) => setSelectedHash(event.target.value)}
                  >
                    <option value="">Select baseline</option>
                    {active.manifest.bundles.map((bundle) => (
                      <option key={bundle.sha256} value={bundle.sha256}>
                        {bundle.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Candidate bundle
                  <select
                    value={candidateHash}
                    onChange={(event) => setCandidateHash(event.target.value)}
                  >
                    <option value="">Select candidate</option>
                    {active.manifest.bundles.map((bundle) => (
                      <option key={bundle.sha256} value={bundle.sha256}>
                        {bundle.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="secondary-action"
                  disabled={
                    !selected || !candidate || selectedHash === candidateHash
                  }
                  onClick={() => setSetup(true)}
                >
                  <ArrowsLeftRight size={15} /> Compare bundles
                </button>
              </fieldset>
            </section>
            <section className="case-section" aria-label="Case findings">
              <div className="case-section-heading">
                <h2>Findings and questions</h2>
                <button
                  className="secondary-action"
                  disabled={locked || !active.bundles.length || !!findingDraft}
                  onClick={() =>
                    setFindingDraft({
                      id: crypto.randomUUID(),
                      kind: "finding",
                      body: "",
                      citations: [],
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    })
                  }
                >
                  <Plus size={15} /> New finding
                </button>
              </div>
              {findingDraft && (
                <FindingEditor
                  key={findingDraft.id}
                  finding={findingDraft}
                  setFinding={setFindingDraft}
                  active={active}
                  locked={locked}
                  onCancel={() => setFindingDraft(null)}
                  onSave={async (finding) => {
                    await update({
                      ...caseContent(active.manifest),
                      findings: [
                        ...active.manifest.findings.filter(
                          (item) => item.id !== finding.id,
                        ),
                        finding,
                      ],
                    });
                    setFindingDraft(null);
                  }}
                  onError={report}
                />
              )}
              {!active.manifest.findings.length && !findingDraft && (
                <p>No authored findings or questions.</p>
              )}
              {active.manifest.findings.map((finding) => (
                <article className="case-finding" key={finding.id}>
                  <div className="case-section-heading">
                    <strong>
                      {finding.kind === "question"
                        ? "Open question"
                        : "Finding"}
                    </strong>
                    <div className="case-actions">
                      <button
                        className="icon-button"
                        disabled={locked || !!findingDraft}
                        title="Edit finding"
                        aria-label="Edit finding"
                        onClick={() => setFindingDraft(finding)}
                      >
                        <NotePencil size={16} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={locked || !!findingDraft}
                        title="Remove finding"
                        aria-label="Remove finding"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Remove this authored finding and its citations?",
                            )
                          )
                            void update({
                              ...caseContent(active.manifest),
                              findings: active.manifest.findings.filter(
                                (item) => item.id !== finding.id,
                              ),
                            }).catch(report);
                        }}
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  </div>
                  <p>{finding.body}</p>
                  <ul>
                    {finding.citations.map((item, index) => (
                      <li key={index}>
                        <button
                          className="case-citation"
                          onClick={() => setCitation(item)}
                        >
                          <LinkSimple size={14} />
                          {
                            active.manifest.bundles.find(
                              (bundle) => bundle.sha256 === item.bundleHash,
                            )?.label
                          }
                          : {citeLabel(item)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </section>
            <section className="case-section">
              <h2>Saved comparisons</h2>
              {!active.manifest.comparisons.length && (
                <p>No comparison findings in this case.</p>
              )}
              {active.manifest.comparisons.map((finding) => (
                <article
                  className="case-finding"
                  key={finding.identity.canonicalSha256}
                >
                  <div className="case-section-heading">
                    <strong>
                      {finding.assessment} / {finding.alignment.label}
                    </strong>
                    <div className="case-actions">
                      <button
                        className="secondary-action"
                        disabled={locked}
                        onClick={() => void reopenComparison(finding)}
                      >
                        <ArrowsLeftRight size={15} /> Open comparison
                      </button>
                      <button
                        className="icon-button"
                        disabled={locked}
                        title="Remove comparison"
                        aria-label="Remove comparison"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Remove this comparison finding from the case?",
                            )
                          )
                            void update({
                              ...caseContent(active.manifest),
                              comparisons: active.manifest.comparisons.filter(
                                (item) => item !== finding,
                              ),
                            }).catch(report);
                        }}
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  </div>
                  <p>{finding.conclusion || "No operator conclusion."}</p>
                  <small>{shortHash(finding.identity.canonicalSha256)}</small>
                </article>
              ))}
            </section>
            {citation && (
              <section
                className="case-section case-citation-detail"
                aria-label="Cited evidence"
              >
                <div className="case-section-heading">
                  <h2>Cited {citation.kind}</h2>
                  <button
                    className="icon-button"
                    title="Close citation"
                    aria-label="Close citation"
                    onClick={() => setCitation(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <code>{citation.bundleHash}</code>
                <pre>
                  {JSON.stringify(
                    resolveCaseCitation(
                      citation,
                      active.bundles.find(
                        (bundle) =>
                          bundle.document.bundle.sha256 === citation.bundleHash,
                      )!.document,
                    ),
                    null,
                    2,
                  )}
                </pre>
              </section>
            )}
          </>
        )}
      </div>
      {chrome}
      {setup && selected && candidate && selectedHash !== candidateHash && (
        <ComparisonSetupDialog
          baseline={createReceiverComparisonSource(selected.document)}
          initialCandidate={createReceiverComparisonSource(candidate.document)}
          onClose={() => setSetup(false)}
          onStart={(model) => {
            setComparison(model);
            setComparisonConclusion("");
            setSetup(false);
          }}
        />
      )}
    </main>
  );
}

function FindingEditor({
  finding,
  setFinding,
  active,
  locked,
  onSave,
  onCancel,
  onError,
}: {
  finding: CaseFinding;
  setFinding: (finding: CaseFinding) => void;
  active: VerifiedCase;
  locked: boolean;
  onSave: (finding: CaseFinding) => Promise<void>;
  onCancel: () => void;
  onError: (error: unknown) => void;
}) {
  const [hash, setHash] = useState(
    finding.citations[0]?.bundleHash ?? active.manifest.bundles[0]!.sha256,
  );
  const [kind, setKind] = useState<CaseCitation["kind"]>("range");
  const bundle = active.bundles.find(
    (item) => item.document.bundle.sha256 === hash,
  )!;
  const [start, setStart] = useState(bundle.document.incident.startUs);
  const [end, setEnd] = useState(bundle.document.incident.endUs);
  const [targetId, setTargetId] = useState("");
  const choices =
    kind === "record"
      ? bundle.document.evidence.rawRecords
      : bundle.document.evidence.diagnostics;
  const addCitation = () => {
    try {
      const citation: CaseCitation =
        kind === "range"
          ? { kind, bundleHash: hash, startUs: start, endUs: end }
          : kind === "record"
            ? { kind, bundleHash: hash, recordId: targetId }
            : { kind, bundleHash: hash, diagnosticId: targetId };
      resolveCaseCitation(citation, bundle.document);
      if (
        !finding.citations.some(
          (item) => JSON.stringify(item) === JSON.stringify(citation),
        )
      )
        setFinding({ ...finding, citations: [...finding.citations, citation] });
    } catch (error) {
      onError(error);
    }
  };
  return (
    <form
      className="case-finding-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ ...finding, updatedAt: new Date().toISOString() }).catch(
          onError,
        );
      }}
    >
      <fieldset disabled={locked}>
        <legend>Authored context</legend>
        <label>
          Entry type
          <select
            value={finding.kind}
            onChange={(event) =>
              setFinding({
                ...finding,
                kind: event.target.value as CaseFinding["kind"],
              })
            }
          >
            <option value="finding">Finding</option>
            <option value="question">Open question</option>
          </select>
        </label>
        <label>
          Finding text
          <textarea
            required
            maxLength={4_000}
            value={finding.body}
            onChange={(event) =>
              setFinding({ ...finding, body: event.target.value })
            }
          />
        </label>
        <div className="case-citation-fields">
          <label>
            Citation bundle
            <select
              value={hash}
              onChange={(event) => {
                const document = active.bundles.find(
                  (item) => item.document.bundle.sha256 === event.target.value,
                )!.document;
                setHash(event.target.value);
                setStart(document.incident.startUs);
                setEnd(document.incident.endUs);
                setTargetId("");
              }}
            >
              {active.manifest.bundles.map((item) => (
                <option key={item.sha256} value={item.sha256}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Citation kind
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CaseCitation["kind"]);
                setTargetId("");
              }}
            >
              <option value="range">Incident range</option>
              <option value="record">Raw record</option>
              <option value="diagnostic">Diagnostic</option>
            </select>
          </label>
          {kind === "range" ? (
            <>
              <label>
                Start offset (us)
                <input
                  type="number"
                  step={1}
                  min={bundle.document.incident.startUs}
                  max={bundle.document.incident.endUs - 1}
                  value={start}
                  onChange={(event) => setStart(Number(event.target.value))}
                />
              </label>
              <label>
                End offset (us, excluded)
                <input
                  type="number"
                  step={1}
                  min={start + 1}
                  max={bundle.document.incident.endUs}
                  value={end}
                  onChange={(event) => setEnd(Number(event.target.value))}
                />
              </label>
            </>
          ) : (
            <label>
              Exact evidence ID
              <input
                list="case-evidence-ids"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              />
              <datalist id="case-evidence-ids">
                {choices
                  .filter((item) => item.id.includes(targetId))
                  .slice(0, 30)
                  .map((item) => (
                    <option key={item.id} value={item.id} />
                  ))}
              </datalist>
              <small>
                {choices.length} included{" "}
                {kind === "record" ? "raw records" : "diagnostics"}
              </small>
            </label>
          )}
          <button
            className="secondary-action"
            type="button"
            disabled={finding.citations.length >= CASE_LIMITS.citations}
            onClick={addCitation}
          >
            <LinkSimple size={15} /> Add citation
          </button>
        </div>
        <ul className="case-draft-citations">
          {finding.citations.map((item, index) => (
            <li key={index}>
              <span>
                {shortHash(item.bundleHash)} / {citeLabel(item)}
              </span>
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove citation ${index + 1}`}
                onClick={() =>
                  setFinding({
                    ...finding,
                    citations: finding.citations.filter(
                      (_, offset) => offset !== index,
                    ),
                  })
                }
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        <div className="case-actions">
          <button
            className="primary-action"
            disabled={!finding.citations.length}
            type="submit"
          >
            <FloppyDisk size={15} /> Apply finding
          </button>
          <button className="secondary-action" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
