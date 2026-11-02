import { useEffect, useLayoutEffect, useReducer, useRef, useState, type Dispatch, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Bell, Check, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { listenForNotices, type NoticeDetail } from '../lib/notify';
import { useStore } from '../store';
import { useLocalChatStore } from '../lib/localChatStore';
import { libraryGenerationTasks, type LibraryActivityTask } from '../lib/libraryGenerationActivity';
import { openLibraryActivityTask, useLibraryGenerationRuntime } from '../lib/libraryGenerationRuntime';
import './NotificationBell.css';

type GenerationNotice = NoticeDetail;
interface BellState { view: 'closed' | 'latest' | 'history'; latest: GenerationNotice | null; pinned: boolean; unread: boolean }
type Action = { type: 'receive'; notice: GenerationNotice } | { type: 'history' } | { type: 'close' } | { type: 'interact' };
function bellState(state: BellState, action: Action): BellState {
  if (action.type === 'close') return { ...state, view: 'closed', pinned: false };
  if (action.type === 'history') return { ...state, view: 'history', pinned: true, unread: false };
  if (action.type === 'interact') return state.view === 'closed' ? state : { ...state, pinned: true, unread: false };
  if (state.pinned) return { ...state, unread: true };
  return { view: 'latest', latest: action.notice, pinned: false, unread: true };
}

function openTask(task: LibraryActivityTask) {
  const state = useStore.getState();
  if (task.source === 'generation') state.openGenerationJob(task.id);
  else if (task.source === 'agent') state.openCloudAgentRun(state.cloudAgentRuns[task.id]);
  else openLibraryActivityTask(task);
}

function TaskRow({ task, projectName, onOpen }: { task: LibraryActivityTask; projectName: string; onOpen: () => void }) {
  const Icon = task.status === 'running' ? LoaderCircle : task.status === 'completed' ? Check : CircleAlert;
  return <div role="listitem"><button type="button" className={`notification-bell-task is-${task.status}`}
    onClick={() => { onOpen(); openTask(task); }} aria-label={`${projectName} · ${task.title} · ${task.statusLabel}，查看画板`}>
    <Icon size={14} aria-hidden/><span className="notification-bell-copy"><span>{task.title}</span><small>{projectName}</small></span>
    <span className="notification-bell-status">{task.statusLabel}</span><ArrowUpRight size={13} aria-hidden/>
  </button></div>;
}

function useRecentTasks() {
  const projects = useStore(value => value.projects);
  const jobs = useStore(value => value.genJobs), runs = useStore(value => value.cloudAgentRuns);
  const unreadThreads = useStore(value => value.projectUnreadThreads);
  const chats = useLocalChatStore(value => value.summaries);
  const videos = useLibraryGenerationRuntime(value => value.tasks);
  const tasks = libraryGenerationTasks({ projects, jobs: Object.values(jobs), runs: Object.values(runs), chats: Object.values(chats), extraTasks: Object.values(videos) });
  return { projects, tasks, unread: tasks.some(task => unreadThreads[task.projectId]?.includes(task.threadId)) };
}

function useBellNotices(state: BellState, dispatch: Dispatch<Action>) {
  useEffect(() => listenForNotices(notice => {
    if ((notice as GenerationNotice).channel === 'generation') dispatch({ type: 'receive', notice });
  }), []);
  useEffect(() => {
    if (state.view !== 'latest' || state.pinned) return;
    const timer = window.setTimeout(() => dispatch({ type: 'close' }), 4000);
    return () => window.clearTimeout(timer);
  }, [state.view, state.pinned, state.latest?.id]);
}

function useBellPosition(view: BellState['view'], button: RefObject<HTMLButtonElement>) {
  const [position, setPosition] = useState({ top: 0, left: 0, width: 320 });
  useLayoutEffect(() => {
    if (view === 'closed') return;
    const place = () => {
      const rect = button.current!.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);
      setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), width });
    };
    place(); window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [view]);
  return position;
}

function useBellDismiss(view: BellState['view'], button: RefObject<HTMLButtonElement>, panel: RefObject<HTMLDivElement>, dispatch: Dispatch<Action>) {
  useEffect(() => {
    if (view === 'closed') return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!button.current?.contains(target) && !panel.current?.contains(target)) dispatch({ type: 'close' });
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); dispatch({ type: 'close' }); button.current?.focus();
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [view]);
}

function LatestNotice({ notice, close, dismiss }: { notice: GenerationNotice; close: () => void; dismiss: () => void }) {
  const open = () => { close(); notice.action?.onClick(); };
  return <div className="notification-bell-latest" role="listitem">
    <div role="status"><Check size={15} aria-hidden/>{notice.action ? <button type="button" aria-label={`${notice.message}，${notice.action.label}`} onClick={open}>
      <span>{notice.message}</span><ArrowUpRight size={14} aria-hidden/>
    </button> : <span>{notice.message}</span>}</div>
    <button className="notification-bell-close" type="button" aria-label="关闭通知面板" onClick={dismiss}><X size={14}/></button>
  </div>;
}

type RecentTasks = ReturnType<typeof useRecentTasks>;
function TaskHistory({ recent, close, dismiss }: { recent: RecentTasks; close: () => void; dismiss: () => void }) {
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = content.current!.querySelector<HTMLButtonElement>('.notification-bell-task') ?? content.current!.querySelector<HTMLButtonElement>('button');
    first!.focus();
  }, []);
  return <div ref={content}>
    <div className="notification-bell-heading"><span>通知</span><button type="button" aria-label="关闭通知面板" onClick={dismiss}><X size={14}/></button></div>
    <div className="notification-bell-history" role="list" aria-label="近期任务">
      {!recent.tasks.length && <p>暂无任务</p>}
      {recent.tasks.map(task => <TaskRow key={`${task.source}:${task.id}`} task={task} projectName={recent.projects.find(project => project.id === task.projectId)?.name ?? '项目'} onOpen={close}/>)}
    </div>
  </div>;
}

function BellContents({ state, recent, close, dismiss }: { state: BellState; recent: RecentTasks; close: () => void; dismiss: () => void }) {
  return state.view === 'latest' && state.latest ? <LatestNotice notice={state.latest} close={close} dismiss={dismiss}/> : <TaskHistory recent={recent} close={close} dismiss={dismiss}/>;
}

export function NotificationBell() {
  const [state, dispatch] = useReducer(bellState, { view: 'closed', latest: null, pinned: false, unread: false });
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const recent = useRecentTasks();
  const unread = state.unread || recent.unread;
  const position = useBellPosition(state.view, button);
  useBellNotices(state, dispatch);
  useBellDismiss(state.view, button, panel, dispatch);
  const close = () => dispatch({ type: 'close' });
  const dismiss = () => { close(); button.current!.focus(); };
  const interact = () => dispatch({ type: 'interact' });
  return <>
    <button ref={button} type="button" className="notification-bell-button" aria-label={`通知${unread ? '，有未读消息' : ''}`}
      title="通知" aria-haspopup="dialog" aria-expanded={state.view !== 'closed'}
      onClick={() => dispatch({ type: state.view === 'history' ? 'close' : 'history' })}>
      <Bell size={17} strokeWidth={1.6} aria-hidden/>{unread && <i aria-hidden/>}
    </button>
    {state.view !== 'closed' && createPortal(<div ref={panel} className={`notification-bell-panel is-${state.view}`} role="dialog"
      aria-label={{ latest: '新通知', history: '通知历史' }[state.view]} style={{ position: 'fixed', ...position }}
      onMouseEnter={interact} onFocusCapture={interact} onPointerDownCapture={interact}>
      <BellContents state={state} recent={recent} close={close} dismiss={dismiss}/>
    </div>, document.body)}
  </>;
}
