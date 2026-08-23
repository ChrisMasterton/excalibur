type ClientPoint = { clientX: number; clientY: number }

/** How far a pointer may travel between down and up and still count as a click. */
export const CLICK_SLOP_PX = 4

/** True when a press/release pair is a click rather than the end of a drag. */
export function isClickWithoutDrag(start: ClientPoint, end: ClientPoint) {
  return (
    Math.abs(end.clientX - start.clientX) <= CLICK_SLOP_PX &&
    Math.abs(end.clientY - start.clientY) <= CLICK_SLOP_PX
  )
}
