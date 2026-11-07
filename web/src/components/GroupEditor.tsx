import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type Group, type GroupRule, type ListenUser, type Member } from '../api'
import { Avatar, Badge, Button, Spinner, Toggle } from './ui'

type Props = {
  group: Group
  maxListenUsers: number
  defaultReply: string
  onClose: () => void
  onSaved: (rule: GroupRule | null) => void
}

const roleBadge = {
  owner: <Badge tone="amber">Trưởng nhóm</Badge>,
  admin: <Badge tone="brand">Phó nhóm</Badge>,
  member: null,
}

export function GroupEditor({ group, maxListenUsers, defaultReply, onClose, onSaved }: Props) {
  const rule = group.rule
  const [members, setMembers] = useState<Member[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<ListenUser[]>(rule?.listenUsers ?? [])
  const [reply, setReply] = useState(rule?.reply ?? defaultReply)
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [quote, setQuote] = useState(rule?.quote ?? false)
  const [textOnly, setTextOnly] = useState(rule?.textOnly ?? false)
  const [cooldownSec, setCooldownSec] = useState(rule?.cooldownSec ?? 0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneBusy, setPhoneBusy] = useState(false)
  const [phoneError, setPhoneError] = useState('')

  useEffect(() => {
    api
      .members(group.id)
      .then((list) => {
        setMembers(list)
        // Nhóm mới cấu hình: mặc định chọn trưởng nhóm.
        if (!rule) {
          const owner = list.find((m) => m.role === 'owner')
          if (owner) setSelected([{ id: owner.id, name: owner.name }])
        }
      })
      .catch((err) => setLoadError(err.message))
  }, [group.id, rule])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const filtered = useMemo(() => {
    if (!members) return []
    const q = query.trim().toLowerCase()
    return q ? members.filter((m) => m.name.toLowerCase().includes(q) || m.id.includes(q)) : members
  }, [members, query])

  const isSelected = (id: string) => selected.some((u) => u.id === id)
  const full = selected.length >= maxListenUsers

  function toggle(m: Member) {
    if (isSelected(m.id)) setSelected(selected.filter((u) => u.id !== m.id))
    else if (!full) setSelected([...selected, { id: m.id, name: m.name }])
  }

  async function lookupPhone() {
    setPhoneBusy(true)
    setPhoneError('')
    try {
      const found = await api.findByPhone(phone.trim())
      setMembers((prev) => [found, ...(prev ?? []).filter((m) => m.id !== found.id)])
      if (!isSelected(found.id) && !full) setSelected([...selected, { id: found.id, name: found.name }])
      setPhone('')
      setQuery('')
    } catch (err) {
      setPhoneError((err as Error).message)
    } finally {
      setPhoneBusy(false)
    }
  }

  async function save() {
    if (selected.length === 0) return setError('Hãy chọn ít nhất 1 người để lắng nghe')
    setSaving(true)
    setError('')
    try {
      const saved = await api.saveRule(group.id, {
        groupName: group.name,
        enabled,
        listenUsers: selected,
        reply,
        quote,
        textOnly,
        cooldownSec,
      })
      onSaved(saved)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!confirm(`Ngừng lắng nghe nhóm "${group.name}"?`)) return
    setSaving(true)
    try {
      await api.deleteRule(group.id)
      onSaved(null)
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-slate-100 p-4">
          <Avatar src={group.avatar} name={group.name} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{group.name}</h2>
            <p className="text-xs text-slate-500">{group.totalMember} thành viên</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100" aria-label="Đóng">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-sm font-semibold">Người được lắng nghe</h3>
              <span className="text-xs text-slate-500">
                Đã chọn {selected.length}/{maxListenUsers}
              </span>
            </div>

            {selected.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-2">
                {selected.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-1 pr-1 pl-3 text-sm text-brand-700">
                    {u.name}
                    <button
                      onClick={() => setSelected(selected.filter((x) => x.id !== u.id))}
                      className="rounded-full px-1.5 hover:bg-brand-100"
                      aria-label={`Bỏ ${u.name}`}
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm thành viên..."
              className="mb-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
            />
            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-100">
              {!members && !loadError && (
                <div className="flex justify-center p-6 text-slate-400">
                  <Spinner />
                </div>
              )}
              {loadError && <p className="p-4 text-sm text-red-600">{loadError}</p>}
              {filtered.map((m) => {
                const checked = isSelected(m.id)
                const disabled = !checked && full
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-slate-50 ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(m)}
                      className="size-4 accent-brand-500"
                    />
                    <Avatar src={m.avatar} name={m.name} size="size-8" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{m.name}</span>
                      {m.lastMessageAt && <span className="block text-xs text-slate-400">Nhắn {ago(m.lastMessageAt)}</span>}
                    </span>
                    {roleBadge[m.role]}
                  </label>
                )
              })}
              {members && filtered.length === 0 && <p className="p-4 text-center text-sm text-slate-400">Không tìm thấy</p>}
            </div>

            {members && members.length < group.totalMember - 1 && (
              <p className="mt-2 text-xs text-slate-500">
                Nhóm lớn: Zalo chỉ cho xem {members.length}/{group.totalMember} thành viên (trưởng/phó nhóm và những người bot đã
                thấy nhắn). Nếu không thấy người cần nghe, hãy tìm theo số điện thoại:
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && phone.trim() && lookupPhone()}
                inputMode="tel"
                placeholder="Tìm theo số điện thoại Zalo"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
              />
              <Button variant="secondary" disabled={!phone.trim()} loading={phoneBusy} onClick={lookupPhone}>
                Tìm
              </Button>
            </div>
            {phoneError && <p className="mt-1 text-xs text-red-600">{phoneError}</p>}
          </section>

          <section>
            <label className="mb-2 block text-sm font-semibold" htmlFor="reply">
              Tin nhắn trả lời
            </label>
            <textarea
              id="reply"
              rows={2}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={defaultReply}
              className="w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
            />
          </section>

          <section className="divide-y divide-slate-100 rounded-lg border border-slate-100">
            <Row title="Bật lắng nghe" desc="Tắt tạm thời mà vẫn giữ cấu hình">
              <Toggle checked={enabled} onChange={setEnabled} label="Bật lắng nghe" />
            </Row>
            <Row title="Trả lời dạng trích dẫn" desc="Reply thẳng vào tin nhắn của người đó">
              <Toggle checked={quote} onChange={setQuote} label="Trích dẫn" />
            </Row>
            <Row title="Chỉ trả lời tin dạng chữ" desc="Bỏ qua ảnh, sticker, file...">
              <Toggle checked={textOnly} onChange={setTextOnly} label="Chỉ tin chữ" />
            </Row>
            <Row title="Thời gian chờ (giây)" desc="0 = trả lời mọi tin. Đặt >0 để tránh bị coi là spam">
              <input
                type="number"
                min={0}
                max={3600}
                value={cooldownSec}
                onChange={(e) => setCooldownSec(Math.max(0, Math.min(3600, Number(e.target.value) || 0)))}
                className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-right text-sm outline-none focus:border-brand-500"
              />
            </Row>
          </section>
        </div>

        <footer className="flex items-center gap-2 border-t border-slate-100 p-4">
          {rule && (
            <Button variant="danger" onClick={remove} disabled={saving}>
              Ngừng nghe
            </Button>
          )}
          <div className="flex-1" />
          {error && <p className="mr-2 text-sm text-red-600">{error}</p>}
          <Button variant="secondary" onClick={onClose}>
            Huỷ
          </Button>
          <Button onClick={save} loading={saving}>
            Lưu
          </Button>
        </footer>
      </div>
    </div>
  )
}

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút trước`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} giờ trước`
  return `${Math.round(h / 24)} ngày trước`
}

function Row({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
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
