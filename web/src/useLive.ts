import { useEffect, useState } from 'react'
import { api, type ReplyLog, type ReplyMode, type ZaloStatus } from './api'

const LOG_LIMIT = 200

/** Kết nối WebSocket tới server để nhận trạng thái Zalo và nhật ký trả lời theo thời gian thực. */
export function useLive(onUnauthorized: () => void) {
  const [status, setStatus] = useState<ZaloStatus | null>(null)
  const [hasSavedSession, setHasSavedSession] = useState(false)
  const [logs, setLogs] = useState<ReplyLog[]>([])
  const [online, setOnline] = useState(false)
  const [replyMode, setReplyMode] = useState<ReplyMode | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    api.status().then((s) => setHasSavedSession(s.hasSavedSession)).catch(() => {})
    api.logs().then(setLogs).catch(() => {})

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onopen = () => setOnline(true)
      ws.onmessage = (e) => {
        const { type, data } = JSON.parse(e.data)
        if (type === 'status') {
          setStatus(data)
          if (data.state === 'connected') setHasSavedSession(true)
        } else if (type === 'log') {
          setLogs((prev) => [data, ...prev].slice(0, LOG_LIMIT))
        } else if (type === 'log_update') {
          setLogs((prev) => prev.map((l) => (l.id === data.id ? data : l)))
        } else if (type === 'reply_mode') {
          setReplyMode(data)
        }
      }
      ws.onclose = (e) => {
        setOnline(false)
        if (stopped) return
        if (e.code === 4401) return onUnauthorized()
        retry = setTimeout(connect, 2000)
      }
    }
    connect()

    return () => {
      stopped = true
      clearTimeout(retry)
      ws?.close()
    }
  }, [onUnauthorized])

  return { status, hasSavedSession, setHasSavedSession, logs, online, replyMode, setReplyMode }
}
