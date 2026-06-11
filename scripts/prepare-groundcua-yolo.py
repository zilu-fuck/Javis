#!/usr/bin/env python
"""Convert GroundCUA annotations into a YOLO detection dataset."""

from __future__ import annotations

import argparse
import json
import random
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from PIL import Image


CLASSES = [
    "Button",
    "Text",
    "Image",
    "Icon",
    "Input",
    "Link",
    "Checkbox",
    "Toggle",
    "Toolbar",
    "Navigation",
    "Modal",
    "Tab",
]

CLASS_TO_ID = {name.lower(): index for index, name in enumerate(CLASSES)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", default="ServiceNow/GroundCUA", help="Hugging Face dataset id.")
    parser.add_argument(
        "--output",
        default="artifacts/local-vision/datasets/groundcua-yolo",
        help="Output YOLO dataset directory.",
    )
    parser.add_argument(
        "--apps",
        default="7-Zip,VSCode,Chromium,Mozilla Firefox,Ubuntu Terminal,Nemo,Gedit,LibreOffice Writer,LibreOffice Calc,OnlyOffice Document Editor,PyCharm,Bitwarden,OBS Studio",
        help="Comma-separated app names to include. Use '*' for all apps.",
    )
    parser.add_argument("--max-samples", type=int, default=3000, help="Max screenshots to convert.")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="Validation image ratio.")
    parser.add_argument("--seed", type=int, default=20260609, help="Deterministic shuffle seed.")
    parser.add_argument("--clean", action="store_true", help="Remove output before conversion.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output)
    if args.clean and output_dir.exists():
        shutil.rmtree(output_dir)
    ensure_yolo_dirs(output_dir)

    hf = import_huggingface()
    api = hf["api"]()
    files = api.list_repo_files(args.dataset, repo_type="dataset")
    selected_json = select_annotation_files(files, args.apps, args.max_samples, args.seed)

    report = convert_files(args, selected_json, output_dir, hf)
    write_data_yaml(output_dir)
    (output_dir / "conversion-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def import_huggingface() -> dict[str, Any]:
    try:
        from huggingface_hub import HfApi, hf_hub_download
    except ImportError as error:
        raise SystemExit(
            "Missing dependency 'huggingface_hub'. Install with: .\\.venv\\Scripts\\python.exe -m pip install huggingface-hub"
        ) from error
    return {"api": HfApi, "download": hf_hub_download}


def select_annotation_files(files: list[str], apps_arg: str, max_samples: int | None, seed: int) -> list[str]:
    json_files = [file for file in files if file.startswith("data/") and file.endswith(".json")]
    apps = {app.strip() for app in apps_arg.split(",") if app.strip()}
    if apps and "*" not in apps:
        json_files = [file for file in json_files if app_name_from_data_path(file) in apps]
    rng = random.Random(seed)
    rng.shuffle(json_files)
    if max_samples and max_samples > 0:
        json_files = json_files[:max_samples]
    return json_files


def convert_files(args: argparse.Namespace, json_files: list[str], output_dir: Path, hf: dict[str, Any]) -> dict[str, Any]:
    rng = random.Random(args.seed)
    report: dict[str, Any] = {
        "dataset": args.dataset,
        "output": str(output_dir),
        "selectedJsonFiles": len(json_files),
        "imagesWritten": 0,
        "labelsWritten": 0,
        "boxesWritten": 0,
        "skipped": {},
        "sourceCategories": {},
        "classCounts": {name: 0 for name in CLASSES},
        "apps": {},
    }

    for index, json_file in enumerate(json_files):
        try:
            json_path = hf["download"](args.dataset, json_file, repo_type="dataset")
            annotations = json.loads(Path(json_path).read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001 - report and continue dataset conversion.
            bump(report, "json_download_or_parse_failed")
            continue
        if not isinstance(annotations, list) or not annotations:
            bump(report, "empty_json")
            continue

        image_rel = annotations[0].get("image_path")
        if not image_rel:
            bump(report, "missing_image_path")
            continue
        image_file = f"images/{image_rel}"
        try:
            image_path = hf["download"](args.dataset, image_file, repo_type="dataset")
            image = Image.open(image_path).convert("RGB")
        except Exception:  # noqa: BLE001
            bump(report, "image_download_or_open_failed")
            continue

        width, height = image.size
        label_lines: list[str] = []
        seen_boxes = set()
        app_name = image_rel.split("/")[0] if "/" in image_rel else "unknown"
        report["apps"][app_name] = report["apps"].get(app_name, 0) + 1

        for annotation in annotations:
            category = str(annotation.get("category") or "")
            report["sourceCategories"][category] = report["sourceCategories"].get(category, 0) + 1
            class_name = map_category(category, str(annotation.get("text") or ""))
            if class_name is None:
                bump(report, "unmapped_category")
                continue
            bbox = annotation.get("bbox")
            yolo_box = normalize_bbox(bbox, width, height)
            if yolo_box is None:
                bump(report, "invalid_bbox")
                continue
            class_id = CLASS_TO_ID[class_name.lower()]
            key = (class_id, *(round(value, 6) for value in yolo_box))
            if key in seen_boxes:
                bump(report, "duplicate_box")
                continue
            seen_boxes.add(key)
            label_lines.append(f"{class_id} {yolo_box[0]:.6f} {yolo_box[1]:.6f} {yolo_box[2]:.6f} {yolo_box[3]:.6f}")
            report["classCounts"][class_name] += 1

        if not label_lines:
            bump(report, "no_mapped_boxes")
            continue

        subset = "val" if rng.random() < args.val_ratio else "train"
        stem = f"groundcua_{index:06d}"
        image.save(output_dir / "images" / subset / f"{stem}.png")
        (output_dir / "labels" / subset / f"{stem}.txt").write_text("\n".join(label_lines) + "\n", encoding="utf-8")
        report["imagesWritten"] += 1
        report["labelsWritten"] += 1
        report["boxesWritten"] += len(label_lines)

    report["sourceCategories"] = dict(sorted(report["sourceCategories"].items(), key=lambda item: (-item[1], item[0])))
    report["apps"] = dict(sorted(report["apps"].items(), key=lambda item: (-item[1], item[0])))
    return report


def app_name_from_data_path(path: str) -> str:
    parts = path.split("/")
    return parts[1] if len(parts) > 2 else ""


def map_category(category: str, text: str) -> str | None:
    value = f"{category} {text}".lower()
    if "cursor" in value:
        return None
    if "button" in value:
        return "Button"
    if "input" in value or "textbox" in value or "text field" in value or "edit" in value:
        return "Input"
    if "checkbox" in value or "radio" in value:
        return "Checkbox"
    if "toggle" in value or "switch" in value:
        return "Toggle"
    if "tab" in value:
        return "Tab"
    if "menu" in value or "navigation" in value or "tree" in value or "list" in value:
        return "Navigation"
    if "toolbar" in value or "tool bar" in value:
        return "Toolbar"
    if "dialog" in value or "modal" in value or "popup" in value:
        return "Modal"
    if "link" in value:
        return "Link"
    if "icon" in value:
        return "Icon"
    if "image" in value or "picture" in value:
        return "Image"
    if "information display" in value or "text" in value or "label" in value or "title" in value:
        return "Text"
    if category.lower() == "others":
        return None
    return None


def normalize_bbox(value: Any, image_width: int, image_height: int) -> tuple[float, float, float, float] | None:
    if not isinstance(value, list | tuple) or len(value) < 4:
        return None
    try:
        x1, y1, x2, y2 = [float(value[index]) for index in range(4)]
    except (TypeError, ValueError):
        return None
    if image_width <= 0 or image_height <= 0:
        return None
    x1, x2 = sorted((max(0.0, min(x1, image_width)), max(0.0, min(x2, image_width))))
    y1, y2 = sorted((max(0.0, min(y1, image_height)), max(0.0, min(y2, image_height))))
    width = x2 - x1
    height = y2 - y1
    if width <= 0 or height <= 0:
        return None
    return (
        (x1 + width / 2) / image_width,
        (y1 + height / 2) / image_height,
        width / image_width,
        height / image_height,
    )


def ensure_yolo_dirs(output_dir: Path) -> None:
    for subset in ("train", "val"):
        (output_dir / "images" / subset).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / subset).mkdir(parents=True, exist_ok=True)


def write_data_yaml(output_dir: Path) -> None:
    names = "\n".join(f"  {index}: {name}" for index, name in enumerate(CLASSES))
    yaml = (
        f"path: {output_dir.resolve().as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n"
        f"{names}\n"
    )
    (output_dir / "data.yaml").write_text(yaml, encoding="utf-8")


def bump(report: dict[str, Any], key: str) -> None:
    skipped = report.setdefault("skipped", {})
    skipped[key] = skipped.get(key, 0) + 1


if __name__ == "__main__":
    main()
