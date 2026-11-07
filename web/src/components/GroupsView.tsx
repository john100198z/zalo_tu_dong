import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type BulkAction, type Group, type GroupRule } from '../api'
import { GroupEditor } from './GroupEditor'
import { Avatar, Badge, Button, Card, Spinner, Toggle } from './ui'

type Filter = 'all' | 'active' | 'unset'

export function GroupsView({ meta }: { meta: { maxListenUsers: number; defaultReply: string } }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [editing, setEditing] = useState<Group | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async (refresh = false) => {
    setRefreshing(true)
    setError('')
    try {
      setGroups(await api.groups(refresh))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const applyRule = (groupId: string, rule: GroupRule | null) =>
    setGroups((prev) => prev?.map((g) => (g.id === groupId ? { ...g, rule } : g)) ?? prev)

  async function quickToggle(g: Group, enabled: boolean) {
    applyRule(g.id, g.rule && { ...g.rule, enabled })
    try {
      applyRule(g.id, await api.saveRule(g.id, { enabled }))
    } catch (err) {
      applyRule(g.id, g.rule)
      alert((err as Error).message)
    }
  }

  const counts = useMemo(
    () => ({
      all: groups?.length ?? 0,
      active: groups?.filter((g) => g.rule).length ?? 0,
      unset: groups?.filter((g) => !g.rule).length ?? 0,
    }),
    [groups],
  )

  const visible = useMemo(() => {
    if (!groups) return []
    const q = query.trim().toLowerCase()
    return groups
      .filter((g) => (filter === 'active' ? g.rule : filter === 'unset' ? !g.rule : true))
      .filter((g) => !q || g.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!!b.rule) - Number(!!a.rule))
  }, [groups, query, filter])

  const allVisibleSelected = visible.length > 0 && visible.every((g) => selected.has(g.id))

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const g of visible) {
        if (allVisibleSelected) next.delete(g.id)
        else next.add(g.id)
      }
      return next
    })
  }

  function exitSelecting() {
    setSelecting(false)
    setSelected(new Set())
  }

  const filters: [Filter, string][] = [
    ['all', 'Tất cả'],
    ['active', 'Đang nghe'],
    ['unset', 'Chưa cấu hình'],
  ]

  return (
    <div className={`space-y-4 ${selecting ? 'pb-40 sm:pb-24' : ''}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm nhóm..."
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
        />
        <div className="flex gap-2">
          <Button variant={selecting ? 'primary' : 'secondary'} onClick={() => (selecting ? exitSelecting() : setSelecting(true))}>
            {selecting ? 'Xong' : '☑ Chọn nhiều'}
          </Button>
          <Button variant="secondary" loading={refreshing} onClick={() => load(true)} title="Tải lại danh sách nhóm từ Zalo">
            {!refreshing && '↻'} Làm mới
          </Button>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto">
        {filters.map(([f, label]) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium transition ${
              filter === f ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'
            }`}
          >
            {label} <span className="opacity-60">{counts[f]}</span>
          </button>
        ))}
      </div>

      {error && <Card className="p-4 text-sm text-red-600">{error}</Card>}

      {!groups && !error && (
        <div className="flex justify-center py-16 text-slate-400">
          <Spinner className="size-8" />
        </div>
      )}

      {groups && (
        <Card className="divide-y divide-slate-100 overflow-hidden">
          {selecting && visible.length > 0 && (
            <label className="flex cursor-pointer items-center gap-3 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-600">
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} className="size-4 accent-brand-500" />
              Chọn tất cả {visible.length} nhóm đang hiển thị
            </label>
          )}
          {visible.length === 0 && (
            <p className="p-8 text-center text-sm text-slate-400">
              {filter === 'active' ? 'Chưa lắng nghe nhóm nào.' : 'Không có nhóm nào'}
            </p>
          )}
          {visible.map((g) => (
            <div
              key={g.id}
              onClick={() => (selecting ? toggleSelect(g.id) : setEditing(g))}
              className={`flex cursor-pointer items-center gap-3 px-4 py-3 transition hover:bg-slate-50 ${
                selecting && selected.has(g.id) ? 'bg-brand-50/60' : ''
              }`}
            >
              {selecting && (
                <input
                  type="checkbox"
                  checked={selected.has(g.id)}
                  onChange={() => toggleSelect(g.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="size-4 shrink-0 accent-brand-500"
                />
              )}
              <Avatar src={g.avatar} name={g.name} size="size-11" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{g.name}</p>
                  {g.rule && !g.rule.enabled && <Badge>Tạm tắt</Badge>}
                </div>
                {g.rule ? (
                  <p className="truncate text-sm text-slate-500">
                    👂 {g.rule.listenUsers.map((u) => u.name).join(', ')}
                    <span className="mx-1.5 text-slate-300">→</span>
                    <span className="text-slate-700">“{g.rule.reply}”</span>
                  </p>
                ) : (
                  <p className="text-sm text-slate-400">{g.totalMember} thành viên · Chưa cấu hình</p>
                )}
              </div>
              {!selecting &&
                (g.rule ? (
                  <Toggle checked={g.rule.enabled} onChange={(v) => quickToggle(g, v)} label={`Bật nhóm ${g.name}`} />
                ) : (
                  <span className="text-sm font-medium text-brand-600">Cấu hình</span>
                ))}
            </div>
          ))}
        </Card>
      )}

      {selecting && (
        <BulkBar
          selectedIds={[...selected]}
          groups={groups ?? []}
          defaultReply={meta.defaultReply}
          onDone={(results) => {
            for (const r of results) applyRule(r.groupId, r.rule)
            exitSelecting()
          }}
        />
      )}

      {editing && (
        <GroupEditor
          group={editing}
          maxListenUsers={meta.maxListenUsers}
          defaultReply={meta.defaultReply}
          onClose={() => setEditing(null)}
          onSaved={(rule) => {
            applyRule(editing.id, rule)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function BulkBar({
  selectedIds,
  groups,
  defaultReply,
  onDone,
}: {
  selectedIds: string[]
  groups: Group[]
  defaultReply: string
  onDone: (results: { groupId: string; rule: GroupRule | null }[]) => void
}) {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState<BulkAction | null>(null)
  const count = selectedIds.length
  const configured = groups.filter((g) => g.rule && selectedIds.includes(g.id)).length

  async function run(action: BulkAction) {
    if (action === 'remove' && !confirm(`Ngừng lắng nghe ${configured} nhóm đã chọn?`)) return
    if (action === 'reply' && !reply.trim()) return alert('Nhập tin trả lời mới trước')
    setBusy(action)
    try {
      onDone(await api.bulk(action, selectedIds, reply.trim() || undefined))
    } catch (err) {
      alert((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 shadow-[0_-4px_20px_rgba(0,0,0,0.06)] backdrop-blur">
      <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
        <p className="shrink-0 text-sm font-medium">
          Đã chọn <span className="text-brand-600">{count}</span> nhóm
        </p>
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder={`Tin trả lời (mặc định "${defaultReply}")`}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-100"
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={!count || !!busy} loading={busy === 'listen'} onClick={() => run('listen')}
            title="Nhóm chưa cấu hình sẽ nghe trưởng nhóm. Nhóm đã cấu hình sẽ được bật lại">
            Lắng nghe
          </Button>
          <Button variant="secondary" disabled={!configured || !!busy} loading={busy === 'reply'} onClick={() => run('reply')}>
            Đổi tin
          </Button>
          <Button variant="secondary" disabled={!configured || !!busy} loading={busy === 'disable'} onClick={() => run('disable')}>
            Tạm tắt
          </Button>
          <Button variant="danger" disabled={!configured || !!busy} loading={busy === 'remove'} onClick={() => run('remove')}>
            Ngừng nghe
          </Button>
        </div>
      </div>
    </div>
  )
}
