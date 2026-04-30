"""Convert Claude Code JSONL transcript to a readable markdown file.

Usage:
    python transcript_to_md.py <input.jsonl> <output.md>
"""

import json
import sys
from pathlib import Path


def truncate(s: str, limit: int = 4000) -> str:
    if s is None:
        return ""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n\n... [truncated {len(s) - limit} chars]"


def render_content_blocks(content, is_assistant: bool) -> str:
    """Render the content array of a message."""
    if isinstance(content, str):
        return content.strip()

    parts = []
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")

        if btype == "text":
            text = block.get("text", "").strip()
            if text:
                parts.append(text)

        elif btype == "thinking":
            thinking = block.get("thinking", "").strip()
            if thinking:
                parts.append(f"<details><summary>thinking</summary>\n\n{thinking}\n\n</details>")

        elif btype == "tool_use":
            name = block.get("name", "?")
            tool_input = block.get("input", {})
            try:
                input_str = json.dumps(tool_input, ensure_ascii=False, indent=2)
            except Exception:
                input_str = str(tool_input)
            parts.append(
                f"**[tool_use] {name}**\n\n```json\n{truncate(input_str, 2000)}\n```"
            )

        elif btype == "tool_result":
            tool_content = block.get("content", "")
            if isinstance(tool_content, list):
                inner = []
                for c in tool_content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        inner.append(c.get("text", ""))
                    elif isinstance(c, str):
                        inner.append(c)
                tool_content = "\n".join(inner)
            elif not isinstance(tool_content, str):
                tool_content = str(tool_content)

            is_error = block.get("is_error", False)
            err_tag = " (error)" if is_error else ""
            parts.append(
                f"**[tool_result{err_tag}]**\n\n```\n{truncate(tool_content, 3000)}\n```"
            )

        elif btype == "image":
            parts.append("**[image attachment]**")

        else:
            parts.append(f"**[{btype}]** {truncate(json.dumps(block, ensure_ascii=False), 300)}")

    return "\n\n".join(parts)


def main():
    if len(sys.argv) != 3:
        print("Usage: python transcript_to_md.py <input.jsonl> <output.md>")
        sys.exit(1)

    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    out = []
    out.append(f"# Sidabari 대화 트랜스크립트\n")
    out.append(f"> Source: `{src.name}`\n")
    out.append("---\n")

    user_n = 0
    asst_n = 0

    with src.open("r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = obj.get("type")
            if mtype not in ("user", "assistant"):
                continue

            msg = obj.get("message")
            if not isinstance(msg, dict):
                continue

            role = msg.get("role", mtype)
            content = msg.get("content")
            ts = obj.get("timestamp", "")

            rendered = render_content_blocks(content, is_assistant=(role == "assistant"))
            if not rendered.strip():
                continue

            if role == "user":
                user_n += 1
                header = f"## 👤 User #{user_n}"
            else:
                asst_n += 1
                header = f"## 🤖 Assistant #{asst_n}"

            if ts:
                header += f"  _<sub>{ts}</sub>_"

            out.append(header)
            out.append("")
            out.append(rendered)
            out.append("")
            out.append("---")
            out.append("")

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text("\n".join(out), encoding="utf-8")
    print(f"Wrote {dst} (user={user_n}, assistant={asst_n})")


if __name__ == "__main__":
    main()
