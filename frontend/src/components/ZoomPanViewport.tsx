import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { IconButton } from './IconButton'

export type ZoomPanHandle = {
  fit: () => void
  reset: () => void
  zoomIn: () => void
  zoomOut: () => void
}

type Transform = { scale: number; x: number; y: number }

type ZoomPanViewportProps = {
  children: ReactNode
  /** Changes when the content is replaced so the viewport can re-fit it. */
  contentKey?: unknown
  className?: string
  showControls?: boolean
  minScale?: number
  maxScale?: number
  fitPadding?: number
  /** Upper bound when fitting, so small diagrams are not blown up. */
  maxFitScale?: number
  /** Multiplier for wheel/pinch zoom and the zoom buttons. */
  zoomSpeed?: number
  /** What a plain wheel does; Ctrl/Cmd+wheel always does the other one. */
  wheelAction?: 'pan' | 'zoom'
}

const ZOOM_STEP = 1.25
const INITIAL_TRANSFORM: Transform = { scale: 1, x: 0, y: 0 }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/**
 * Scroll/pinch to zoom, drag to pan. Auto-fits new content until the user takes
 * control; the fit button hands control back.
 */
export const ZoomPanViewport = forwardRef<ZoomPanHandle, ZoomPanViewportProps>(function ZoomPanViewport(
  {
    children,
    contentKey,
    className,
    showControls = true,
    minScale = 0.1,
    maxScale = 8,
    fitPadding = 24,
    maxFitScale = 1,
    zoomSpeed = 1,
    wheelAction = 'pan',
  },
  ref,
) {
  const zoomStep = 1 + (ZOOM_STEP - 1) * zoomSpeed
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<Transform>(INITIAL_TRANSFORM)
  const autoFitRef = useRef(true)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null)
  const [transform, setTransformState] = useState<Transform>(INITIAL_TRANSFORM)
  const [dragging, setDragging] = useState(false)

  const setTransform = useCallback(
    (next: Transform) => {
      const scale = clamp(next.scale, minScale, maxScale)
      transformRef.current = { scale, x: next.x, y: next.y }
      setTransformState(transformRef.current)
    },
    [maxScale, minScale],
  )

  const fit = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) {
      return
    }
    const viewportWidth = viewport.clientWidth
    const viewportHeight = viewport.clientHeight
    const contentWidth = content.offsetWidth
    const contentHeight = content.offsetHeight
    if (!viewportWidth || !viewportHeight || !contentWidth || !contentHeight) {
      return
    }
    const scale = clamp(
      Math.min(
        (viewportWidth - fitPadding * 2) / contentWidth,
        (viewportHeight - fitPadding * 2) / contentHeight,
        maxFitScale,
      ),
      minScale,
      maxScale,
    )
    setTransform({
      scale,
      x: (viewportWidth - contentWidth * scale) / 2,
      y: (viewportHeight - contentHeight * scale) / 2,
    })
    autoFitRef.current = true
  }, [fitPadding, maxFitScale, maxScale, minScale, setTransform])

  const zoomAround = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current
      if (!viewport) {
        return
      }
      const rect = viewport.getBoundingClientRect()
      const px = clientX === undefined ? rect.width / 2 : clientX - rect.left
      const py = clientY === undefined ? rect.height / 2 : clientY - rect.top
      const current = transformRef.current
      const nextScale = clamp(current.scale * factor, minScale, maxScale)
      const ratio = nextScale / current.scale
      autoFitRef.current = false
      setTransform({
        scale: nextScale,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio,
      })
    },
    [maxScale, minScale, setTransform],
  )

  const reset = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) {
      return
    }
    autoFitRef.current = false
    setTransform({
      scale: 1,
      x: Math.max(fitPadding, (viewport.clientWidth - content.offsetWidth) / 2),
      y: Math.max(fitPadding, (viewport.clientHeight - content.offsetHeight) / 2),
    })
  }, [fitPadding, setTransform])

  useImperativeHandle(
    ref,
    () => ({
      fit,
      reset,
      zoomIn: () => zoomAround(zoomStep),
      zoomOut: () => zoomAround(1 / zoomStep),
    }),
    [fit, reset, zoomAround, zoomStep],
  )

  // Re-fit whenever the content is replaced, unless the user has taken control.
  useLayoutEffect(() => {
    if (autoFitRef.current) {
      fit()
    }
  }, [contentKey, fit])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (autoFitRef.current) {
        fit()
      }
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fit])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const modifier = event.ctrlKey || event.metaKey
      // Trackpad pinch arrives as ctrl+wheel, so a modifier always flips the plain-wheel action.
      const shouldZoom = wheelAction === 'zoom' ? !modifier : modifier
      if (shouldZoom) {
        const factor = Math.exp(-event.deltaY * 0.01 * zoomSpeed)
        zoomAround(factor, event.clientX, event.clientY)
        return
      }
      const current = transformRef.current
      autoFitRef.current = false
      setTransform({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY })
    }
    viewport.addEventListener('wheel', handleWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', handleWheel)
  }, [setTransform, wheelAction, zoomAround, zoomSpeed])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }
    const current = transformRef.current
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: current.x,
      originY: current.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    autoFitRef.current = false
    setTransform({
      ...transformRef.current,
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    })
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
      setDragging(false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    }
  }

  return (
    <div
      ref={viewportRef}
      className={`zoom-pan-viewport${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={fit}
    >
      <div
        ref={contentRef}
        className="zoom-pan-content"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        {children}
      </div>
      {showControls ? (
        <div className="zoom-pan-controls" onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
          <IconButton icon="zoom-out" label="Zoom out" size="sm" onClick={() => zoomAround(1 / zoomStep)} />
          <button type="button" className="zoom-pan-percent" title="Actual size" onClick={reset}>
            {Math.round(transform.scale * 100)}%
          </button>
          <IconButton icon="zoom-in" label="Zoom in" size="sm" onClick={() => zoomAround(zoomStep)} />
          <IconButton icon="fit" label="Fit diagram" size="sm" onClick={fit} />
        </div>
      ) : null}
    </div>
  )
})
