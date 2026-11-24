import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { DataState } from '@/components/shared/states';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useGatewayLocalAnswers } from '@/lib/query';
import { DASH } from '@/lib/format';
import { CliCommand, GatewayUnreachable, InfoNote, isUnreachable } from './gateway-shared';

interface AnswerSpec {
  key: string;
  label: string;
  trigger: string;
  answer: string;
}

/** 五个固定问题类别（gateway/local-answer.mjs），顺序固定。 */
const SPECS: AnswerSpec[] = [
  { key: 'quota', label: '额度检查', trigger: 'max_tokens:1 且内容含 "quota"', answer: 'Quota check passed.' },
  { key: 'prefix', label: '命令前缀', trigger: '<policy_spec> + Command:', answer: '命令前缀（如 git commit）' },
  { key: 'title', label: '会话标题', trigger: 'system 里要标题，且不带工具', answer: 'Conversation' },
  { key: 'suggestion', label: '补全建议', trigger: '任何 user 消息含 [SUGGESTION MODE:', answer: '空字符串' },
  { key: 'filepath', label: '文件路径', trigger: 'Command:/Output: 在问路径，且不带工具', answer: '<filepaths>…</filepaths>' },
];

function SwitchCell({ value }: { value: boolean | undefined }) {
  if (value === undefined) {
    return <span className="text-muted-foreground">{DASH}</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Switch checked={value} disabled aria-label={value ? '已开启（只读）' : '已关闭（只读）'} />
      <Badge variant={value ? 'success' : 'muted'}>{value ? '开启' : '关闭'}</Badge>
    </span>
  );
}

/** 本地应答：进程内直接回答 Claude Code 固定问题以省额度。只读展示开关。 */
export function LocalAnswersPage() {
  const res = useGatewayLocalAnswers();

  if (isUnreachable(res.error)) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="本地应答" description="进程内直接回答固定问题，省下游订阅额度。" />
        <GatewayUnreachable message={res.error?.message} onRetry={res.refetch} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="本地应答"
        description="Claude Code 每轮都会发的固定问题，答案本就写在请求体里；网关在进程内直接答，省一次往返与一份额度。"
      />

      <InfoNote tone="info">
        响应头 <CliCommand>x-router-local-answer: &lt;项&gt;</CliCommand> 标明本次是<strong>本地答的</strong>，排查时一眼能看出来。
        本地应答仍然要做认证——本地问题不会变成免密钥的口子。
      </InfoNote>

      <DataState res={res} loadingLabel="正在读取本地应答开关…" onRetry={res.refetch}>
        {(switches) => {
          const known = new Set(SPECS.map((s) => s.key));
          const extraKeys = Object.keys(switches).filter((k) => !known.has(k));
          const allKeys = [...SPECS.map((s) => s.key), ...extraKeys];
          const on = allKeys.filter((k) => switches[k] === true).length;
          const off = allKeys.filter((k) => switches[k] === false).length;
          const unknown = allKeys.length - on - off;
          return (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>共 {allKeys.length} 项</span>
                <span aria-hidden>·</span>
                <span className="text-success">开启 {on}</span>
                <span aria-hidden>·</span>
                <span>关闭 {off}</span>
                {unknown > 0 ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>未知 {unknown}</span>
                  </>
                ) : null}
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>类别</TableHead>
                      <TableHead>状态（只读）</TableHead>
                      <TableHead>触发条件</TableHead>
                      <TableHead>应答</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {SPECS.map((s) => (
                      <TableRow key={s.key}>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{s.label}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">{s.key}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <SwitchCell value={switches[s.key]} />
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{s.trigger}</TableCell>
                        <TableCell className="font-mono text-xs">{s.answer}</TableCell>
                      </TableRow>
                    ))}
                    {extraKeys.map((k) => (
                      <TableRow key={k}>
                        <TableCell className="font-mono text-xs">{k}</TableCell>
                        <TableCell>
                          <SwitchCell value={switches[k]} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{DASH}</TableCell>
                        <TableCell className="text-muted-foreground">{DASH}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <InfoNote>
                五个类别默认全部开启，可分别关闭。本页<strong>只读</strong>；开关请在终端执行：
                <CliCommand className="ml-1">node router.mjs gateway local</CliCommand>
                （查看状态）、
                <CliCommand className="ml-1">node router.mjs gateway local off title</CliCommand>
                （关某项）、
                <CliCommand className="ml-1">node router.mjs gateway local off</CliCommand>（全关）。
              </InfoNote>
            </div>
          );
        }}
      </DataState>
    </div>
  );
}
