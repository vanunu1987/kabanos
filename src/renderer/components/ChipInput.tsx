import { useId, useState } from 'react'

/** Editable list of tokens (roles, privileges, index patterns) with suggestions. Enter / comma adds. */
export function ChipInput({ value, onChange, suggestions = [], placeholder = 'Add…', label, tone = 'plain', disabled }: { value: string[]; onChange(v: string[]): void; suggestions?: string[]; placeholder?: string; label: string; tone?: 'plain' | 'index' | 'danger'; disabled?: boolean }) {
  const [text, setText] = useState('')
  const listId = useId()
  const add = (raw: string) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (items.length) onChange([...new Set([...value, ...items])])
    setText('')
  }
  return (
    <div className={`chip-input${disabled ? ' disabled' : ''}`} onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((v) => (
        <span key={v} className={`chip-token mono ${tone}`}>
          {v}
          {!disabled && (
            <button aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          aria-label={label}
          list={listId}
          value={text}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            const v = e.target.value
            // Picking a datalist suggestion fires a change with the full value — add it right away.
            if (suggestions.includes(v)) add(v)
            else if (v.endsWith(',')) add(v)
            else setText(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(text)
            }
            if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
          onBlur={() => text && add(text)}
        />
      )}
      <datalist id={listId}>
        {suggestions
          .filter((s) => !value.includes(s))
          .slice(0, 200)
          .map((s) => (
            <option key={s} value={s} />
          ))}
      </datalist>
    </div>
  )
}
