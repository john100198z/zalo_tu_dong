import { useState } from 'react'
import { api, type ZaloStatus } from '../api'
import { Avatar, Button, Card, Spinner } from './ui'

export function ZaloConnect({ status, hasSavedSession }: { status: ZaloStatus | null; hasSavedSession: boolean }) {
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setTimeout(() => setBusy(false), 800)
    }
  }

  return (
    <Card className="mx-auto max-w-md p-5 text-center sm:p-8">
      <h2 className="text-lg font-semibold">Kết nối tài khoản Zalo</h2>

      {(!status || status.state === 'connecting') && (
        <div className="flex flex-col items-center gap-3 py-10 text-slate-500">
          <Spinner className="size-8 text-brand-500" />
          <p className="text-sm">{status?.reason ?? 'Đang kết nối tới Zalo...'}</p>
          {status?.attempt && (
            <p className="text-xs text-slate-400">
              Tự động thử lại lần {status.attempt}
              {status.retryAt && status.retryAt > Date.now() && ` lúc ${new Date(status.retryAt).toLocaleTimeString('vi-VN')}`}
            </p>
          )}
          {status?.attempt && (
            <div className="mt-2 flex gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => run(api.reconnect)}>
                Thử lại ngay
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => run(api.loginQR)}>
                Quét QR mới
              </Button>
            </div>
          )}
        </div>
      )}

      {status?.state === 'qr' && (
        <div className="mt-4">
          <div className="mx-auto w-fit rounded-xl border border-slate-200 bg-white p-3">
            <img src={status.image} alt="Mã QR đăng nhập Zalo" className="size-56 sm:size-60" />
          </div>
          <ol className="mx-auto mt-5 max-w-xs space-y-1 text-left text-sm text-slate-600">
            <li>1. Mở app Zalo trên điện thoại</li>
            <li>2. Bấm biểu tượng quét QR ở thanh tìm kiếm</li>
            <li>3. Quét mã và xác nhận đăng nhập</li>
          </ol>
          <Button variant="ghost" className="mt-4" loading={busy} onClick={() => run(api.loginQR)}>
            Tạo mã mới
          </Button>
        </div>
      )}

      {status?.state === 'qr_scanned' && (
        <div className="flex flex-col items-center gap-3 py-8">
          <Avatar src={status.avatar} name={status.name} size="size-16" />
          <p className="font-medium">{status.name}</p>
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner className="size-4" /> Hãy bấm xác nhận đăng nhập trên điện thoại
          </p>
        </div>
      )}

      {status?.state === 'disconnected' && (
        <div className="py-6">
          <p className="text-sm text-slate-500">
            {status.reason ?? 'Quét mã QR bằng app Zalo để đăng nhập. Phiên sẽ được lưu lại cho lần sau.'}
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Button loading={busy} onClick={() => run(api.loginQR)} className="py-2.5">
              Đăng nhập bằng mã QR
            </Button>
            {hasSavedSession && (
              <Button variant="secondary" disabled={busy} onClick={() => run(api.reconnect)} className="py-2.5">
                Kết nối lại bằng phiên đã lưu
              </Button>
            )}
          </div>
        </div>
      )}

      <p className="mt-6 border-t border-slate-100 pt-4 text-xs text-slate-400">
        Lưu ý: không mở Zalo Web (chat.zalo.me) bằng tài khoản này ở nơi khác, vì sẽ làm bot bị ngắt kết nối.
      </p>
    </Card>
  )
}
