import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")

from source import loop


class LoopToolIntegrationTests(unittest.TestCase):
    def test_schemas_expose_all_tool_methods(self):
        schemas = {schema["name"]: schema for schema in loop.TOOL_SCHEMAS}

        self.assertEqual(
            set(schemas), {"read", "write", "edit", "bash", "search", "fetch"}
        )
        self.assertEqual(
            schemas["edit"]["input_schema"]["required"],
            ["file_path", "old_string", "new_string"],
        )
        self.assertEqual(
            schemas["fetch"]["input_schema"]["properties"]["offset"]["minimum"], 0
        )

    def test_create_message_always_supplies_tool_schemas(self):
        with patch.object(loop.client.messages, "create", return_value="response") as create:
            response = loop.create_message([{"role": "user", "content": "Hello"}])

        self.assertEqual(response, "response")
        self.assertIs(create.call_args.kwargs["tools"], loop.TOOL_SCHEMAS)
        self.assertEqual(create.call_args.kwargs["system"], loop.build_system_prompt())


    def test_build_system_prompt_includes_context_and_tools(self):
        prompt = loop.build_system_prompt()

        self.assertIn("Include current date in final response.", prompt)
        self.assertIn(loop.date.today().isoformat(), prompt)
        self.assertIn(str(loop.Path.cwd()), prompt)
        self.assertIn(
            "- fetch: Fetch a web page as paginated Markdown.",
            prompt,
        )
        self.assertNotIn("{custom_system.md}", prompt)
        self.assertNotIn("{current_date}", prompt)
        self.assertNotIn("{cwd}", prompt)

    def test_run_turn_records_a_final_response(self):
        response = SimpleNamespace(
            content=[SimpleNamespace(type="text", text="Completed")],
            stop_reason="end_turn",
        )
        messages = [{"role": "user", "content": "Do the work"}]

        with (
            patch.object(loop, "create_message", return_value=response) as create,
            patch("builtins.print") as output,
        ):
            returned = loop.run_turn(messages)

        self.assertIs(returned, response)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(messages[-1], {"role": "assistant", "content": response.content})
        output.assert_called_once_with("Completed")

    def test_run_turn_continues_after_tool_use(self):
        tool_response = SimpleNamespace(
            content=[
                SimpleNamespace(
                    type="tool_use",
                    id="call-1",
                    name="bash",
                    input={"command": "printf ready"},
                )
            ],
            stop_reason="tool_use",
        )
        final_response = SimpleNamespace(
            content=[SimpleNamespace(type="text", text="Completed")],
            stop_reason="end_turn",
        )
        tool_results = [
            {
                "type": "tool_result",
                "tool_use_id": "call-1",
                "content": "{\"stdout\": \"ready\"}",
                "is_error": False,
            }
        ]
        messages = [{"role": "user", "content": "Run a command"}]

        with (
            patch.object(
                loop,
                "create_message",
                side_effect=[tool_response, final_response],
            ) as create,
            patch.object(loop, "run_tools", return_value=tool_results) as run_tools,
            patch("builtins.print"),
        ):
            loop.run_turn(messages)

        self.assertEqual(create.call_count, 2)
        run_tools.assert_called_once_with(tool_response)
        self.assertEqual(
            [message["role"] for message in messages],
            ["user", "assistant", "user", "assistant"],
        )
        self.assertEqual(messages[2]["content"], tool_results)

    def test_run_cli_exits_without_a_model_call_on_blank_or_eof(self):
        with (
            patch("builtins.input", return_value=""),
            patch.object(loop, "run_turn") as run_turn,
        ):
            loop.run_cli()
        run_turn.assert_not_called()

        with (
            patch("builtins.input", side_effect=EOFError),
            patch.object(loop, "run_turn") as run_turn,
        ):
            loop.run_cli()
        run_turn.assert_not_called()
    def test_run_tools_serializes_success_and_errors(self):
        message = SimpleNamespace(
            content=[
                SimpleNamespace(
                    type="tool_use",
                    id="call-success",
                    name="bash",
                    input={"command": "printf ready"},
                ),
                SimpleNamespace(
                    type="tool_use",
                    id="call-error",
                    name="unknown",
                    input={},
                ),
            ]
        )

        results = loop.run_tools(message)

        self.assertEqual(results[0]["tool_use_id"], "call-success")
        self.assertFalse(results[0]["is_error"])
        self.assertEqual(json.loads(results[0]["content"])["stdout"], "ready")
        self.assertEqual(results[1]["tool_use_id"], "call-error")
        self.assertTrue(results[1]["is_error"])
        self.assertIn("Unknown tool name", json.loads(results[1]["content"])["error"])


if __name__ == "__main__":
    unittest.main()
