import { useEffect, useState, type ReactNode } from 'react'
import { api, type ReplyMode, type TelegramChat, type TelegramSettings } from '../api'
import { Badge, Button, Card, Spinner, Toggle } from './ui'

export function SettingsView({ replyMode, onReplyMode }: { replyMode: ReplyMode | null; onReplyMode: (m: ReplyMode) => void }) {
  const [tg, setTg] = useState<TelegramSettings | null>(null)
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [chats, setChats] = useState<TelegramChat[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    api.telegram().then((s) => {
      setTg(s)
      setChatId(s.chatId)
    })
  }, [])

  async function act(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key)
    setMessage(null)
    try {
      await fn()
      if (success) setMessage({ ok: true, text: success })
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const save = (patch: Partial<TelegramSettings> & { token?: string }, success?: string) =>
    act('save', async () => setTg(await api.saveTelegram(patch)), success)

  if (!tg) {
    return (
      <div className="flex justify-center py-16 text-slate-400">
        <Spinner className="size-8" />
      </div>
    )
  }

  const ready = tg.hasToken && !!tg.chatId

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500 text-xl text-white">1×</div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Trả lời 1 lần rồi dừng</h2>
              {replyMode?.oneShot ? <Badge tone="green">Đang bật</Badge> : <Badge>Đang tắt</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Sau khi tự động trả lời ở <b>một</b> nhóm bất kỳ, bot dừng lắng nghe <b>tất cả</b> nhóm, để không trả lời 2 nhóm
              khác nhau trong thời gian ngắn. Bấm <b>Tiếp tục lắng nghe</b> để bật lại.
            </p>
          </div>
          <Toggle
            checked={!!replyMode?.oneShot}
            disabled={!replyMode || busy !== null}
            onChange={(oneShot) => act('mode', async () => onReplyMode(await api.saveReplyMode({ oneShot })))}
            label="Trả lời 1 lần rồi dừng"
          />
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-start gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-xl text-white">✈</div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Thông báo qua Telegram</h2>
              {tg.enabled && ready ? <Badge tone="green">Đang bật</Badge> : <Badge>Đang tắt</Badge>}
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Mỗi khi bot tự động trả lời trong nhóm Zalo, một tin báo sẽ được gửi về nhóm Telegram để bạn vào app Zalo kiểm tra.
            </p>
          </div>
          <Toggle
            checked={tg.enabled}
            disabled={!ready || busy !== null}
            onChange={(enabled) => save({ enabled })}
            label="Bật thông báo Telegram"
          />
        </div>

        {ready && !tg.enabled && (
          <div className="mt-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <span className="flex-1">⚠️ Thông báo đang <b>TẮT</b>, nên bot sẽ không gửi gì về Telegram.</span>
            <Button loading={busy === 'save'} onClick={() => save({ enabled: true }, 'Đã bật thông báo')}>
              Bật ngay
            </Button>
          </div>
        )}

        <ol className="mt-5 space-y-1 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
          <li>
            1. Chat với <b>@BotFather</b> trên Telegram, gõ <code className="rounded bg-white px-1">/newbot</code> để tạo bot và lấy token.
          </li>
          <li>2. Thêm bot vào nhóm Telegram muốn nhận thông báo, rồi gửi 1 tin bất kỳ trong nhóm đó.</li>
          <li>3. Dán token bên dưới, bấm <b>Tìm nhóm</b> để chọn nhóm, sau đó bấm <b>Gửi thử</b> (thông báo sẽ tự bật).</li>
          <li>
            4. Trong nhóm Telegram, <b>tag tên bot</b> hoặc gõ <code className="rounded bg-white px-1">/trangthai</code> để mở bảng
            điều khiển có nút bấm (bật/tắt "trả lời 1 lần rồi dừng", tiếp tục lắng nghe).
          </li>
        </ol>

        <div className="mt-5 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="tg-token">
              Token bot
            </label>
            <div className="flex gap-2">
              <input
                id="tg-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tg.hasToken ? `Đã lưu: ${tg.tokenPreview} (nhập để thay)` : '123456789:ABCdef...'}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
              />
              <Button
                disabled={!token.trim()}
                loading={busy === 'save'}
                onClick={() => save({ token: token.trim() }, 'Token hợp lệ, đã lưu').then(() => setToken(''))}
              >
                Lưu token
              </Button>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium" htmlFor="tg-chat">
              Nhóm Telegram nhận thông báo (chat ID)
            </label>
            <div className="flex gap-2">
              <input
                id="tg-chat"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
                placeholder="-1001234567890"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
              />
              <Button
                variant="secondary"
                disabled={!tg.hasToken}
                loading={busy === 'chats'}
                onClick={() => act('chats', async () => setChats(await api.telegramChats()))}
              >
                Tìm nhóm
              </Button>
              <Button
                disabled={!chatId.trim() || chatId.trim() === tg.chatId}
                loading={busy === 'save'}
                onClick={() => save({ chatId: chatId.trim() }, 'Đã lưu chat ID')}
              >
                Lưu
              </Button>
            </div>

            {chats && (
              <div className="mt-2 overflow-hidden rounded-lg border border-slate-200">
                {chats.length === 0 ? (
                  <p className="p-3 text-sm text-slate-500">
                    Chưa thấy nhóm nào. Hãy thêm bot vào nhóm, gửi 1 tin trong nhóm rồi bấm Tìm nhóm lại.
                  </p>
                ) : (
                  chats.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setChatId(c.id)
                        setChats(null)
                        save({ chatId: c.id }, `Đã chọn "${c.title}"`)
                      }}
                      className="flex w-full items-center gap-3 border-b border-slate-100 px-3 py-2.5 text-left text-sm last:border-0 hover:bg-slate-50"
                    >
                      <span className="flex-1 font-medium">{c.title}</span>
                      <Badge>{c.type === 'private' ? 'Cá nhân' : c.type === 'channel' ? 'Kênh' : 'Nhóm'}</Badge>
                      <span className="font-mono text-xs text-slate-400">{c.id}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="divide-y divide-slate-100 rounded-lg border border-slate-100">
            <Option title="Báo khi đã trả lời" desc="Tên người, tên nhóm và tin đã trả lời">
              <Toggle checked={tg.notifyReplies} onChange={(v) => save({ notifyReplies: v })} label="Báo khi trả lời" />
            </Option>
            <Option title="Báo khi trả lời lỗi" desc="Để bạn vào trả lời thủ công kịp thời">
              <Toggle checked={tg.notifyErrors} onChange={(v) => save({ notifyErrors: v })} label="Báo lỗi" />
            </Option>
            <Option title="Báo khi bot mất kết nối Zalo" desc="Mất kết nối quá 30 giây sẽ báo, kết nối lại cũng báo">
              <Toggle checked={tg.notifyStatus} onChange={(v) => save({ notifyStatus: v })} label="Báo mất kết nối" />
            </Option>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              disabled={!ready}
              loading={busy === 'test'}
              onClick={() => act('test', async () => setTg(await api.testTelegram()), 'Đã gửi tin thử và BẬT thông báo')}
            >
              Gửi thử
            </Button>
            {message && <p className={`text-sm ${message.ok ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</p>}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <p className="mb-2 text-sm font-medium">Mẫu tin thông báo</p>
        <pre className="rounded-lg bg-slate-50 p-4 font-sans text-sm whitespace-pre-wrap text-slate-700">
{`✅ Người gửi: Nguyễn Văn A
👥 ABC
💬 Có ai không?
↩️ "em"
🥇 Vị trí: #1 · ⚡ 0.14s
🕒 12:01:03`}
        </pre>
      </Card>
    </div>
  )
}

function Option({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-3 py-3">
      <div className="flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-slate-500">{desc}</p>
      </div>
      {children}
    </div>
  )
}
