import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { useLive } from './useLive'
import { LoginPage } from './components/LoginPage'
import { ZaloConnect } from './components/ZaloConnect'
import { GroupsView } from './components/GroupsView'
import { LogsView } from './components/LogsView'
import { SettingsView } from './components/SettingsView'
import { Avatar, Spinner } from './components/ui'

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    api.me().then((r) => setAuthed(r.authed), () => setAuthed(false))
  }, [])

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-slate-400">
        <Spinner className="size-8" />
      </div>
    )
  }
  if (!authed) return <LoginPage onSuccess={() => setAuthed(true)} />
  return <Dashboard onLoggedOut={() => setAuthed(false)} />
}

type Tab = 'groups' | 'logs' | 'settings'

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const { status, hasSavedSession, setHasSavedSession, logs, online } = useLive(onLoggedOut)
  const [tab, setTab] = useState<Tab>('groups')
  const [meta, setMeta] = useState({ maxListenUsers: 2, defaultReply: 'em' })
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {})
  }, [])

  const logoutPanel = useCallback(async () => {
    await api.logout().catch(() => {})
    onLoggedOut()
  }, [onLoggedOut])

  async function logoutZalo() {
    setMenuOpen(false)
    if (!confirm('Đăng xuất tài khoản Zalo? Bot sẽ ngừng trả lời cho tới khi bạn quét QR lại.')) return
    await api.zaloLogout()
    setHasSavedSession(false)
  }

  const connected = status?.state === 'connected'

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <img src="/favicon.svg" alt="" className="size-8" />
          <h1 className="font-semibold">Zalo Auto Reply</h1>
          <StatusPill state={status?.state} online={online} />
          <div className="flex-1" />
          <div className="relative">
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full p-1 pr-3 hover:bg-slate-100"
            >
              {connected ? (
                <>
                  <Avatar src={status.avatar} name={status.name} size="size-8" />
                  <span className="hidden max-w-40 truncate text-sm font-medium sm:block">{status.name}</span>
                </>
              ) : (
                <span className="px-2 text-sm text-slate-600">Tài khoản</span>
              )}
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                  {connected && (
                    <button onClick={logoutZalo} className="block w-full px-4 py-2 text-left text-sm hover:bg-slate-50">
                      Đăng xuất Zalo
                    </button>
                  )}
                  <button onClick={logoutPanel} className="block w-full px-4 py-2 text-left text-sm hover:bg-slate-50">
                    Thoát trang quản trị
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
          <nav className="mx-auto flex max-w-4xl gap-1 px-4">
            {(
              [
                ['groups', 'Nhóm'],
                ['logs', 'Nhật ký'],
                ['settings', 'Cài đặt'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition ${
                  tab === key ? 'border-brand-500 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                {label}
                {key === 'logs' && logs.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{logs.length}</span>
                )}
              </button>
            ))}
          </nav>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-6">
        {tab === 'settings' ? (
          <SettingsView />
        ) : !connected ? (
          <ZaloConnect status={status} hasSavedSession={hasSavedSession} />
        ) : tab === 'groups' ? (
          <GroupsView meta={meta} />
        ) : (
          <LogsView logs={logs} />
        )}
      </main>
    </div>
  )
}

function StatusPill({ state, online }: { state?: string; online: boolean }) {
  const [label, dot] = !online
    ? ['Mất kết nối server', 'bg-red-500']
    : state === 'connected'
      ? ['Đang hoạt động', 'bg-emerald-500']
      : state === 'connecting'
        ? ['Đang kết nối', 'bg-amber-500 animate-pulse']
        : ['Chưa kết nối Zalo', 'bg-slate-400']
  return (
    <span className="hidden items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline-flex">
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  )
}
