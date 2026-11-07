import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { api } from './api'
import { useLive } from './useLive'
import { LoginPage } from './components/LoginPage'
import { MessagesView } from './components/MessagesView'
import { Spinner } from './components/ui'

/**
 * Trang xem tin nhắn ĐỘC LẬP, chỉ mở bằng cách gõ thẳng domain/message.
 * Không có nút/đường dẫn nào từ giao diện quản trị trỏ sang đây.
 */
function MessageApp() {
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
  return <MessageShell onLoggedOut={() => setAuthed(false)} />
}

function MessageShell({ onLoggedOut }: { onLoggedOut: () => void }) {
  // Mở WebSocket để nhận tin nhắn realtime (và tự đăng xuất nếu phiên hết hạn).
  useLive(onLoggedOut)

  return (
    <div className="flex h-dvh flex-col bg-slate-50">
      <header className="shrink-0 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
          <img src="/favicon.svg" alt="" className="size-7" />
          <h1 className="font-semibold">Tin nhắn Zalo</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Chỉ xem</span>
        </div>
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col px-3 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-6">
        <MessagesView />
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MessageApp />
  </StrictMode>,
)
