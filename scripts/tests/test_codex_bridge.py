"""Unit tests for the dev Codex bridge's translation layer (no network, no credentials)."""
import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("codex_bridge", ROOT / "scripts" / "dev" / "codex_bridge.py")
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(bridge)


class PayloadTests(unittest.TestCase):
    def test_system_becomes_instructions_and_messages_become_input(self):
        payload = bridge.build_payload({
            "messages": [
                {"role": "system", "content": "Be brief."},
                {"role": "developer", "content": [{"type": "text", "text": "Use tools."}]},
                {"role": "user", "content": "Hello"},
            ],
        }, "gpt-6-luna", "low")
        self.assertEqual(payload["instructions"], "Be brief.\n\nUse tools.")
        self.assertEqual(payload["model"], "gpt-6-luna")
        self.assertFalse(payload["store"])
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["reasoning"]["effort"], "low")
        self.assertEqual(payload["input"], [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello"}]},
        ])

    def test_tool_call_and_result_round_trip(self):
        payload = bridge.build_payload({
            "messages": [
                {"role": "user", "content": "Weather?"},
                {"role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Oslo\"}"}},
                ]},
                {"role": "tool", "tool_call_id": "call_1", "content": "3 C"},
            ],
            "tools": [{"type": "function", "function": {
                "name": "get_weather", "description": "Weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}},
            }}],
            "tool_choice": "auto",
        }, "gpt-6-luna", "low")
        self.assertEqual(payload["input"][1], {
            "type": "function_call", "call_id": "call_1", "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}",
        })
        self.assertEqual(payload["input"][2], {"type": "function_call_output", "call_id": "call_1", "output": "3 C"})
        self.assertEqual(payload["tools"][0]["name"], "get_weather")
        self.assertFalse(payload["tools"][0]["strict"])
        self.assertEqual(payload["tool_choice"], "auto")

    def test_request_effort_wins_and_output_cap_is_passed(self):
        payload = bridge.build_payload({
            "messages": [{"role": "user", "content": "x"}],
            "reasoning_effort": "high",
            "max_tokens": 1234,
        }, "gpt-6-luna", "low")
        self.assertEqual(payload["reasoning"]["effort"], "high")
        self.assertEqual(payload["max_output_tokens"], 1234)

    def test_assistant_text_uses_output_text(self):
        payload = bridge.build_payload({
            "messages": [
                {"role": "user", "content": "x"},
                {"role": "assistant", "content": "earlier"},
            ],
        }, "gpt-6-luna", "low")
        self.assertEqual(payload["input"][1]["content"][0], {"type": "output_text", "text": "earlier"})

    def test_image_parts_are_forwarded(self):
        payload = bridge.build_payload({
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA"}},
            ]}],
        }, "gpt-6-luna", "low")
        self.assertEqual(payload["input"][0]["content"][1], {"type": "input_image", "image_url": "data:image/png;base64,AA"})

    def test_unknown_fields_are_ignored(self):
        payload = bridge.build_payload({
            "messages": [{"role": "user", "content": "x"}],
            "chat_template_kwargs": {"enable_thinking": False},
            "temperature": 0.2,
        }, "gpt-6-luna", "low")
        self.assertNotIn("chat_template_kwargs", payload)
        self.assertNotIn("temperature", payload)

    def test_empty_conversation_still_sends_an_input_item(self):
        payload = bridge.build_payload({"messages": []}, "gpt-6-luna", "low")
        self.assertEqual(payload["input"][0]["role"], "user")
        self.assertNotIn("tools", payload)


class ToolChoiceTests(unittest.TestCase):
    def test_named_function_choice(self):
        self.assertEqual(bridge.translate_tool_choice({"type": "function", "function": {"name": "x"}}), {"type": "function", "name": "x"})
        self.assertEqual(bridge.translate_tool_choice({"function": {"name": "x"}}), {"type": "function", "name": "x"})

    def test_passthrough_choices(self):
        for choice in ("none", "required"):
            self.assertEqual(bridge.translate_tool_choice(choice), choice)
        self.assertEqual(bridge.translate_tool_choice(None), "auto")


class ErrorShapeTests(unittest.TestCase):
    def test_error_body_is_openai_shaped(self):
        self.assertEqual(bridge.error_body("nope"), {"error": {"message": "nope", "type": "upstream_error", "code": None}})


if __name__ == "__main__":
    unittest.main()
