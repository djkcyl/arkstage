#!/usr/bin/env python3
"""Extract the native AVG HUD sprites and RectTransforms from an official APK.

Requires UnityPy. Usage: python tools/extract-player-ui.py /path/to/client.apk
Only the exported PNGs and layout metadata are shipped; the APK stays external.
"""
import argparse
import collections
import json
import struct
from pathlib import Path
import zipfile

import UnityPy

ROOT = Path(__file__).resolve().parent.parent
SPRITES = {
    "settings": "btn_setting", "log": "btn_reader", "log-history": "btn_playback", "hide": "btn_hide",
    "auto": "btn_auto", "speed-1": "btn_auto1x", "speed-2": "btn_auto2x",
    "speed-3": "btn_auto3x", "speed-frame": "btn_autospeed",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--version", default="unknown")
    parser.add_argument("--out", type=Path, default=ROOT / "frontend/src/assets/player-ui")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.apk) as apk:
        groups = collections.defaultdict(list)
        for name in apk.namelist():
            if name.startswith("assets/bin/Data/sharedassets1.assets"):
                groups[name.rsplit("/", 1)[-1].split(".split")[0]].append(name)
        env = UnityPy.Environment()
        for name, parts in groups.items():
            parts.sort(key=lambda p: int(p.rsplit(".split", 1)[1]) if ".split" in p else -1)
            env.load_file(b"".join(apk.read(part) for part in parts), name=name)

    sprite_objects = {obj.path_id: obj for obj in env.objects if obj.type.name == "Sprite"}
    sprites = {}
    layout = {}
    def save_sprite(key, obj):
        sprite = obj.read()
        image = sprite.image
        # Unity atlases trim transparent borders. Restore the authored sprite
        # rect so anchors and native Image component sizes remain meaningful.
        from PIL import Image
        width, height = round(sprite.m_Rect.width), round(sprite.m_Rect.height)
        if image.size != (width, height):
            padded = Image.new("RGBA", (width, height))
            offset = sprite.m_RD.textureRectOffset
            padded.paste(image, (round(offset.x), height - round(offset.y) - image.height))
            image = padded
        image.save(args.out / f"{key}.png")
        sprites[key] = {"source": sprite.m_Name, "pathId": obj.path_id, "width": image.width, "height": image.height}
    for obj in env.objects:
        if obj.type.name == "Sprite":
            sprite = obj.read()
            for key, source_name in SPRITES.items():
                if sprite.m_Name == source_name:
                    save_sprite(key, obj)
        elif obj.type.name == "RectTransform":
            rect = obj.read()
            try:
                go = rect.m_GameObject.read()
                if go.m_Name not in {"btn_setting", "btn_log", "btn_hide", "btn_auto", "btn_speed", "btn_skip"}:
                    continue
                parts = [go.m_Name]
                parent = rect
                for _ in range(12):
                    if not parent.m_Father.path_id:
                        break
                    parent = parent.m_Father.read()
                    parts.insert(0, parent.m_GameObject.read().m_Name)
                hierarchy = "/".join(parts)
                if "AVGController/UICanvas/panel_static_padding/panel_avg/" not in hierarchy:
                    continue
                def vec(v):
                    return [round(v.x, 4), round(v.y, 4)]
                visual_children = {}
                for pointer in rect.m_Children:
                    item = pointer.read()
                    item_go = item.m_GameObject.read()
                    if item_go.m_Name not in {"image", "speed", "text", "hotspot"}:
                        continue
                    visual_children[item_go.m_Name] = {"anchor": vec(item.m_AnchorMin), "position": vec(item.m_AnchoredPosition), "size": vec(item.m_SizeDelta), "pivot": vec(item.m_Pivot)}
                    if item_go.m_Name != "image":
                        continue
                    for component in item_go.m_Component:
                        ref = component.component if hasattr(component, "component") else component[1]
                        if ref.type.name != "MonoBehaviour" or ref.file_id != 0:
                            continue
                        raw = obj.assets_file.objects[ref.path_id].get_raw_data()
                        matches = [sprite_obj for path_id, sprite_obj in sprite_objects.items() if struct.pack("<iq", 0, path_id) in raw]
                        if len(matches) == 1:
                            aliases = {"btn_setting": "settings", "btn_log": "log-history", "btn_hide": "hide", "btn_auto": "auto", "btn_skip": "skip", "btn_speed": "speed-frame"}
                            save_sprite(aliases[go.m_Name], matches[0])
                layout[go.m_Name] = {"hierarchy": hierarchy, "anchor": vec(rect.m_AnchorMin), "position": vec(rect.m_AnchoredPosition), "size": vec(rect.m_SizeDelta), "pivot": vec(rect.m_Pivot), "children": visual_children}
            except (AttributeError, FileNotFoundError):
                continue
    missing = (set(SPRITES) | {"skip"}) - set(sprites)
    if missing:
        raise RuntimeError(f"Missing required native sprites: {sorted(missing)}")
    controls = {"btn_setting", "btn_log", "btn_hide", "btn_auto", "btn_speed", "btn_skip"}
    if controls - set(layout):
        raise RuntimeError(f"Missing required AVG controls: {sorted(controls - set(layout))}")
    metadata = {"source": "Official Arknights Android client", "version": args.version, "asset": "sharedassets1.assets", "stage": [1280, 720], "sprites": sprites, "layout": layout}
    (args.out / "layout.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
