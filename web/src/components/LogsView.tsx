import type { ReplyLog } from '../api'
import { Card, Spinner } from './ui'

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`

function speedTone(ms: number) {
  if (ms < 500) return 'text-emerald-600'
  if (ms < 1000) return 'text-amber-600'
  return 'text-red-600'
}

export function LogsView({ logs }: { logs: ReplyLog[] }) {
  const ok = logs.filter((l) => l.ok)
  const verified = ok.filter((l) => l.race)
  const first = verified.filter((l) => l.race!.rank === 1).length
  const deltas = verified.map((l) => l.race!.ourDeltaMs).filter((v): v is number => v != null)
  const failed = logs.length - ok.length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Đã trả lời" value={String(ok.length)} />
        <Stat
          label="Trả lời đầu tiên"
          value={verified.length ? `${first}/${verified.length}` : '–'}
          tone={verified.length && first < verified.length ? 'text-amber-600' : 'text-emerald-600'}
          hint="Đếm theo dữ liệu thật từ server Zalo"
        />
        <Stat
          label="TB tốc độ (server Zalo)"
          value={deltas.length ? secs(deltas.reduce((a, b) => a + b, 0) / deltas.length) : '–'}
          hint="Từ lúc người kia gửi tới lúc tin của mình lên server, theo đồng hồ server Zalo"
        />
        <Stat label="Lỗi" value={String(failed)} tone={failed ? 'text-red-600' : undefined} />
      </div>

      <Card className="overflow-hidden">
        {logs.length === 0 ? (
          <p className="p-10 text-center text-sm text-slate-400">Chưa có tin nào. Nhật ký sẽ hiện ở đây theo thời gian thực.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-3 px-4 py-3 text-sm">
                <span className="w-16 shrink-0 font-mono text-xs leading-5 text-slate-400">{time(l.at)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    <span className="font-medium">{l.senderName}</span>
                    <span className="text-slate-400"> trong </span>
                    <span className="font-medium">{l.groupName}</span>
                  </p>
                  <p className="truncate text-slate-500">
                    {l.text} <span className="text-slate-300">→</span>{' '}
                    {l.ok ? <span className="text-slate-700">“{l.reply}”</span> : <span className="text-red-600">Lỗi: {l.error}</span>}
                  </p>
                  {l.ok && <RaceLine log={l} />}
                </div>
                {l.ok && l.race?.ourDeltaMs != null && (
                  <div className="shrink-0 text-right font-mono text-xs leading-5">
                    <p className={speedTone(l.race.ourDeltaMs)} title="Tốc độ theo đồng hồ server Zalo">
                      {secs(l.race.ourDeltaMs)}
                    </p>
                    <p className="text-slate-400" title="Thời gian gọi API gửi">gửi {l.processMs}ms</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function RaceLine({ log }: { log: ReplyLog }) {
  if (log.pending) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
        <Spinner className="size-3" /> Đang kiểm tra vị trí...
      </p>
    )
  }
  const r = log.race
  if (!r) return <p className="mt-1 text-xs text-slate-400">❔ Chưa xác minh được vị trí</p>
  if (r.rank === 1) {
    return (
      <p className="mt-1">
        <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">🥇 #1, trả lời đầu tiên</span>
      </p>
    )
  }
  return (
    <div className="mt-1 space-y-0.5">
      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
        ⚠️ #{r.rank}, {r.ahead.length} người nhắn trước mình
      </span>
      {r.ahead.slice(0, 5).map((a, i) => (
        <p key={i} className="truncate pl-1 text-xs text-slate-500">
          • {a.name} <span className="font-mono text-slate-400">(+{secs(a.deltaMs)})</span>: {a.text}
        </p>
      ))}
    </div>
  )
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500" title={hint}>{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </Card>
  )
}
