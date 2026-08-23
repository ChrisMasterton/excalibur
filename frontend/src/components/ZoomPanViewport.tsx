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
import { isClickWithoutDrag } from '../lib/pointer'
import { IconButton } from './IconButton'

/** A box in the content's own (unscaled) coordinate space. */
export type ContentRect = { x: number; y: number; width: number; height: number }

export type ZoomPanHandle = {
  fit: () => void
  reset: () => void
  zoomIn: () => void
  zoomOut: () => void
  /** Centres a box of the content, zooming out only far enough to make it fit. */
  focusRect: (rect: ContentRect) => void
  /** `focusRect` for one or more rendered elements, measured through the current transform. */
  focusElement: (element: Element | readonly Element[]) => void
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
  /** A press and release in the same place: a click on the content, not a pan. */
  onContentClick?: (target: Element) => void
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
    onContentClick,
  },
  ref,
) {
  const zoomStep = 1 + (ZOOM_STEP - 1) * zoomSpeed
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const transformRef = useRef<Transform>(INITIAL_TRANSFORM)
  const autoFitRef = useRef(true)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    /** The element under the press; pointer capture retargets the release to the viewport. */
    target: Element | null
  } | null>(null)
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

  /** Centres `rect` (content coordinates), keeping the current zoom unless it would not fit. */
  const focusRect = useCallback(
    (rect: ContentRect) => {
      const viewport = viewportRef.current
      if (!viewport || rect.width <= 0 || rect.height <= 0) {
        return
      }
      const viewportWidth = viewport.clientWidth
      const viewportHeight = viewport.clientHeight
      if (!viewportWidth || !viewportHeight) {
        return
      }
      const fitScale = Math.min(
        (viewportWidth - fitPadding * 2) / rect.width,
        (viewportHeight - fitPadding * 2) / rect.height,
      )
      const scale = clamp(Math.min(transformRef.current.scale, fitScale), minScale, maxScale)
      autoFitRef.current = false
      setTransform({
        scale,
        x: viewportWidth / 2 - (rect.x + rect.width / 2) * scale,
        y: viewportHeight / 2 - (rect.y + rect.height / 2) * scale,
      })
    },
    [fitPadding, maxScale, minScale, setTransform],
  )

  /** Converts rendered elements' screen boxes back into content coordinates, then focuses them. */
  const focusElement = useCallback(
    (element: Element | readonly Element[]) => {
      const content = contentRef.current
      const elements = Array.isArray(element) ? element : [element as Element]
      if (!content || !elements.length) {
        return
      }
      const contentBox = content.getBoundingClientRect()
      let left = Number.POSITIVE_INFINITY
      let top = Number.POSITIVE_INFINITY
      let right = Number.NEGATIVE_INFINITY
      let bottom = Number.NEGATIVE_INFINITY
      for (const item of elements) {
        const box = item.getBoundingClientRect()
        left = Math.min(left, box.left)
        top = Math.min(top, box.top)
        right = Math.max(right, box.right)
        bottom = Math.max(bottom, box.bottom)
      }
      const { scale } = transformRef.current
      focusRect({
        x: (left - contentBox.left) / scale,
        y: (top - contentBox.top) / scale,
        width: (right - left) / scale,
        height: (bottom - top) / scale,
      })
    },
    [focusRect],
  )

  useImperativeHandle(
    ref,
    () => ({
      fit,
      reset,
      zoomIn: () => zoomAround(zoomStep),
      zoomOut: () => zoomAround(1 / zoomStep),
      focusRect,
      focusElement,
    }),
    [fit, focusElement, focusRect, reset, zoomAround, zoomStep],
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
      target: event.target instanceof Element ? event.target : null,
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

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, clicked = false) => {
    const drag = dragRef.current
    if (drag?.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (
      clicked &&
      drag.target &&
      onContentClick &&
      isClickWithoutDrag({ clientX: drag.startX, clientY: drag.startY }, event)
    ) {
      onContentClick(drag.target)
    }
  }

  return (
    <div
      ref={viewportRef}
      className={`zoom-pan-viewport${dragging ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => endDrag(event, true)}
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
