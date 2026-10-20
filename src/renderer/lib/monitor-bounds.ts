import { useEffect, useState, type RefObject } from 'react'

export interface MonitorBounds { width: number; height: number; left: number; top: number }

/** Where the output canvas's picture sits inside its parent, kept up to date on resize. */
export function useMonitorBounds(canvas: RefObject<HTMLCanvasElement | null>, key: unknown): MonitorBounds {
  const [bounds, setBounds] = useState<MonitorBounds>({ width: 0, height: 0, left: 0, top: 0 })
  useEffect(() => {
    const element = canvas.current, parent = element?.parentElement
    if (!element || !parent) return
    const measure = (): void => {
      const box = element.getBoundingClientRect(), outer = parent.getBoundingClientRect()
      const aspect = element.width / element.height
      const width = Math.min(box.width, box.height * aspect), height = width / aspect
      setBounds({ width, height, left: box.left - outer.left + (box.width - width) / 2, top: box.top - outer.top + (box.height - height) / 2 })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element); observer.observe(parent); measure()
    return () => observer.disconnect()
  }, [canvas, key])
  return bounds
}
