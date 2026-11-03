interface Playback { identity: string; sound: MusicSound; instance?: unknown }
interface MusicSound { isPlaying?: boolean; instances?: unknown[] }
interface MusicAudio {
  destroyed: boolean;
  musicRequestId: number;
  musicAudio: Playback | null;
  soundCache: Map<string, MusicSound>;
  soundChannels?: Map<string, Playback>;
  getSound(url: string): Promise<MusicSound | null>;
  createPlayback(url: string, identity: string): Promise<Playback | null>;
  stopMusic(fadeMs: number): Promise<void>;
  destroy(): void;
}

/** Self-contained: its source is installed into the isolated engine realm. */
export function installMusicContinuity(prototype: MusicAudio, unload: (url: string) => Promise<unknown>): void {
  const getSound = prototype.getSound, createPlayback = prototype.createPlayback;
  const stopMusic = prototype.stopMusic, destroy = prototype.destroy;
  type State = {
    pending: Map<string, Promise<MusicSound | null>>;
    evicting: Map<string, Promise<unknown>>;
    music: Set<string>;
    wanted: Set<string>;
    serial: Promise<unknown>;
    timer?: ReturnType<typeof setTimeout>;
  };
  const states = new WeakMap<MusicAudio, State>();
  function state(audio: MusicAudio): State {
    let value = states.get(audio);
    if (!value) {
      value = { pending: new Map(), evicting: new Map(), music: new Set(), wanted: new Set(), serial: Promise.resolve() };
      states.set(audio, value);
    }
    return value;
  }
  function prune(audio: MusicAudio, value: State): void {
    if (value.timer) clearTimeout(value.timer);
    value.timer = undefined;
    let retiring = false;
    for (const url of value.music) {
      if (!audio.destroyed && value.wanted.has(url)) continue;
      if (value.pending.has(url)) { retiring = true; continue; }
      const sound = audio.soundCache.get(url);
      const owned = !audio.destroyed && (audio.musicAudio?.sound === sound
        || [...(audio.soundChannels?.values() ?? [])].some(playback => playback.sound === sound));
      if (sound && (owned || sound.isPlaying || sound.instances?.length)) { retiring = true; continue; }
      value.music.delete(url);
      audio.soundCache.delete(url);
      if (sound) {
        const release = Promise.resolve().then(() => unload(url)).catch(() => {}).finally(() => value.evicting.delete(url));
        value.evicting.set(url, release);
      }
    }
    if (retiring && !audio.destroyed) value.timer = setTimeout(() => prune(audio, value), 250);
  }
  prototype.getSound = function (url) {
    const value = state(this);
    let promise = value.pending.get(url);
    if (!promise) {
      promise = (async () => {
        await value.evicting.get(url);
        return getSound.call(this, url);
      })().finally(() => {
        value.pending.delete(url);
        if (this.destroyed) prune(this, value);
      });
      value.pending.set(url, promise);
    }
    return promise;
  };
  prototype.createPlayback = async function (url, identity) {
    // Native music identities are "intro URL\nloop URL". Sound effects use a
    // single URL, so their channel/latency semantics remain native.
    const pair = identity.split("\n");
    if (pair.length !== 2 || !pair[1]) return createPlayback.call(this, url, identity);
    const value = state(this), request = this.musicRequestId;
    const tracks = [...new Set(pair.filter(Boolean))];
    value.wanted = new Set(tracks);
    tracks.forEach(track => value.music.add(track));
    const warm = tracks.map(track => {
      const next = value.serial.then(() => {
        // Skipping/stopping/destroying must not decode queued obsolete tracks.
        if (this.destroyed || this.musicRequestId !== request) return null;
        return this.getSound(track);
      });
      value.serial = next.catch(() => null);
      return next;
    });
    const loaded = await Promise.all(warm);
    if (this.destroyed || this.musicRequestId !== request || loaded.some(sound => !sound)) {
      if (this.musicRequestId === request) value.wanted = new Set(this.musicAudio?.identity.split("\n").filter(Boolean) ?? []);
      prune(this, value);
      return null;
    }
    // Both pieces are decoded before native playMusic starts the intro and
    // fades/stops the previous track. The intro's completion never waits on IO.
    const playback = await createPlayback.call(this, url, identity);
    if (value.timer) clearTimeout(value.timer);
    value.timer = setTimeout(() => prune(this, value), 250);
    return playback;
  };
  prototype.stopMusic = function (fadeMs) {
    const result = stopMusic.call(this, fadeMs), request = this.musicRequestId;
    void result.finally(() => {
      const value = state(this);
      if (this.musicRequestId === request) value.wanted.clear();
      prune(this, value);
    }).catch(() => {});
    return result;
  };
  prototype.destroy = function () {
    destroy.call(this);
    const value = state(this); value.wanted.clear(); prune(this, value);
  };
}
