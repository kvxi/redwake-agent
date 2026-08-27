# Load env variables and create client
import json
import sys
from datetime import date

from pathlib import Path
from typing import Any, Optional

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.tool_set import ToolSet

from dotenv import load_dotenv
from anthropic import Anthropic
from anthropic.types import Message
model = "opus-5"

load_dotenv()

client = Anthropic()
model = "claude-opus-5"
TOOL_SCHEMAS: list[dict[str, object]] = [
    {
        "name": "read",
        "description": "Read a UTF-8 text file with 1-based line numbers.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "view_range": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "minItems": 2,
                    "maxItems": 2,
                    "description": "Inclusive 1-based [start, end] lines; -1 ends at EOF.",
                },
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "write",
        "description": "Create or fully replace a UTF-8 text file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "contents": {"type": "string"},
            },
            "required": ["file_path", "contents"],
        },
    },
    {
        "name": "edit",
        "description": "Replace one exact text occurrence in a previously read file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    },
    {
        "name": "bash",
        "description": "Run a shell command and return stdout, stderr, and exit code.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    },
    {
        "name": "search",
        "description": "Search the web and return ranked results for subsequent fetches.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "domains": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional hostnames to restrict results to.",
                },
                "recency_days": {"type": "integer", "minimum": 1},
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch",
        "description": "Fetch a web page as paginated Markdown.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "format": "uri"},
                "offset": {"type": "integer", "minimum": 0},
            },
            "required": ["url"],
        },
    },
]

tool_set = ToolSet()
TOOL_METHODS = {
    "read": tool_set.read,
    "write": tool_set.write,
    "edit": tool_set.edit,
    "bash": tool_set.bash,
    "search": tool_set.search,
    "fetch": tool_set.fetch,
}


def build_system_prompt() -> str:
    template_path = Path(__file__).with_name("system_prompt.md")
    custom_system_path = Path(__file__).with_name("custom_system.md")
    template = template_path.read_text(encoding="utf-8")
    custom_system = custom_system_path.read_text(encoding="utf-8")
    tool_descriptions = "\n".join(
        f"- {schema['name']}: {schema['description']}" for schema in TOOL_SCHEMAS
    )
    return (
        template.replace("{custom_system.md}", custom_system)
        .replace("{current_date}", date.today().isoformat())
        .replace("{cwd}", str(Path.cwd()))
        + f"\n\nAvailable tools:\n{tool_descriptions}"
    )


def create_message(
    messages: list[dict[str, Any]], system: Optional[str] = None
) -> Message:
    return client.messages.create(
        model=model,
        max_tokens=4096,
        messages=messages,
        system=system if system is not None else build_system_prompt(),
        tools=TOOL_SCHEMAS,
    )


def run_tool(tool_name: str, tool_input: dict[str, object]) -> object:
    if not isinstance(tool_input, dict):
        raise ValueError("tool input must be an object")

    try:
        tool = TOOL_METHODS[tool_name]
    except KeyError as error:
        raise ValueError(f"Unknown tool name: {tool_name}") from error
    return tool(**tool_input)


def run_tools(message: Message) -> list[dict[str, object]]:
    results = []
    for tool_request in message.content:
        if tool_request.type != "tool_use":
            continue

        try:
            output = run_tool(tool_request.name, tool_request.input)
            result = {
                "type": "tool_result",
                "tool_use_id": tool_request.id,
                "content": json.dumps(output),
                "is_error": False,
            }
        except Exception as error:
            result = {
                "type": "tool_result",
                "tool_use_id": tool_request.id,
                "content": json.dumps({"error": str(error)}),
                "is_error": True,
            }
        results.append(result)

    return results


def text_from_message(message: Message) -> str:
    return "\n".join(
        block.text for block in message.content if block.type == "text"
    )


def run_turn(messages: list[dict[str, Any]]) -> Message:
    while True:
        response = create_message(messages)
        messages.append({"role": "assistant", "content": response.content})

        text = text_from_message(response)
        if text:
            print(text)

        if response.stop_reason != "tool_use":
            return response

        messages.append({"role": "user", "content": run_tools(response)})


def run_cli() -> None:
    messages: list[dict[str, Any]] = []
    while True:
        try:
            user_message = input("> ")
        except EOFError:
            return

        if not user_message:
            return

        messages.append({"role": "user", "content": user_message})
        run_turn(messages)


if __name__ == "__main__":
    run_cli()

