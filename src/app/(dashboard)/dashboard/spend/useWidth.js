"use client";

import { useCallback, useRef, useState } from "react";

// Width of an element, tracked with ResizeObserver. Returns [ref callback, width].
export default function useWidth(initial = 1000) {
  const [w, setW] = useState(initial);
  const ro = useRef(null);
  const ref = useCallback((el) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(() => { const cw = el.clientWidth; if (cw) setW(cw); });
    ro.current.observe(el);
  }, []);
  return [ref, w];
}
