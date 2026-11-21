import { useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type Dispatch, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Bell, Check, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { api } from '../lib/api';
import { externalFiles } from '../lib/externalFiles';
import { listenForNotices, notifyError, type NoticeDetail } from '../lib/notify';
import type { Asset } from '../lib/types';
import { isVideoAsset } from '../lib/videoGeneration';
import { videoSourceKey } from '../lib/videoSourceKey';
import { useStore } from '../store';
import { useLocalChatStore } from '../lib/localChatStore';
import { useDescribeNotices, type DescribeNotice } from '../lib/describeNotices';
import { libraryGenerationTasks, type LibraryActivityTask } from '../lib/libraryGenerationActivity';
import { openLibraryActivityTask, useLibraryGenerationRuntime } from '../lib/libraryGenerationRuntime';
import { dismissNotices, readDismissedNotices, subscribeDismissedNotices } from '../lib/dismissedNotices';
import { LibraryVideoPreview } from './LibraryVideoPreview';
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

type BellTask = LibraryActivityTask | DescribeNotice;

const BELL_SCOPE = 'notification-bell';
const getDismissed = () => readDismissedNotices(BELL_SCOPE);

function TaskRow({ task, projectName, onOpen, onRemove }: { task: BellTask; projectName?: string; onOpen: () => void; onRemove: (keys: string[]) => void }) {
  const Icon = task.status === 'running' ? LoaderCircle : task.status === 'completed' ? Check : CircleAlert;
  const kind = { describe: '反推', generation: '生成', extra: '视频生成', agent: 'Agent', chat: '对话' }[task.source];
  const context = projectName ? `${kind} · ${projectName}` : kind;
  const destination = task.source === 'describe' ? '查看素材' : '查看画板';
  return <div role="listitem"><button type="button" className={`notification-bell-task is-${task.status}`}
    onClick={onOpen} aria-label={`${context} · ${task.title} · ${task.statusLabel}，${destination}`}>
    <Icon size={14} aria-hidden/><span className="notification-bell-copy"><span>{task.title}</span><small>{context}</small></span>
    <span className="notification-bell-status">{task.statusLabel}</span><ArrowUpRight size={13} aria-hidden/>
  </button>{task.dismissKey && <button type="button" className="notification-bell-remove" aria-label={`移除通知：${task.title}`} title="移除此条通知"
    onClick={() => onRemove([task.dismissKey!])}><X size={14} aria-hidden/></button>}</div>;
}

function useRecentTasks() {
  const projects = useStore(value => value.projects);
  const jobs = useStore(value => value.genJobs), runs = useStore(value => value.cloudAgentRuns);
  const unreadThreads = useStore(value => value.projectUnreadThreads);
  const chats = useLocalChatStore(value => value.summaries);
  const videos = useLibraryGenerationRuntime(value => value.tasks);
  const descriptions = useDescribeNotices(value => value.tasks);
  const dismissed = useSyncExternalStore(subscribeDismissedNotices, getDismissed);
  const projectTasks = libraryGenerationTasks({ projects, jobs: Object.values(jobs), runs: Object.values(runs), chats: Object.values(chats), extraTasks: Object.values(videos), limit: Infinity });
  const tasks = [...projectTasks, ...descriptions]
    .filter(task => !task.dismissKey || !dismissed.has(task.dismissKey))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return { projects, tasks: tasks.slice(0, 20), clearable: tasks.flatMap(task => task.dismissKey ? [task.dismissKey] : []),
    unread: tasks.some(task => task.source !== 'describe' && unreadThreads[task.projectId]?.includes(task.threadId)) };
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
      if (view === 'latest' && !panel.current?.contains(document.activeElement)) return;
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
function TaskHistory({ recent, dismiss, onOpenTask }: { recent: RecentTasks; dismiss: () => void; onOpenTask: (task: BellTask) => void }) {
  const content = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  function remove(keys: string[]) {
    closeButton.current?.focus();
    dismissNotices(BELL_SCOPE, keys);
  }
  useEffect(() => {
    const first = content.current!.querySelector<HTMLButtonElement>('.notification-bell-task') ?? content.current!.querySelector<HTMLButtonElement>('button');
    first!.focus();
  }, []);
  return <div ref={content}>
    <div className="notification-bell-heading"><span>通知</span>{recent.clearable.length > 0 &&
      <button type="button" className="notification-bell-clear" onClick={() => remove(recent.clearable)}>清除已结束</button>}
      <button ref={closeButton} type="button" aria-label="关闭通知面板" onClick={dismiss}><X size={14}/></button></div>
    <div className="notification-bell-history" role="list" aria-label="近期任务">
      {!recent.tasks.length && <p>暂无任务</p>}
      {recent.tasks.map(task => <TaskRow key={`${task.source}:${task.id}`} task={task} projectName={task.source === 'describe' ? undefined : recent.projects.find(project => project.id === task.projectId)?.name} onOpen={() => onOpenTask(task)} onRemove={remove}/>)}
    </div>
  </div>;
}

export function NotificationBell() {
  const [state, dispatch] = useReducer(bellState, { view: 'closed', latest: null, pinned: false, unread: false });
  const [preview, setPreview] = useState<{ asset: Asset; path: string; projectId: string | null; routeRevision: number }>();
  const projectRouteRevision = useStore(value => value.projectRouteRevision);
  const openRequest = useRef(0);
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const recent = useRecentTasks();
  const unread = state.unread || recent.unread;
  const position = useBellPosition(state.view, button);
  useBellNotices(state, dispatch);
  useBellDismiss(state.view, button, panel, dispatch);
  const close = () => dispatch({ type: 'close' });
  const dismiss = () => { close(); button.current?.focus({ preventScroll: true }); };
  const interact = () => dispatch({ type: 'interact' });
  async function openTask(task: BellTask) {
    dismiss();
    const intent = ++openRequest.current;
    const origin = useStore.getState();
    if (task.source === 'generation') { origin.openGenerationJob(task.id); return; }
    if (task.source === 'agent') { origin.openCloudAgentRun(origin.cloudAgentRuns[task.id]); return; }
    if (task.source !== 'describe') { openLibraryActivityTask(task); return; }
    const isCurrent = () => button.current?.isConnected && intent === openRequest.current && useStore.getState().projectRouteRevision === origin.projectRouteRevision;
    try {
      const asset = origin.assets.find(item => item.id === task.assetId) ?? (await api.getAssetsByIds([task.assetId]))[0];
      if (!isCurrent()) return;
      if (!asset) throw new Error('素材已不存在，请检查素材库');
      if (isVideoAsset(asset)) {
        if (!asset.store_path) throw new Error('素材原文件不可用');
        const path = await externalFiles.media(asset.store_path);
        if (isCurrent()) setPreview({ asset, path, projectId: origin.activeProjectId, routeRevision: origin.projectRouteRevision });
      } else {
        if (useStore.getState().mode === 'manage') origin.exitManage();
        origin.openDetail(asset.id);
      }
    } catch (error) {
      if (isCurrent()) notifyError(error, '暂时无法打开素材，请在素材库中查看');
    }
  }
  return <>
    <button ref={button} type="button" className="notification-bell-button" aria-label={`通知${unread ? '，有未读消息' : ''}`}
      title="通知" aria-haspopup="dialog" aria-expanded={state.view !== 'closed'}
      onClick={() => dispatch({ type: state.view === 'history' ? 'close' : 'history' })}>
      <Bell size={17} strokeWidth={1.6} aria-hidden/>{unread && <i aria-hidden/>}
    </button>
    {state.view !== 'closed' && createPortal(<div key={state.view === 'latest' ? state.latest?.id : state.view} ref={panel} className={`notification-bell-panel is-${state.view}`} role={state.view === "latest" ? "status" : "dialog"}
      aria-label={{ latest: '新通知', history: '通知历史' }[state.view]} style={{ position: 'fixed', ...position }}
      onMouseEnter={interact} onFocusCapture={interact} onPointerDownCapture={interact}>
      {state.view === 'latest' && state.latest ? <LatestNotice notice={state.latest} close={close} dismiss={dismiss}/>
        : <TaskHistory recent={recent} dismiss={dismiss} onOpenTask={task => void openTask(task)}/>}
    </div>, document.body)}
    {preview?.routeRevision === projectRouteRevision && <LibraryVideoPreview asset={preview.asset} path={preview.path}
      projectId={preview.projectId} sourceKey={videoSourceKey(preview.asset)} onClose={() => setPreview(undefined)}/>}
  </>;
}
