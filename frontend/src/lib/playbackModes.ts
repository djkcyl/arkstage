type Mode = "default" | "button_auto" | "quick_play";
interface ModePlayer {
  getState(): string;
  getAutoPlayState(): { mode: string; buttonSpeedLevel: number };
  setAutoPlayMode(mode: Mode): void;
  setAutoPlaySpeedLevel(level: number): void;
}

/** Keep a temporary hold separate from the user's manual/automatic mode. */
export function createPlaybackModes(player: ModePlayer) {
  let held = false;
  let normal: Mode = player.getAutoPlayState().mode === "button_auto" ? "button_auto" : "default";
  const reconcile = () => {
    // Decisions can restore a cached quick mode after the finger was released.
    if (!held && player.getAutoPlayState().mode === "quick_play") player.setAutoPlayMode(normal);
  };
  return {
    reconcile,
    setAuto(enabled: boolean) {
      held = false;
      normal = enabled ? "button_auto" : "default";
      player.setAutoPlayMode(normal);
    },
    setFastForward(enabled: boolean): boolean {
      if (enabled) {
        if (held) return true;
        if (["idle", "finished", "error", "waiting_decision"].includes(player.getState())) return false;
        normal = player.getAutoPlayState().mode === "button_auto" ? "button_auto" : "default";
        player.setAutoPlayMode("quick_play");
        held = player.getAutoPlayState().mode === "quick_play";
        if (held) player.setAutoPlaySpeedLevel(Number.MAX_SAFE_INTEGER); // Native engine clamps to its highest quick speed.
      } else {
        held = false;
        reconcile();
      }
      return held;
    },
    state() {
      reconcile();
      const native = player.getAutoPlayState();
      return { auto: held ? normal === "button_auto" : native.mode === "button_auto", fastForward: held && native.mode === "quick_play", speed: native.buttonSpeedLevel + 1 };
    },
  };
}
