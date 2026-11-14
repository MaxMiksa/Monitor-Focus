import { Select as SelectPrimitive } from 'radix-ui'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

type SelectOption = { value: string; label: string; disabled?: boolean }

export function Select({ id, value, onValueChange, options, disabled, 'aria-label': label }: {
  id?: string
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  return <SelectPrimitive.Root open={open} onOpenChange={setOpen} value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectPrimitive.Trigger id={id} data-slot="select-trigger" aria-label={label}>
      <SelectPrimitive.Value />
      <SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content data-slot="select-content" className="glass-select-content" position="popper" sideOffset={8} align="end" collisionPadding={12} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false) }}>
        <SelectPrimitive.ScrollUpButton className="glass-select-scroll"><ChevronUp aria-hidden="true" /></SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>
          {options.map(option => <SelectPrimitive.Item key={option.value} value={option.value} disabled={option.disabled} className="glass-select-option">
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="glass-select-check"><Check aria-hidden="true" /></SelectPrimitive.ItemIndicator>
          </SelectPrimitive.Item>)}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="glass-select-scroll"><ChevronDown aria-hidden="true" /></SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
