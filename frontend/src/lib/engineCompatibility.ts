/** Fill capabilities removed from upstream toolbox updates in the engine realm. */
export function installEngineCompatibility(realm: { Math: typeof Math }): void {
  const math = realm.Math as typeof Math & {
    clamp?: (value: number, min: number, max: number) => number;
  };
  // PRTS toolbox still calls Math.clamp from HTMLAudioElement.fade(), but newer
  // copies no longer define it. Install it in each iframe, including manifests;
  // retain the upstream implementation when using an older/offline dependency.
  if (typeof math.clamp !== "function") {
    Object.defineProperty(math, "clamp", {
      value: (value: number, min: number, max: number) =>
        value < min ? min : value > max ? max : value,
      writable: true,
      configurable: true,
    });
  }
}
