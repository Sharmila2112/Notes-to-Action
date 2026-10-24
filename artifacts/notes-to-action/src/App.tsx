import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { UserButton } from '@clerk/react';
import { AuthProvider } from '@/components/auth';
import { AlertCircle, ArrowRight, Check, Clock3, FileText, History, LoaderCircle, Play, RotateCcw, Sparkles } from 'lucide-react';
import { Link, Route, Switch, useLocation, useParams, Router as WouterRouter } from 'wouter';
import {
  getGetRunEventsQueryKey,
  getGetRunQueryKey,
  getListRunsQueryKey,
  getRunTasks,
  listRuns,
  useCreateRun,
  useGetRun,
  useGetRunEvents,
  useUpdateTask,
} from '@workspace/api-client-react';
import type { RunDetail, RunEvent, RunEventStep, RunStatus, Task, TaskPage } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const steps: RunEventStep[] = ['receive_input', 'create_run', 'call_model', 'parse_output', 'save_tasks', 'finish_run'];
const stepTitles: Record<RunEventStep, string> = {
  receive_input: 'Receive input',
  create_run: 'Create run',
  call_model: 'Call model',
  parse_output: 'Parse output',
  save_tasks: 'Save tasks',
  finish_run: 'Finish run',
};
const stepLayers: Record<RunEventStep, string> = {
  receive_input: 'Page / Server', create_run: 'Database', call_model: 'Outside service',
  parse_output: 'Server', save_tasks: 'Database', finish_run: 'Database',
};
const formatDate = (value?: string | null) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const formatDuration = (value?: number) => value === undefined ? '' : `${Math.round(value)} ms`;

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <div className="app-shell">
    <header className="topbar">
      <Link href="/" className="brand" aria-label="Notes to Action home" data-testid="link-home">
        <span className="brand-mark"><FileText size={16} strokeWidth={2.2} /></span>
        <span>notes<span style={{ color: '#9a7440' }}>/</span>to action</span>
      </Link>
      <nav className="top-nav" aria-label="Main navigation">
        <Link href="/" className={`nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-new-extraction">New extraction</Link>
        <Link href="/runs" className={`nav-link ${location.startsWith('/runs') ? 'active' : ''}`} data-testid="link-run-history">Run history</Link>
        <span className="nav-note">A clearer next step</span>
        <UserButton />
      </nav>
    </header>
    {children}
  </div>;
}

function StatusPill({ status }: { status?: RunStatus }) {
  const actual = status ?? 'pending';
  return <span className={`status-pill status-${actual}`} role="status" data-testid={`status-run-${actual}`}>
    <i className="status-dot" />{actual}
  </span>;
}

function Diagram({ events, status }: { events: RunEvent[]; status?: RunStatus }) {
  const byStep = useMemo(() => {
    const map = new Map<RunEventStep, RunEvent>();
    [...events].sort((a, b) => a.sequence - b.sequence).forEach((event) => map.set(event.step, event));
    return map;
  }, [events]);
  const failedSteps = useMemo(
    () => new Set(events.filter((event) => event.status === 'failed').map((event) => event.step)),
    [events],
  );
  const [speed, setSpeed] = useState(1);
  const [cursor, setCursor] = useState(-1);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || cursor < 0 || cursor >= events.length) return;
    const timer = window.setTimeout(() => {
      if (cursor + 1 >= events.length) setPlaying(false);
      else setCursor(cursor + 1);
    }, Math.max(180, events[cursor].duration_ms / speed));
    return () => window.clearTimeout(timer);
  }, [events, playing, cursor, speed]);
  const start = () => {
    if (!events.length) return;
    setCursor(0);
    setPlaying(true);
  };
  const latestFailed = [...events].reverse().find((event) => event.status === 'failed');
  const fallbackCallout = events.find((event) => event.step === 'parse_output' && event.status === 'retrying' && /fallback/i.test(event.detail));
  const retryCallout = events.find((event) => event.step === 'call_model' && event.status === 'retrying');
  const statusFor = (step: RunEventStep, event?: RunEvent) => {
    if (playing) {
      const current = events[cursor];
      if (current?.step === step) {
        return current.status === 'failed' ? 'failed' : current.status === 'succeeded' ? 'completed' : 'active';
      }
      const previous = events.slice(0, cursor + 1).filter((item) => item.step === step).at(-1);
      return previous?.status === 'failed' ? 'failed' : previous?.status === 'succeeded' ? 'completed' : previous ? 'active' : '';
    }
    if (!event) return '';
    if (event.status === 'failed' || failedSteps.has(step)) return 'failed';
    if (event.status === 'succeeded') return 'completed';
    if (event.status === 'started' || event.status === 'retrying') return 'active';
    return '';
  };
  return <section className="panel diagram-panel" aria-label="Extraction process diagram">
    <div className="diagram-top">
      <div>
        <div className="small-label">Execution trace</div>
        <h2 className="section-title" style={{ marginTop: 5 }}>Six steps, fully visible</h2>
      </div>
      <StatusPill status={status} />
    </div>
    {status === 'pending' && events.length === 0 && <div className="pending-box" style={{ marginBottom: 15 }}>
      Intake is ready. Once you extract, the saved event stream will show each step and its result here.
    </div>}
    <div className="diagram-flow">
      {steps.map((step, index) => {
        const event = byStep.get(step);
        const nodeStatus = statusFor(step, event);
        const replayEvent = playing && events[cursor]?.step === step ? events[cursor] : event;
        return <div className="flow-item" key={step}>
          <div className="layer-label">{stepLayers[step]}</div>
          <div className={`diagram-node ${nodeStatus}`} data-testid={`step-${step}`}>
            {nodeStatus === 'completed' && <Check className="node-indicator" size={13} />}
            {nodeStatus === 'active' && <LoaderCircle className="node-indicator spin" size={13} />}
            {nodeStatus === 'failed' && <AlertCircle className="node-indicator" size={13} />}
            <div className="node-title">{step}</div>
            <div className="node-subtitle">{stepTitles[step]}</div>
            <div className="node-meta">{replayEvent ? `${replayEvent.status} · ${formatDuration(replayEvent.duration_ms)}` : 'Waiting'}</div>
            {replayEvent && <div className="node-detail" title={replayEvent.detail}>{replayEvent.detail}</div>}
          </div>
        </div>;
      })}
    </div>
    {latestFailed && <div className="event-note error" role="alert" data-testid="text-step-error">
      <strong>{stepTitles[latestFailed.step]} returned an error.</strong> {latestFailed.detail}
    </div>}
    {retryCallout && <div className="callout" data-testid="text-retry-callout">
      Retry recorded · attempt {retryCallout.attempt}. {retryCallout.detail}
    </div>}
    {fallbackCallout && <div className="callout fallback-callout" data-testid="text-fallback-callout">
      Line-based fallback recorded. {fallbackCallout.detail}
    </div>}
    {events.some((event) => event.detail.includes('(demo mode)')) && <div className="event-note" data-testid="text-demo-mode">
      {events.find((event) => event.detail.includes('(demo mode)'))?.detail}
    </div>}
    {status === 'failed' && !fallbackCallout && !retryCallout && <div className="callout" data-testid="text-fallback-callout">
      Retry or fallback callout · this run stopped at the recorded failure. Your original notes remain available.
    </div>}
    <div className="replay-bar">
      <div className="replay-controls">
        <span className="replay-label">Replay</span>
        <button className="button-quiet" type="button" onClick={start} disabled={!events.length} aria-label="Replay recorded steps" data-testid="button-replay">
          {playing ? <LoaderCircle size={14} /> : <Play size={13} />} {playing ? 'Playing' : 'Play trace'}
        </button>
        {([0.5, 1, 2] as const).map((value) => <button key={value} type="button" className={`speed-button ${speed === value ? 'selected' : ''}`} onClick={() => setSpeed(value)} aria-pressed={speed === value} data-testid={`button-speed-${value}`}>
          {value}×
        </button>)}
      </div>
      <span className="replay-meta">{events.length ? `${events.length} persisted events · original durations` : 'No events to replay yet'}</span>
    </div>
  </section>;
}

function TaskList({
  tasks,
  runId,
  taskCount,
  nextCursor,
  canLoadMore,
}: {
  tasks: Task[];
  runId: string;
  taskCount: number;
  nextCursor: string | null;
  canLoadMore: boolean;
}) {
  const updateTask = useUpdateTask();
  const client = useQueryClient();
  const taskPagesQueryKey = [...getGetRunQueryKey(runId), 'task-pages'];
  const taskPages = useInfiniteQuery({
    queryKey: taskPagesQueryKey,
    initialPageParam: nextCursor ?? 'start',
    queryFn: ({ pageParam, signal }) => getRunTasks(runId, pageParam, { signal }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: false,
    retry: false,
  });
  const additionalTasks = taskPages.data?.pages.flatMap((page) => page.items) ?? [];
  const visibleTasks = [...tasks, ...additionalTasks];
  const hasMoreTasks = canLoadMore && (taskPages.data ? taskPages.hasNextPage : !!nextCursor);
  const taskCountLabel = visibleTasks.length < taskCount
    ? `${visibleTasks.length} of ${taskCount} tasks`
    : `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  const changeDone = (task: Task, done: boolean) => {
    updateTask.mutate({ id: task.id, data: { done } }, {
      onSuccess: (updated) => {
        client.setQueryData<RunDetail>(getGetRunQueryKey(runId), (old) =>
          old ? { ...old, tasks: old.tasks?.map((item) => item.id === updated.id ? updated : item) } : old,
        );
        client.setQueryData<InfiniteData<TaskPage, string>>(taskPagesQueryKey, (old) =>
          old ? {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              items: page.items.map((item) => item.id === updated.id ? updated : item),
            })),
          } : old,
        );
      },
    });
  };
  return <section className="panel tasks-panel" aria-label="Extracted tasks">
    <div className="panel-heading">
      <div><div className="small-label">Your follow-through</div><h2 className="section-title" style={{ marginTop: 5 }}>Action items</h2></div>
        <span className="task-count" data-testid="text-task-count">{taskCountLabel}</span>
    </div>
      {visibleTasks.length ? <>
        <div className="task-scroll" role="region" aria-label="Action items table, scroll horizontally">
          <table className="task-table">
            <thead><tr><th scope="col">Done</th><th scope="col">Action</th><th scope="col">Owner</th><th scope="col">Due</th><th scope="col">Priority</th></tr></thead>
            <tbody>{visibleTasks.map((task) => <tr key={task.id} data-testid={`row-task-${task.id}`}>
              <td><input className="task-check" type="checkbox" checked={task.done} onChange={(event) => changeDone(task, event.target.checked)} aria-label={`Mark ${task.title} ${task.done ? 'not done' : 'done'}`} data-testid={`checkbox-task-${task.id}`} /></td>
              <td className={`task-title ${task.done ? 'done' : ''}`}>{task.title}</td>
              <td>{task.owner || 'Unassigned'}</td>
              <td>{task.due_date ? new Date(task.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}</td>
              <td><span className={`priority priority-${task.priority}`}>{task.priority}</span></td>
            </tr>)}</tbody>
          </table>
        </div>
        {hasMoreTasks && <div style={{ padding: '14px 20px' }}>
          <button className="button-secondary" type="button" onClick={() => { void taskPages.fetchNextPage(); }} disabled={taskPages.isFetching} data-testid="button-load-more-tasks">
            {taskPages.isFetchingNextPage ? <LoaderCircle size={14} className="spin" /> : null}
            {taskPages.isFetchingNextPage ? 'Loading tasks…' : taskPages.isFetchNextPageError ? 'Try again' : 'Load more tasks'}
          </button>
          {taskPages.isFetchNextPageError && <div className="error-message" role="alert" data-testid="text-task-page-error">
            More tasks could not be loaded. Your current task list is still available.
          </div>}
        </div>}
      </> : <div className="empty-tasks">No action items have been saved for this run. When extraction completes, each task will be listed here.</div>}
  </section>;
}

function RunPanel({ runId, retry, currentInput, onStatusChange }: { runId: string; retry: (text: string) => void; currentInput: (text: string) => void; onStatusChange?: (status: RunStatus) => void }) {
  const runQuery = useGetRun(runId, { query: { queryKey: getGetRunQueryKey(runId), enabled: !!runId, refetchInterval: (query) => query.state.data?.status === 'running' || query.state.data?.status === 'pending' ? 1000 : false } });
  const detail = runQuery.data;
  const eventsQuery = useGetRunEvents(runId, { query: { queryKey: getGetRunEventsQueryKey(runId), enabled: !!runId, refetchInterval: detail?.status === 'running' || detail?.status === 'pending' ? 1000 : false } });
  const events = useMemo(() => [...(eventsQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence), [eventsQuery.data]);
  useEffect(() => { if (detail?.input_text) currentInput(detail.input_text); }, [detail?.id, detail?.input_text, currentInput]);
  useEffect(() => { if (detail?.status) onStatusChange?.(detail.status); }, [detail?.status, onStatusChange]);
  if (runQuery.isLoading) return <div className="state-card" aria-live="polite"><div className="loading-line" style={{ width: '35%', marginBottom: 15 }} /><div className="loading-line" style={{ width: '70%' }} />Loading saved run…</div>;
  if (runQuery.isError || !detail) return <div className="error-card" role="alert"><div className="error-title"><AlertCircle size={16} />Run unavailable</div><div className="error-message">We couldn't load this run. Return to run history and try again.</div></div>;
  const active = detail.status === 'pending' || detail.status === 'running';
  return <>
    <div className="content-grid">
      <Diagram events={events} status={detail.status} />
      <div>
        {detail.status === 'failed' && <div className="error-card" role="alert" data-testid="status-failed-run">
          <div className="error-title"><AlertCircle size={16} />Extraction stopped</div>
          <div className="error-message">{detail.error || 'This extraction could not be completed.'}</div>
          <button className="button-secondary" type="button" style={{ marginTop: 13 }} onClick={() => retry(detail.input_text)} data-testid="button-retry-run">
            <RotateCcw size={14} /> Retry this extraction
          </button>
        </div>}
        {active && <div className="state-card" aria-live="polite"><Clock3 size={15} style={{ verticalAlign: 'middle', marginRight: 7 }} />{detail.status === 'pending' ? 'The server is validating this note before extraction.' : 'Extraction is in progress. This view refreshes as recorded steps arrive.'}</div>}
        <section className="panel" style={{ marginTop: 14, padding: '17px 19px' }}>
          <div className="panel-heading"><h2 className="section-title">Source notes</h2><span className="small-label">Original input</span></div>
          <div className="source-text">{detail.input_text}</div>
        </section>
      </div>
    </div>
    <div style={{ marginTop: 18 }}>
      {detail.status === 'succeeded' || detail.tasks.length > 0 ? <TaskList
        key={runId}
        tasks={detail.tasks}
        runId={runId}
        taskCount={detail.task_count ?? detail.tasks.length}
        nextCursor={detail.next_tasks_cursor ?? null}
        canLoadMore={!active}
      /> :
        <section className="panel tasks-panel"><div className="panel-heading"><div><div className="small-label">Your follow-through</div><h2 className="section-title" style={{ marginTop: 5 }}>Action items</h2></div><span className="task-count">0 tasks</span></div><div className="empty-tasks">Tasks will appear here once the run saves its extraction.</div></section>}
    </div>
  </>;
}

function Home() {
  const [text, setText] = useState('');
  const [simulateFailures, setSimulateFailures] = useState(false);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [activeStatus, setActiveStatus] = useState<RunStatus | undefined>();
  const create = useCreateRun();
  const client = useQueryClient();
  const submit = (inputText: string) => {
    if (!inputText.trim() || create.isPending || activeStatus === 'pending' || activeStatus === 'running') return;
    create.mutate({ data: { input_text: inputText, simulate_failures: simulateFailures } }, {
      onSuccess: (run) => {
        setText(inputText);
        setActiveRun(run.id);
        setActiveStatus(run.status);
        client.invalidateQueries({ queryKey: getListRunsQueryKey() });
      },
    });
  };
  return <main className="main-wrap">
    <div className="intro-row">
      <div><div className="eyebrow">Notes in. Next steps out.</div><h1 className="page-title">Make the meeting<br />mean something.</h1><p className="lede">Drop in the rough notes. Get a clear, reviewable list of who owns what — with every step of the extraction left in the open.</p></div>
      <div className="intro-aside">SAVED RUNS <span style={{ color: '#b28a4b' }}> / </span> TRACEABLE BY DESIGN</div>
    </div>
    <form className="panel composer" onSubmit={(event) => { event.preventDefault(); submit(text); }}>
      <div className="panel-heading"><div><div className="small-label">Start with the raw version</div><h2 className="section-title" style={{ marginTop: 5 }}>Meeting notes</h2></div><span className="subtle">{text.length} characters</span></div>
      <label htmlFor="meeting-notes" className="sr-only">Paste untidy meeting notes</label>
      <textarea id="meeting-notes" className="notes-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={'Paste your meeting notes here…\n\n“Need to get the launch brief over to Mira by Thursday. I’ll check with finance about the revised numbers. Maybe regroup next week once the vendor sends the updated timeline.”'} data-testid="input-meeting-notes" />
      <p className="sharing-note">Your run history is private to your account. Notes are sent to the AI service to extract action items.</p>
      <div className="form-footer">
        <label className="checkline"><input type="checkbox" checked={simulateFailures} onChange={(event) => setSimulateFailures(event.target.checked)} data-testid="checkbox-simulate-failures" /> Simulate a transient failure <span className="subtle">(demo mode)</span></label>
        <button className="button-primary" type="submit" disabled={!text.trim() || create.isPending || activeStatus === 'running' || activeStatus === 'pending'} data-testid="button-extract">
          {create.isPending ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />} {create.isPending ? 'Starting…' : 'Extract action items'} <ArrowRight size={14} />
        </button>
      </div>
    </form>
    {create.isError && <div className="error-card" role="alert"><div className="error-title"><AlertCircle size={16} />Could not start extraction</div><div className="error-message">Your notes are still here. Try again in a moment.</div></div>}
    {activeRun ? <div style={{ marginTop: 20 }}><RunPanel runId={activeRun} retry={submit} currentInput={setText} onStatusChange={setActiveStatus} /></div> :
      <div className="content-grid">
        <Diagram events={[]} status="pending" />
        <section className="panel" style={{ padding: 20 }}>
          <div className="small-label">What happens next</div><h2 className="section-title" style={{ margin: '6px 0 14px' }}>Clarity, not magic.</h2>
          <div className="pending-box">Each stage is saved as an event. You can inspect the order, duration, retries, and result — then replay the trace at your own pace.</div>
          <Link href="/runs" className="button-quiet" style={{ marginTop: 12, textDecoration: 'none' }} data-testid="link-view-history"><History size={14} /> Browse past runs</Link>
        </section>
      </div>}
    {!activeRun && <section className="panel tasks-panel" style={{ marginTop: 18 }}>
      <div className="panel-heading"><div><div className="small-label">Your follow-through</div><h2 className="section-title" style={{ marginTop: 5 }}>Action items</h2></div><span className="task-count">0 tasks</span></div>
      <div className="empty-tasks">Your extracted tasks will land here, with an owner, due date, and priority attached where the notes make them clear.</div>
    </section>}
  </main>;
}

function RunsPage() {
  type HistoryFilters = { search: string; from: string; to: string; status: RunStatus | '' };
  const emptyFilters: HistoryFilters = { search: '', from: '', to: '', status: '' };
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState<HistoryFilters>(emptyFilters);
  const hasFilters = Object.values(appliedFilters).some(Boolean);
  const runs = useInfiniteQuery({
    queryKey: [...getListRunsQueryKey(), 'infinite', { limit: 20, ...appliedFilters }],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => listRuns({
      limit: 20,
      ...(pageParam ? { cursor: pageParam } : {}),
      ...(appliedFilters.search ? { search: appliedFilters.search } : {}),
      ...(appliedFilters.from ? { from: appliedFilters.from } : {}),
      ...(appliedFilters.to ? { to: appliedFilters.to } : {}),
      ...(appliedFilters.status ? { status: appliedFilters.status } : {}),
    }, { signal }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedFilters({ ...draftFilters, search: draftFilters.search.trim() });
  };
  const clearFilters = () => {
    setDraftFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
  };
  return <main className="main-wrap">
    <div className="intro-row">
      <div><div className="eyebrow">Your private record</div><h1 className="page-title">Run history</h1><p className="lede">Your extractions, preserved with their status and task count. Only you can access these runs.</p></div>
      <Link href="/" className="button-primary" style={{ textDecoration: 'none' }} data-testid="link-create-extraction"><Sparkles size={15} /> New extraction</Link>
    </div>
    <form className="history-filters panel" onSubmit={applyFilters} aria-label="Filter run history">
      <label className="history-search-field">
        <span>Search notes</span>
        <input
          type="search"
          value={draftFilters.search}
          maxLength={200}
          placeholder="Find words from a meeting"
          onChange={(event) => setDraftFilters((current) => ({ ...current, search: event.target.value }))}
          data-testid="input-history-search"
        />
      </label>
      <label>
        <span>Started from</span>
        <input type="date" value={draftFilters.from} onChange={(event) => setDraftFilters((current) => ({ ...current, from: event.target.value }))} data-testid="input-history-from" />
      </label>
      <label>
        <span>Started through</span>
        <input type="date" value={draftFilters.to} onChange={(event) => setDraftFilters((current) => ({ ...current, to: event.target.value }))} data-testid="input-history-to" />
      </label>
      <label>
        <span>Status</span>
        <select value={draftFilters.status} onChange={(event) => setDraftFilters((current) => ({ ...current, status: event.target.value as RunStatus | '' }))} data-testid="select-history-status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
        </select>
      </label>
      <div className="history-filter-actions">
        <button type="submit" className="button-primary" data-testid="button-apply-history-filters">Apply filters</button>
        <button type="button" className="button-secondary" onClick={clearFilters} disabled={!hasFilters && !Object.values(draftFilters).some(Boolean)} data-testid="button-clear-history-filters">Clear</button>
      </div>
    </form>
    {runs.isPending ? <div className="panel task-skeleton" role="status" aria-label="Loading run history"><div className="loading-line" /><div className="loading-line" /><div className="loading-line" /></div> :
      !runs.data && runs.isError ? <div className="error-card" role="alert"><div className="error-title"><AlertCircle size={16} />History could not load</div><button type="button" className="button-secondary" onClick={() => runs.refetch()} data-testid="button-retry-history"><RotateCcw size={14} /> Try again</button></div> :
        items.length ? <section className="panel run-list" aria-label="Past extraction runs" aria-busy={runs.isFetching}>
          <div className="list-header"><span>Note preview</span><span>Status</span><span>Tasks</span><span>Started</span></div>
          {items.map((run) => <Link href={`/runs/${run.id}`} className="run-row" key={run.id} data-testid={`link-run-${run.id}`}>
            <span className="run-preview">{run.input_preview.replace(/\s+/g, ' ').trim() || 'Untitled notes'}</span>
            <StatusPill status={run.status} />
            <span className="run-count">{run.task_count} {run.task_count === 1 ? 'task' : 'tasks'}</span>
            <span className="run-date">{formatDate(run.started_at)}</span>
          </Link>)}
        </section> : hasFilters ? <section className="panel history-empty"><History size={20} color="#8d9b8f" /><strong>No matching runs</strong><span className="subtle">Try changing or clearing your filters.</span><div><button type="button" className="button-secondary" onClick={clearFilters} style={{ marginTop: 16 }} data-testid="button-clear-empty-history">Clear filters</button></div></section> :
          <section className="panel history-empty"><History size={20} color="#8d9b8f" /><strong>No runs yet</strong><span className="subtle">Your first extraction will be saved here.</span><div><Link href="/" className="button-secondary" style={{ textDecoration: 'none', marginTop: 16 }} data-testid="link-first-run"><Sparkles size={14} /> Start an extraction</Link></div></section>}
    {runs.isFetchNextPageError && <div className="error-card" role="alert" style={{ marginTop: 16 }}>More runs could not load. Your loaded runs are still here. Try again below.</div>}
    {runs.isRefetchError && !runs.isFetchNextPageError && runs.data && <div className="error-card" role="alert" style={{ marginTop: 16 }}>
      History could not refresh. Showing previously loaded runs.{' '}
      <button type="button" className="button-secondary" onClick={() => runs.refetch()} disabled={runs.isFetching}>Retry refresh</button>
    </div>}
    {items.length > 0 && <div className="history-pagination">
      <span className="subtle" role="status" data-testid="history-page-status">{items.length} runs loaded{!runs.hasNextPage ? ' · All runs loaded' : ''}</span>
      {runs.hasNextPage && <button type="button" className="button-secondary" onClick={() => runs.fetchNextPage()} disabled={runs.isFetching} data-testid="button-load-more">
        {runs.isFetchingNextPage ? <LoaderCircle size={14} className="spin" /> : <History size={14} />}
        {runs.isFetchingNextPage ? 'Loading more…' : runs.isFetchNextPageError ? 'Try again' : 'Load more'}
      </button>}
    </div>}
  </main>;
}

function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const create = useCreateRun();
  const [preservedInput, setPreservedInput] = useState('');
  const client = useQueryClient();
  const retry = (inputText: string) => {
    setPreservedInput(inputText);
    create.mutate({ data: { input_text: inputText, simulate_failures: false } }, {
      onSuccess: (run) => {
        client.invalidateQueries({ queryKey: getListRunsQueryKey() });
        setLocation(`/runs/${run.id}`);
      },
    });
  };
  const displayText = preservedInput;
  return <main className="main-wrap">
    <div className="intro-row">
      <div><div className="eyebrow">Run detail <span style={{ color: '#b28a4b' }}>/</span> {params.id}</div><h1 className="page-title">The full trace.</h1><p className="lede">A replayable record of how these notes became action items.</p></div>
      <Link href="/runs" className="button-secondary" style={{ textDecoration: 'none' }} data-testid="link-back-history"><History size={14} /> All runs</Link>
    </div>
    {create.isPending && <div className="pending-box" style={{ marginBottom: 16 }}>Retry started. Opening the new run…</div>}
    {create.isError && <div className="error-card" role="alert"><div className="error-title"><AlertCircle size={16} />Retry could not start</div><div className="error-message">{displayText}</div></div>}
    <RunPanel runId={params.id} retry={retry} currentInput={setPreservedInput} />
  </main>;
}

function Router() {
  return <RoutedErrorBoundary><Shell><Switch>
    <Route path="/" component={Home} />
    <Route path="/runs" component={RunsPage} />
    <Route path="/runs/:id" component={RunDetailPage} />
    <Route component={NotFound} />
  </Switch></Shell></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
    <AuthProvider><Router /><Toaster /></AuthProvider>
  </WouterRouter></TooltipProvider>;
}

export default App;
