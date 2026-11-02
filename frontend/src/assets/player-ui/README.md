These AVG control sprites and RectTransform coordinates were extracted from the
official Arknights Android client 2.7.91. They remain the property of Hypergryph
and are used here to present its story content. `log.png` uses the circular LOG
sprite shown in the in-game reference; `log-history.png` preserves the current
prefab's alternate sprite.

Reproduce with UnityPy 1.25.4 and Pillow installed:

```sh
python tools/extract-player-ui.py /path/to/official-client.apk --version 2.7.91
```

The APK and intermediate Unity assets are not bundled or committed.
