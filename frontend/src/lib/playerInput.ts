interface SceneInputOptions {
  advance(): void;
  setFastForward(enabled: boolean): boolean;
  canHold(): boolean;
  isClaimed(x: number, y: number): boolean;
}

/** Pointer capture keeps release reliable when a finger leaves the scene. */
export function bindSceneInput(host: HTMLElement, options: SceneInputOptions) {
  let pointer: { id: number; x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointerHeld = false;
  let controlHeld = false;
  let suppressClick = false;
  const windows = [...new Set([host.ownerDocument.defaultView, window])].filter((w): w is Window & typeof globalThis => !!w);
  const listen = <T extends Event>(target: EventTarget, name: string, handler: (event: T) => void) => {
    target.addEventListener(name, handler as EventListener);
    return () => target.removeEventListener(name, handler as EventListener);
  };
  const sync = () => options.setFastForward(pointerHeld || controlHeld);
  const releasePointer = () => {
    clearTimeout(timer); timer = undefined;
    const previous = pointer;
    pointer = null;
    pointerHeld = false;
    sync();
    if (previous && host.hasPointerCapture(previous.id)) host.releasePointerCapture(previous.id);
  };
  const cancel = () => { controlHeld = false; releasePointer(); };
  const removers = [
    listen<PointerEvent>(host, "pointerdown", (event) => {
      if (event.isPrimary === false) { cancel(); suppressClick = true; return; }
      if (event.button !== 0) return;
      releasePointer(); suppressClick = false;
      const target = event.target as Element | null;
      if (target?.closest("button,input,textarea,select,a,video") || !options.canHold() || options.isClaimed(event.clientX, event.clientY)) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
      host.setPointerCapture(event.pointerId);
      timer = setTimeout(() => {
        if (!pointer || !options.canHold()) return;
        pointerHeld = true;
        if (!sync()) { pointerHeld = false; return; }
        suppressClick = true;
      }, 350);
    }),
    listen<PointerEvent>(host, "pointermove", (event) => {
      if (pointer?.id === event.pointerId && Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 12) { suppressClick = true; releasePointer(); }
    }),
    ...["pointerup", "pointercancel", "lostpointercapture"].map((name) => listen<PointerEvent>(host, name, (event) => {
      if (pointer?.id === event.pointerId) releasePointer();
    })),
    listen<MouseEvent>(host, "click", (event) => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const target = event.target as Element | null;
      if (target?.closest("button:not([data-start-prompt]),input,textarea,select,a,video")) return;
      options.advance();
    }),
    listen<Event>(host, "contextmenu", (event) => event.preventDefault()),
    ...windows.flatMap((win) => [
      listen<KeyboardEvent>(win, "keydown", (event) => {
        const target = event.target as Element | null;
        if (target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
        if (event.key === "Control" && !event.repeat && options.canHold()) {
          controlHeld = true;
          if (!sync()) controlHeld = false;
          event.preventDefault();
        } else if (["Enter", " "].includes(event.key) && !event.repeat && win === host.ownerDocument.defaultView) {
          event.preventDefault(); options.advance();
        }
      }),
      listen<KeyboardEvent>(win, "keyup", (event) => { if (event.key === "Control") { controlHeld = false; sync(); } }),
      listen<Event>(win, "blur", cancel),
      listen<Event>(win.document, "visibilitychange", () => { if (win.document.hidden) cancel(); }),
    ]),
  ];
  return { cancel, dispose() { cancel(); removers.forEach((remove) => remove()); } };
}
