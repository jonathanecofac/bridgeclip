import { useRef, type ReactNode } from 'react'

/** A labelled slider for editor panels; `remember` is true for the first change of a drag (one undo step per drag). */
export function Range({ label, value, min, max, step = 1, format, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; format?: (v: number) => string
  onChange: (value: number, remember: boolean) => void
}): React.JSX.Element {
  const first = useRef(true)
  return <label className="editor-label">{label}<span className="float-right font-mono">{format ? format(value) : value}</span>
    <input type="range" aria-label={label} min={min} max={max} step={step} value={value}
      onPointerDown={() => { first.current = true }} onKeyDown={() => { first.current = true }}
      onChange={(e) => { onChange(Number(e.target.value), first.current); first.current = false }} />
  </label>
}
export const Group = ({ title, children }: { title: string; children: ReactNode }): React.JSX.Element => <section className="editor-style-group"><h4>{title}</h4>{children}</section>
