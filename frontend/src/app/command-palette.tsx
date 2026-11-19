import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { navItems } from './nav';
import { cn } from '@/lib/cn';
import { useInvalidateAll } from '@/lib/query';

interface Command {
  id: string;
  label: string;
  to?: string;
  run?: () => void;
  group: string;
}

/**
 * 命令面板（⌘/Ctrl+K）。
 *
 * 采用 APG 的 combobox + listbox 模式：输入框持有 `aria-activedescendant`，
 * 选项是 `role="option"` 的非聚焦元素，键盘与鼠标共用同一套选中状态。
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const invalidate = useInvalidateAll();

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = navItems.map((n) => ({
      id: `nav-${n.id}`,
      label: n.label,
      to: n.to,
      group: '前往',
    }));
    const subs: Command[] = navItems
      .flatMap((n) => n.children ?? [])
      .map((c) => ({ id: `nav-${c.to}`, label: `网关 · ${c.label}`, to: c.to, group: '前往' }));
    const actions: Command[] = [{ id: 'refresh', label: '刷新全部数据', group: '操作', run: invalidate }];
    return [...nav, ...subs, ...actions];
  }, [invalidate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q));
  }, [commands, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('panel:command', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('panel:command', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  function choose(cmd: Command | undefined) {
    if (!cmd) return;
    setOpen(false);
    if (cmd.run) cmd.run();
    else if (cmd.to) void navigate({ to: cmd.to });
  }

  const activeId = filtered[active] ? `palette-opt-${filtered[active].id}` : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg gap-2 p-3" hideClose>
        <DialogTitle className="sr-only">命令面板</DialogTitle>
        <Input
          autoFocus
          role="combobox"
          aria-expanded={open}
          aria-controls="palette-listbox"
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-label="搜索页面或操作"
          placeholder="搜索页面或操作…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(filtered[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'Tab') {
              setOpen(false);
            }
          }}
        />
        <div
          id="palette-listbox"
          role="listbox"
          aria-label="命令结果"
          className="max-h-72 overflow-auto"
        >
          {filtered.length === 0 ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Search className="size-4" /> 没有匹配项
            </div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.id}
                id={`palette-opt-${cmd.id}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(cmd)}
                className={cn(
                  'flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-left text-sm',
                  i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <span>{cmd.label}</span>
                <span className="text-[11px] text-muted-foreground">{cmd.group}</span>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}