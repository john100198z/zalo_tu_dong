import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type ChatMessage, type ChatThread } from '../api'
import { onChat } from '../useLive'
import { Avatar, Card, Spinner } from './ui'

type Filter = 'all' | 'group' | 'user'

// Link/ảnh đến từ tin nhắn người khác: chỉ cho http(s) để tránh javascript: và các scheme lạ.
const safeUrl = (u?: string) => (u && /^https?:\/\//i.test(u) ? u : undefined)

const hm = (ts: number) => new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
const day = (ts: number) => new Date(ts).toLocaleDateString('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })

function shortTime(ts: number) {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString() ? hm(ts) : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
}

export function MessagesView() {
  const [threads, setThreads] = useState<ChatThread[] | null>(null)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [unread, setUnread] = useState<Record<string, number>>({})
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId

  useEffect(() => {
    api.chats().then(setThreads, (err) => setError(err.message))
  }, [])

  // Tin mới: đẩy cuộc trò chuyện lên đầu, đếm chưa đọc (chỉ trên trang này, không báo "đã xem" cho Zalo).
  useEffect(
    () =>
      onChat((msgs) => {
        let unknown = false
        setThreads((prev) => {
          if (!prev) return prev
          const map = new Map(prev.map((t) => [t.threadId, t]))
          for (const m of msgs) {
            const t = map.get(m.threadId)
            if (!t) {
              unknown = true
              continue
            }
            if (m.ts < t.lastTs) continue
            map.set(m.threadId, { ...t, lastTs: m.ts, lastText: m.text, lastName: m.isSelf ? 'Bạn' : m.name, lastSelf: m.isSelf })
          }
          return [...map.values()].sort((a, b) => b.lastTs - a.lastTs)
        })
        if (unknown) api.chats().then(setThreads).catch(() => {})
        setUnread((prev) => {
          const next = { ...prev }
          for (const m of msgs) if (!m.isSelf && m.threadId !== activeRef.current) next[m.threadId] = (next[m.threadId] ?? 0) + 1
          return next
        })
      }),
    [],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (threads ?? []).filter(
      (t) => (filter === 'all' || (filter === 'group') === t.isGroup) && (!q || t.name.toLowerCase().includes(q)),
    )
  }, [threads, filter, query])

  const active = threads?.find((t) => t.threadId === activeId) ?? null

  function open(id: string) {
    setActiveId(id)
    setUnread((prev) => ({ ...prev, [id]: 0 }))
  }

  return (
    <Card className="flex min-h-80 flex-1 overflow-hidden">
      <aside className={`w-full flex-col border-slate-100 md:flex md:w-80 md:shrink-0 md:border-r ${active ? 'hidden' : 'flex'}`}>
        <div className="space-y-2 border-b border-slate-100 p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm cuộc trò chuyện..."
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
          />
          <div className="flex gap-1">
            {(
              [
                ['all', 'Tất cả'],
                ['group', 'Nhóm'],
                ['user', 'Cá nhân'],
              ] as const
            ).map(([f, label]) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  filter === f ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain">
          {error && <p className="p-4 text-sm text-red-600">{error}</p>}
          {!threads && !error && (
            <div className="flex justify-center p-8 text-slate-400">
              <Spinner />
            </div>
          )}
          {threads && visible.length === 0 && (
            <p className="p-6 text-center text-sm text-slate-400">
              {threads.length === 0 ? 'Chưa có tin nhắn nào. Tin mới sẽ hiện ở đây ngay khi có.' : 'Không tìm thấy'}
            </p>
          )}
          {visible.map((t) => (
            <button
              key={t.threadId}
              onClick={() => open(t.threadId)}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-slate-50 active:bg-slate-100 ${
                t.threadId === activeId ? 'bg-brand-50/70' : ''
              }`}
            >
              <Avatar src={safeUrl(t.avatar)} name={t.name} size="size-11" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={`truncate text-sm ${unread[t.threadId] ? 'font-semibold' : 'font-medium'}`}>
                    {t.isGroup && <span className="mr-1 text-slate-400">👥</span>}
                    {t.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-slate-400">{shortTime(t.lastTs)}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={`truncate text-xs ${unread[t.threadId] ? 'text-slate-800' : 'text-slate-500'}`}>
                    {(t.isGroup || t.lastSelf) && <span className="text-slate-400">{t.lastName}: </span>}
                    {t.lastText}
                  </span>
                  {!!unread[t.threadId] && (
                    <span className="ml-auto shrink-0 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">
                      {unread[t.threadId]}
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      {active ? (
        <Conversation key={active.threadId} thread={active} onBack={() => setActiveId(null)} />
      ) : (
        <div className="hidden flex-1 items-center justify-center p-8 text-center text-sm text-slate-400 md:flex">
          Chọn một cuộc trò chuyện để xem.
          <br />
          Trang này chỉ để xem, không gửi được tin nhắn.
        </div>
      )}
    </Card>
  )
}

function Conversation({ thread, onBack }: { thread: ChatThread; onBack: () => void }) {
  const [msgs, setMsgs] = useState<ChatMessage[] | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const keepOffset = useRef<number | null>(null)

  useEffect(() => {
    api.chatMessages(thread.threadId).then((list) => {
      setMsgs(list)
      setHasMore(list.length >= 50)
    }, () => setMsgs([]))
  }, [thread.threadId])

  useEffect(
    () =>
      onChat((incoming) => {
        const mine = incoming.filter((m) => m.threadId === thread.threadId)
        if (!mine.length) return
        setMsgs((prev) => {
          if (!prev) return prev
          const ids = new Set(prev.map((m) => m.msgId))
          return [...prev, ...mine.filter((m) => !ids.has(m.msgId))].sort((a, b) => a.ts - b.ts)
        })
      }),
    [thread.threadId],
  )

  // Giữ vị trí cuộn: đang ở cuối thì theo tin mới; tải tin cũ thì không bị nhảy.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (keepOffset.current != null) {
      el.scrollTop = el.scrollHeight - keepOffset.current
      keepOffset.current = null
    } else if (stickBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [msgs])

  async function loadOlder() {
    if (!msgs?.length) return
    setLoadingOlder(true)
    try {
      const older = await api.chatMessages(thread.threadId, msgs[0].ts)
      setHasMore(older.length >= 50)
      keepOffset.current = scroller.current ? scroller.current.scrollHeight - scroller.current.scrollTop : null
      setMsgs((prev) => [...older, ...(prev ?? [])])
    } finally {
      setLoadingOlder(false)
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5">
        <button onClick={onBack} className="-ml-1 rounded-lg p-2 text-slate-500 hover:bg-slate-100 md:hidden" aria-label="Quay lại">
          ←
        </button>
        <Avatar src={safeUrl(thread.avatar)} name={thread.name} size="size-9" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{thread.name}</p>
          <p className="text-xs text-slate-400">{thread.isGroup ? 'Nhóm' : 'Tin nhắn riêng'}</p>
        </div>
      </header>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="flex-1 space-y-1 overflow-y-auto overscroll-contain bg-slate-50 px-3 py-3"
      >
        {!msgs && (
          <div className="flex justify-center p-8 text-slate-400">
            <Spinner />
          </div>
        )}
        {msgs && hasMore && msgs.length > 0 && (
          <div className="flex justify-center pb-2">
            <button
              onClick={loadOlder}
              disabled={loadingOlder}
              className="rounded-full bg-white px-3 py-1 text-xs text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            >
              {loadingOlder ? 'Đang tải...' : 'Xem tin cũ hơn'}
            </button>
          </div>
        )}
        {msgs?.length === 0 && <p className="p-6 text-center text-sm text-slate-400">Chưa có tin nhắn đã lưu.</p>}
        {msgs?.map((m, i) => {
          const prev = msgs[i - 1]
          const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()
          const showName = thread.isGroup && !m.isSelf && (newDay || prev.uid !== m.uid)
          return (
            <div key={m.msgId}>
              {newDay && <p className="py-2 text-center text-[11px] text-slate-400">{day(m.ts)}</p>}
              <Bubble m={m} showName={showName} />
            </div>
          )
        })}
      </div>

      <footer className="border-t border-slate-100 px-3 py-2.5 text-center text-xs text-slate-400">
        🔒 Chỉ xem. Không gửi tin và không báo "đã xem" cho Zalo
      </footer>
    </section>
  )
}

function Bubble({ m, showName }: { m: ChatMessage; showName: boolean }) {
  const href = safeUrl(m.attach?.href)
  const thumb = safeUrl(m.attach?.thumb)
  const isLabel = m.text.startsWith('[') && m.text.endsWith(']')
  const showText = !(thumb && isLabel)

  return (
    <div className={`flex ${m.isSelf ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] sm:max-w-[70%] ${m.isSelf ? 'items-end' : 'items-start'} flex flex-col`}>
        {showName && <p className="mt-1.5 mb-0.5 px-1 text-[11px] font-medium text-slate-500">{m.name}</p>}
        <div
          className={`rounded-2xl px-3 py-2 text-sm shadow-sm ${
            m.isSelf ? 'rounded-br-md bg-brand-500 text-white' : 'rounded-bl-md bg-white text-slate-800 ring-1 ring-slate-100'
          }`}
        >
          {m.quote && (
            <div className={`mb-1.5 border-l-2 pl-2 text-xs ${m.isSelf ? 'border-white/60 text-white/80' : 'border-brand-500 text-slate-500'}`}>
              <p className="font-medium">{m.quote.name}</p>
              <p className="line-clamp-2">{m.quote.text}</p>
            </div>
          )}
          {thumb && (
            <a href={href ?? thumb} target="_blank" rel="noopener noreferrer" className="mb-1 block">
              <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-60 max-w-full rounded-lg object-cover" />
            </a>
          )}
          {showText &&
            (href && !thumb ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="break-words underline">
                {m.text}
              </a>
            ) : (
              <p className={`whitespace-pre-wrap break-words ${isLabel ? 'italic opacity-80' : ''}`}>{m.text}</p>
            ))}
          <p className={`mt-0.5 text-right text-[10px] ${m.isSelf ? 'text-white/70' : 'text-slate-400'}`}>{hm(m.ts)}</p>
        </div>
      </div>
    </div>
  )
}
