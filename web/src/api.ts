export type ZaloStatus =
  | { state: 'disconnected'; reason?: string }
  | { state: 'connecting'; attempt?: number; reason?: string; retryAt?: number }
  | { state: 'qr'; image: string }
  | { state: 'qr_scanned'; name: string; avatar: string }
  | { state: 'connected'; uid: string; name: string; avatar: string; since: number }

export type ListenUser = { id: string; name: string }

export type GroupRule = {
  groupId: string
  groupName: string
  enabled: boolean
  listenUsers: ListenUser[]
  reply: string
  quote: boolean
  cooldownSec: number
  textOnly: boolean
  updatedAt: number
}

export type Group = {
  id: string
  name: string
  avatar: string
  totalMember: number
  creatorId: string
  adminIds: string[]
  rule: GroupRule | null
}

export type MemberRole = 'owner' | 'admin' | 'member'
export type Member = { id: string; name: string; avatar: string; role: MemberRole; lastMessageAt?: number }

export type RaceResult = {
  rank: number
  ahead: { name: string; text: string; deltaMs: number }[]
  ourDeltaMs: number | null
}

export type ReplyLog = {
  id: number
  at: number
  groupId: string
  groupName: string
  senderId: string
  senderName: string
  text: string
  reply: string
  ok: boolean
  error?: string
  processMs: number
  totalMs: number
  pending?: boolean
  race?: RaceResult | null
  pausedAfter?: boolean
}

export type ChatMessage = {
  threadId: string
  msgId: string
  isGroup: boolean
  uid: string
  name: string
  ts: number
  isSelf: boolean
  kind: string
  text: string
  attach?: { title?: string; href?: string; thumb?: string }
  quote?: { name: string; text: string }
}

export type ChatThread = {
  threadId: string
  isGroup: boolean
  name: string
  avatar: string
  lastTs: number
  lastText: string
  lastName: string
  lastSelf: boolean
}

export type ReplyMode = {
  working: boolean
  oneShot: boolean
  paused: boolean
  pausedAt?: number
  pausedBy?: { groupName: string; senderName: string }
}

export type TelegramSettings = {
  enabled: boolean
  chatId: string
  notifyReplies: boolean
  notifyErrors: boolean
  notifyStatus: boolean
  hasToken: boolean
  tokenPreview: string
}

export type TelegramChat = { id: string; title: string; type: string }

export type BulkAction = 'listen' | 'enable' | 'disable' | 'reply' | 'remove'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error || data.message || `Lỗi ${res.status}`)
  return data as T
}

export const api = {
  me: () => request<{ authed: boolean }>('GET', '/api/auth/me'),
  login: (password: string) => request('POST', '/api/auth/login', { password }),
  logout: () => request('POST', '/api/auth/logout'),

  meta: () => request<{ maxListenUsers: number; defaultReply: string }>('GET', '/api/meta'),
  status: () => request<ZaloStatus & { hasSavedSession: boolean }>('GET', '/api/zalo/status'),
  loginQR: () => request('POST', '/api/zalo/login-qr'),
  reconnect: () => request('POST', '/api/zalo/reconnect'),
  zaloLogout: () => request('POST', '/api/zalo/logout'),

  groups: (refresh = false) => request<Group[]>('GET', `/api/groups${refresh ? '?refresh=1' : ''}`),
  members: (id: string, refresh = false) =>
    request<Member[]>('GET', `/api/groups/${id}/members${refresh ? '?refresh=1' : ''}`),
  findByPhone: (phone: string) => request<Member>('GET', `/api/users/by-phone?phone=${encodeURIComponent(phone)}`),
  saveRule: (id: string, rule: Partial<Omit<GroupRule, 'groupId' | 'updatedAt'>>) =>
    request<GroupRule>('PUT', `/api/rules/${id}`, rule),
  deleteRule: (id: string) => request('DELETE', `/api/rules/${id}`),
  bulk: (action: BulkAction, groupIds: string[], reply?: string) =>
    request<{ groupId: string; rule: GroupRule | null }[]>('POST', '/api/rules/bulk', { action, groupIds, reply }),
  logs: () => request<ReplyLog[]>('GET', '/api/logs'),
  chats: () => request<ChatThread[]>('GET', '/api/chats'),
  chatMessages: (threadId: string, before?: number) =>
    request<ChatMessage[]>('GET', `/api/chats/${encodeURIComponent(threadId)}/messages${before ? `?before=${before}` : ''}`),
  saveReplyMode: (patch: { working?: boolean; oneShot?: boolean; paused?: boolean }) =>
    request<ReplyMode>('PUT', '/api/reply-mode', patch),

  telegram: () => request<TelegramSettings>('GET', '/api/telegram'),
  saveTelegram: (patch: Partial<Omit<TelegramSettings, 'hasToken' | 'tokenPreview'>> & { token?: string }) =>
    request<TelegramSettings>('PUT', '/api/telegram', patch),
  telegramChats: () => request<TelegramChat[]>('GET', '/api/telegram/chats'),
  testTelegram: () => request<TelegramSettings>('POST', '/api/telegram/test'),
}
