import { useState } from 'react'
import type { ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n-context'

export function SortableList<T>({ items, getKey, getLabel, onReorder, children }: {
  items: T[]
  getKey: (item: T) => string
  getLabel: (item: T, index: number) => string
  onReorder: (items: T[]) => void
  children: (item: T, index: number, handle: ReactNode) => ReactNode
}) {
  const { t } = useI18n()
  const [draggedKey, setDraggedKey] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null)
  const [announcement, setAnnouncement] = useState('')

  function finishDrag() { setDraggedKey(null); setDropTarget(null) }
  function move(key: string, targetKey: string, after: boolean) {
    const from = items.findIndex(item => getKey(item) === key)
    const target = items.findIndex(item => getKey(item) === targetKey)
    if (from < 0 || target < 0 || from === target) return
    const to = target + (after ? 1 : 0) - (from < target ? 1 : 0)
    if (from === to) return
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onReorder(next)
    setAnnouncement(t('已移至第 {0} 项', to + 1))
  }

  return <div className="relative" onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null) }}>
    {items.map((item, index) => {
      const key = getKey(item)
      const handle = <Button variant="ghost" size="icon" className="sort-handle" aria-label={getLabel(item, index)} title={t('拖动排序，也可使用上、下方向键')} aria-keyshortcuts="ArrowUp ArrowDown" disabled={items.length < 2} draggable={items.length > 1}
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', key)
          setDraggedKey(key)
          setAnnouncement('')
        }}
        onDragEnd={finishDrag}
        onKeyDown={e => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          const target = index + (e.key === 'ArrowUp' ? -1 : 1)
          if (target >= 0 && target < items.length) move(key, getKey(items[target]), target > index)
        }}><GripVertical /></Button>
      return <div key={key} className="sortable-item" data-dragging={draggedKey === key || undefined} data-drop={dropTarget?.key === key ? dropTarget.after ? 'after' : 'before' : undefined}
        onDragOver={e => {
          if (!draggedKey) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const bounds = e.currentTarget.getBoundingClientRect()
          setDropTarget(draggedKey === key ? null : { key, after: e.clientY > bounds.top + bounds.height / 2 })
        }}
        onDrop={e => {
          if (!draggedKey) return
          e.preventDefault()
          const bounds = e.currentTarget.getBoundingClientRect()
          move(draggedKey, key, e.clientY > bounds.top + bounds.height / 2)
          finishDrag()
        }}>{children(item, index, handle)}</div>
    })}
    <p className="sr-only" role="status">{announcement}</p>
  </div>
}
