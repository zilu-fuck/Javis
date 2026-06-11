#!/usr/bin/env python
"""Convert ShowUI desktop grounding rows into a YOLO detection dataset."""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import shutil
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
    parser.add_argument(
        "--dataset",
        default="showlab/ShowUI-desktop",
        help="Hugging Face dataset id or local dataset path.",
    )
    parser.add_argument(
        "--split",
        default="train",
        help="Dataset split to read. Defaults to train.",
    )
    parser.add_argument(
        "--output",
        default="artifacts/local-vision/datasets/showui-desktop-yolo",
        help="Output YOLO dataset directory.",
    )
    parser.add_argument(
        "--max-rows",
        type=int,
        default=None,
        help="Optional row limit for smoke conversion.",
    )
    parser.add_argument(
        "--val-ratio",
        type=float,
        default=0.1,
        help="Validation ratio for deterministic split.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260609,
        help="Deterministic split seed.",
    )
    parser.add_argument(
        "--keep-unknown-as-text",
        action="store_true",
        help="Map unknown instruction targets to Text instead of skipping them.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove the output directory before conversion.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output)
    report = convert_showui_desktop(args, output_dir)
    write_data_yaml(output_dir)
    report_path = output_dir / "conversion-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


def convert_showui_desktop(args: argparse.Namespace, output_dir: Path) -> dict[str, Any]:
    datasets = import_datasets()
    dataset = datasets.load_dataset(args.dataset, split=args.split)
    if args.max_rows is not None:
        dataset = dataset.select(range(min(args.max_rows, len(dataset))))

    if args.clean and output_dir.exists():
        shutil.rmtree(output_dir)
    ensure_yolo_dirs(output_dir)
    rng = random.Random(args.seed)
    groups: dict[str, dict[str, Any]] = {}

    report: dict[str, Any] = {
        "dataset": args.dataset,
        "split": args.split,
        "output": str(output_dir),
        "rowsSeen": 0,
        "imagesWritten": 0,
        "labelsWritten": 0,
        "boxesWritten": 0,
        "uniqueSourceImages": 0,
        "skipped": {},
        "classCounts": {name: 0 for name in CLASSES},
        "fields": list(dataset.features.keys()) if hasattr(dataset, "features") else [],
    }

    for index, row in enumerate(dataset):
        report["rowsSeen"] += 1
        image = extract_image(row)
        if image is None:
            bump(report, "missing_image")
            continue

        bbox = extract_bbox(row)
        if bbox is None:
            bump(report, "missing_or_invalid_bbox")
            continue

        width, height = image.size
        yolo_box = normalize_bbox(bbox, width, height)
        if yolo_box is None:
            bump(report, "bbox_out_of_range")
            continue

        class_name = infer_class_name(row, args.keep_unknown_as_text)
        if class_name is None:
            bump(report, "unmapped_class")
            continue

        class_id = CLASS_TO_ID[class_name.lower()]
        source_id = stable_source_id(row, index)
        if source_id not in groups:
            groups[source_id] = {
                "image": image,
                "boxes": [],
                "source": row.get("image_url") or source_id,
            }
        groups[source_id]["boxes"].append((class_id, class_name, yolo_box))
        report["classCounts"][class_name] += 1

    for group_index, (_source_id, group) in enumerate(groups.items()):
        subset = "val" if rng.random() < args.val_ratio else "train"
        stem = f"showui_desktop_{group_index:06d}"
        image_path = output_dir / "images" / subset / f"{stem}.png"
        label_path = output_dir / "labels" / subset / f"{stem}.txt"
        group["image"].save(image_path)
        lines = []
        seen_boxes = set()
        for class_id, _class_name, box in group["boxes"]:
            key = (class_id, *(round(value, 6) for value in box))
            if key in seen_boxes:
                bump(report, "duplicate_box")
                continue
            seen_boxes.add(key)
            lines.append(f"{class_id} {box[0]:.6f} {box[1]:.6f} {box[2]:.6f} {box[3]:.6f}")
        label_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        report["imagesWritten"] += 1
        report["labelsWritten"] += 1
        report["boxesWritten"] += len(lines)

    report["uniqueSourceImages"] = len(groups)

    return report


def import_datasets() -> Any:
    try:
        import datasets  # type: ignore
    except ImportError as error:
        raise SystemExit(
            "Missing dependency 'datasets'. Install with: .\\.venv\\Scripts\\python.exe -m pip install datasets"
        ) from error
    return datasets


def ensure_yolo_dirs(output_dir: Path) -> None:
    for subset in ("train", "val"):
        (output_dir / "images" / subset).mkdir(parents=True, exist_ok=True)
        (output_dir / "labels" / subset).mkdir(parents=True, exist_ok=True)


def write_data_yaml(output_dir: Path) -> None:
    root = output_dir.resolve().as_posix()
    names = "\n".join(f"  {index}: {name}" for index, name in enumerate(CLASSES))
    yaml = (
        f"path: {root}\n"
        "train: images/train\n"
        "val: images/val\n"
        "names:\n"
        f"{names}\n"
    )
    (output_dir / "data.yaml").write_text(yaml, encoding="utf-8")


def extract_image(row: dict[str, Any]) -> Image.Image | None:
    value = row.get("image")
    if isinstance(value, Image.Image):
        return value.convert("RGB")
    if isinstance(value, dict):
        image = value.get("image")
        if isinstance(image, Image.Image):
            return image.convert("RGB")
        path = value.get("path")
        if path:
            return Image.open(path).convert("RGB")
    for key in ("image_path", "path"):
        path = row.get(key)
        if path and Path(path).exists():
            return Image.open(path).convert("RGB")
    return None


def stable_source_id(row: dict[str, Any], index: int) -> str:
    value = row.get("image_url") or row.get("image_path") or row.get("path")
    if value:
        return str(value)
    return f"row-{index:06d}"


def extract_bbox(row: dict[str, Any]) -> list[float] | None:
    for key in ("bbox", "box", "target_bbox", "element_bbox"):
        value = row.get(key)
        parsed = coerce_bbox(value)
        if parsed is not None:
            return parsed
    return None


def coerce_bbox(value: Any) -> list[float] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            numbers = [float(match) for match in re.findall(r"-?\d+(?:\.\d+)?", value)]
            value = numbers
    if isinstance(value, dict):
        if all(key in value for key in ("x", "y", "width", "height")):
            return [float(value["x"]), float(value["y"]), float(value["width"]), float(value["height"])]
        if all(key in value for key in ("x1", "y1", "x2", "y2")):
            return [float(value["x1"]), float(value["y1"]), float(value["x2"]), float(value["y2"])]
    if isinstance(value, (list, tuple)) and len(value) >= 4:
        try:
            return [float(value[0]), float(value[1]), float(value[2]), float(value[3])]
        except (TypeError, ValueError):
            return None
    return None


def normalize_bbox(bbox: list[float], image_width: int, image_height: int) -> tuple[float, float, float, float] | None:
    if image_width <= 0 or image_height <= 0:
        return None
    if any(not math.isfinite(value) for value in bbox):
        return None

    x1, y1, third, fourth = bbox
    if max(abs(value) for value in bbox) <= 1.5:
        if third > x1 and fourth > y1:
            x2, y2 = third, fourth
        else:
            x2, y2 = x1 + third, y1 + fourth
        return normalize_xyxy(x1, y1, x2, y2)

    if third > x1 and fourth > y1:
        x2, y2 = third, fourth
    else:
        x2, y2 = x1 + third, y1 + fourth

    return normalize_xyxy(
        x1 / image_width,
        y1 / image_height,
        x2 / image_width,
        y2 / image_height,
    )


def normalize_xyxy(x1: float, y1: float, x2: float, y2: float) -> tuple[float, float, float, float] | None:
    x1, x2 = sorted((clamp01(x1), clamp01(x2)))
    y1, y2 = sorted((clamp01(y1), clamp01(y2)))
    width = x2 - x1
    height = y2 - y1
    if width <= 0 or height <= 0:
        return None
    return (x1 + width / 2, y1 + height / 2, width, height)


def infer_class_name(row: dict[str, Any], keep_unknown_as_text: bool) -> str | None:
    candidates = [
        row.get("element_type"),
        row.get("type"),
        row.get("label"),
        row.get("category"),
        row.get("role"),
        row.get("data_type"),
    ]
    text = " ".join(str(value).lower() for value in candidates if value is not None)
    instruction = str(row.get("instruction") or row.get("query") or row.get("task") or "").lower()
    text = f"{text} {instruction}"

    rules = [
        ("Checkbox", ("checkbox", "radio button", "radio")),
        ("Toggle", ("toggle", "switch")),
        ("Input", ("textbox", "text box", "input", "search box", "searchbox", "field", "type ", "enter ")),
        ("Button", ("button", "click", "press", "submit", "confirm", "ok", "cancel")),
        ("Link", ("link", "hyperlink", "url")),
        ("Tab", (" tab", "tab ")),
        ("Navigation", ("navigation", "menu", "sidebar", "breadcrumb")),
        ("Toolbar", ("toolbar", "tool bar")),
        ("Modal", ("dialog", "modal", "popup", "pop-up")),
        ("Icon", ("icon",)),
        ("Image", ("image", "picture", "photo", "thumbnail")),
        ("Text", ("text", "label", "heading", "title")),
    ]
    for class_name, keywords in rules:
        if any(keyword in text for keyword in keywords):
            return class_name
    return "Text" if keep_unknown_as_text else None


def clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def bump(report: dict[str, Any], key: str) -> None:
    skipped = report.setdefault("skipped", {})
    skipped[key] = skipped.get(key, 0) + 1


if __name__ == "__main__":
    main()
