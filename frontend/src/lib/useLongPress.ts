import { useRef, useCallback } from "react";

/**
 * Long-press detector for touch + mouse. A press held past `ms` fires
 * `onLongPress` (used to enter multi-select mode); a short press fires `onClick`.
 * Returns props to spread onto the pressable element. Movement cancels the press.
 */
export function useLongPress(onLongPress: () => void, onClick?: () => void, ms = 450) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);

  const start = useCallback(() => {
    fired.current = false;
    timer.current = window.setTimeout(() => {
      fired.current = true;
      onLongPress();
    }, ms);
  }, [onLongPress, ms]);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const click = useCallback(() => {
    if (!fired.current) onClick?.();
    fired.current = false;
  }, [onClick]);

  return {
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
    onMouseDown: start,
    onMouseUp: clear,
    onMouseLeave: clear,
    onClick: click,
  };
}
