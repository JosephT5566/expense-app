declare module 'swipe-listener' {
  export interface SwipeListenerOptions {
    /** Enable mouse dragging in addition to touch */
    mouse?: boolean;
    /** Prevent native scrolling while swiping */
    preventScroll?: boolean;
    /** Lock the swipe to the dominant axis */
    lockAxis?: boolean;
  }

  // Support both absolute number and [start, end] tuple for x/y
  export interface SwipeDetail {
    /** Absolute movement from gesture start or [start, end] tuple */
    x: [number, number];
    /** Absolute movement from gesture start or [start, end] tuple */
    y: [number, number];
    /** Delta since last event */
    dx: number;
    dy: number;
    angle: number;
    direction: 'up' | 'down' | 'left' | 'right' | null;
    duration: number;
  }

  /**
   * Attach swipe listener to an element.
   * Returns a cleanup function to remove listeners.
   */
  export default function SwipeListener(
    element: Element,
    options?: SwipeListenerOptions,
  ): () => void;
}
