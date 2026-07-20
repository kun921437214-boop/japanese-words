#!/usr/bin/env python3
"""Extract the official Xiaohongshu note export with Python's standard library."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree

NAMESPACE = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REQUIRED_HEADERS = [
    "笔记标题",
    "首次发布时间",
    "体裁",
    "曝光",
    "观看量",
    "封面点击率",
    "点赞",
    "评论",
    "收藏",
    "涨粉",
    "分享",
    "人均观看时长",
    "弹幕",
]
OUTPUT_KEYS = {
    "笔记标题": "title",
    "首次发布时间": "publishedAt",
    "体裁": "contentType",
    "曝光": "impressions",
    "观看量": "views",
    "封面点击率": "coverClickRate",
    "点赞": "likes",
    "评论": "comments",
    "收藏": "favorites",
    "涨粉": "follows",
    "分享": "shares",
    "人均观看时长": "avgWatchSeconds",
    "弹幕": "danmaku",
}


def column_index(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference or "")
    result = 0
    for character in letters.group(0) if letters else "":
        result = result * 26 + ord(character) - 64
    return result - 1


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    values = []
    for item in root.findall(f"{NAMESPACE}si"):
        values.append("".join(node.text or "" for node in item.iter(f"{NAMESPACE}t")))
    return values


def cell_value(cell: ElementTree.Element, strings: list[str]):
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        inline = cell.find(f"{NAMESPACE}is")
        return "".join(node.text or "" for node in inline.iter(f"{NAMESPACE}t")) if inline is not None else ""
    value_node = cell.find(f"{NAMESPACE}v")
    raw = value_node.text if value_node is not None and value_node.text is not None else ""
    if cell_type == "s":
        index = int(raw or 0)
        return strings[index] if 0 <= index < len(strings) else ""
    if cell_type == "n":
        number = float(raw or 0)
        return int(number) if number.is_integer() else number
    return raw


def read_rows(path: Path) -> list[list[object]]:
    with zipfile.ZipFile(path) as archive:
        strings = shared_strings(archive)
        root = ElementTree.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    rows = []
    for row in root.findall(f".//{NAMESPACE}row"):
        values = [None] * len(REQUIRED_HEADERS)
        for cell in row.findall(f"{NAMESPACE}c"):
            index = column_index(cell.attrib.get("r", ""))
            if 0 <= index < len(values):
                values[index] = cell_value(cell, strings)
        rows.append(values)
    return rows


def extract(path: Path, captured_at: str | None = None) -> dict:
    rows = read_rows(path)
    header_index = next((index for index, row in enumerate(rows) if row and row[0] == "笔记标题"), -1)
    if header_index < 0:
        raise ValueError("未找到小红书官方导出的表头")
    headers = [str(value or "").strip() for value in rows[header_index]]
    missing = [header for header in REQUIRED_HEADERS if header not in headers]
    if missing:
        raise ValueError(f"缺少必要字段：{', '.join(missing)}")

    normalized = []
    for values in rows[header_index + 1 :]:
        record = {headers[index]: values[index] for index in range(min(len(headers), len(values)))}
        if not str(record.get("笔记标题") or "").strip():
            continue
        normalized.append({OUTPUT_KEYS[header]: record.get(header) for header in REQUIRED_HEADERS})

    identities = [(str(row["title"]).strip(), str(row["publishedAt"]).strip()) for row in normalized]
    if len(identities) != len(set(identities)):
        raise ValueError("导出文件中存在重复的“标题＋发布时间”")
    captured = captured_at or datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    return {
        "source": "xiaohongshu_creator_export",
        "sourceFileName": path.name,
        "capturedAt": captured,
        "capturedAtSource": "file_modified_time" if not captured_at else "official_export",
        "rows": normalized,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="提取小红书创作者平台笔记数据")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--captured-at")
    args = parser.parse_args()
    payload = extract(args.input.expanduser().resolve(), args.captured_at)
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized + "\n", encoding="utf-8")
        print(args.output)
    else:
        print(serialized)


if __name__ == "__main__":
    main()
