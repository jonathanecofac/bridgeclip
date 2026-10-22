/**
 * Screen + webcam shots: how to show a screen area much wider than the panel
 * above the webcam (a game board, two cards side by side, a wide chart).
 * 'fit' shows it whole over a blurred fill; 'fill' crops it to fill the panel.
 */
export const WIDE_SCREEN_FRAMINGS = ['fit', 'fill'] as const
export type WideScreenFraming = (typeof WIDE_SCREEN_FRAMINGS)[number]
export const FRAMING_DEFAULTS = { wideScreenFraming: 'fit' } as const
export const isWideScreenFraming = (value: unknown): value is WideScreenFraming =>
  typeof value === 'string' && (WIDE_SCREEN_FRAMINGS as readonly string[]).includes(value)
