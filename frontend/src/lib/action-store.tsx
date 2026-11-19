import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from './api';
import { taskSchema, type ActionName, type Task } from './contract';
import { subscribeSse } from './events';

/**
 * 写操作任务中心。
 *
 * - 所有写操作经 `POST /api/actions` 提交，返回一个 Task。
 * - 任务进度由 `/api/actions/stream`（SSE）推送。
 * - 任务终态后统一失效只读查询，触发"操作后重新查询"。
 */

export interface RunActionInput {
  action: ActionName;
  providerIds?: string[];
  accountKey?: string;
  dryRun?: boolean;
}

interface ActionState {
  tasks: Task[];
  run: (input: RunActionInput) => Promise<Task>;
  /** 有写任务在跑的 provider id 集合（用于禁用按钮）。 */
  runningProviderIds: Set<string>;
  /** 是否有全局写任务在跑（all/none/sync/refresh 等）。 */
  activeGlobal: boolean;
  busy: boolean;
  lastError: string | null;
  dismiss: (actionId: string) => void;
}

const ActionContext = createContext<ActionState | null>(null);

const GLOBAL_ACTIONS: ActionName[] = ['EnableAll', 'DisableAll', 'Sync', 'RefreshModels', 'RefreshQuota'];

function isActive(t: Task): boolean {
  return t.status === 'queued' || t.status === 'running';
}

function parseTaskData(raw: string): Task | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = json as Record<string, unknown> | null;
  const candidate = obj?.task ?? (obj?.data as Record<string, unknown> | undefined)?.task ?? json;
  const parsed = taskSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function ActionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [byId, setById] = useState<Record<string, Task>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);

  const upsert = useCallback(
    (task: Task) => {
      setById((prev) => ({ ...prev, [task.actionId]: task }));
      setOrder((prev) => (prev.includes(task.actionId) ? prev : [...prev, task.actionId]));
      if (!isActive(task)) {
        // 写操作完成 → 让只读数据失效，重新查询真实状态。
        void qc.invalidateQueries({ queryKey: ['providers'] });
        void qc.invalidateQueries({ queryKey: ['accounts'] });
        void qc.invalidateQueries({ queryKey: ['quota'] });
        void qc.invalidateQueries({ queryKey: ['gateway'] });
      }
    },
    [qc],
  );

  useEffect(() => {
    return subscribeSse('/actions/stream', {
      onEvent: (e) => {
        if (!e.event.startsWith('task.')) return;
        const task = parseTaskData(e.data);
        if (task) upsert(task);
      },
    });
  }, [upsert]);

  const run = useCallback(
    async (input: RunActionInput) => {
      setLastError(null);
      try {
        const task = await apiPost('/actions', input, taskSchema);
        upsert(task);
        return task;
      } catch (err) {
        setLastError((err as Error).message);
        throw err;
      }
    },
    [upsert],
  );

  const tasks = useMemo(
    () => order.map((id) => byId[id]).filter((t): t is Task => Boolean(t)),
    [order, byId],
  );

  const runningProviderIds = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks) {
      if (isActive(t)) for (const p of t.providerIds) set.add(p);
    }
    return set;
  }, [tasks]);

  const activeGlobal = useMemo(
    () =>
      tasks.some(
        (t) => isActive(t) && (GLOBAL_ACTIONS.includes(t.action) || t.providerIds.length === 0),
      ),
    [tasks],
  );

  const busy = useMemo(() => tasks.some(isActive), [tasks]);

  const dismiss = useCallback((actionId: string) => {
    setOrder((prev) => prev.filter((id) => id !== actionId));
    setById((prev) => {
      const next = { ...prev };
      delete next[actionId];
      return next;
    });
  }, []);

  const value: ActionState = {
    tasks,
    run,
    runningProviderIds,
    activeGlobal,
    busy,
    lastError,
    dismiss,
  };

  return <ActionContext value={value}>{children}</ActionContext>;
}

export function useActions(): ActionState {
  const ctx = useContext(ActionContext);
  if (!ctx) throw new Error('useActions 必须在 ActionProvider 内使用');
  return ctx;
}
