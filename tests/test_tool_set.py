import os
import re
import unittest
from unittest.mock import patch

import requests

from tools.tool_set import ToolSet


class FakeResponse:
    def __init__(self, *, payload=None, text="", url="https://example.com/page"):
        self._payload = payload
        self.text = text
        self.url = url

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class SearchTests(unittest.TestCase):
    @patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "test-key"})
    @patch("tools.tool_set.requests.get")
    def test_search_filters_domains_and_returns_ranked_results(self, get):
        get.return_value = FakeResponse(
            payload={
                "web": {
                    "results": [
                        {
                            "title": "Unrelated",
                            "url": "https://example.com/docs",
                            "description": "Skip this result",
                        },
                        {
                            "title": "Python docs",
                            "url": "https://docs.python.org/3/",
                            "description": "Official documentation",
                            "page_age": "2026-08-20",
                        },
                        {
                            "title": "Python subdomain docs",
                            "url": "https://dev.docs.python.org/",
                            "description": "Development documentation",
                        },
                    ]
                }
            }
        )

        results = ToolSet().search(
            "python", domains=["docs.python.org"], recency_days=7
        )

        self.assertEqual([result["rank"] for result in results], [1, 2])
        self.assertEqual(results[0]["title"], "Python docs")
        self.assertEqual(results[0]["published_date"], "2026-08-20")
        self.assertEqual(results[1]["url"], "https://dev.docs.python.org/")
        request_kwargs = get.call_args.kwargs
        self.assertEqual(request_kwargs["params"]["count"], 20)
        self.assertRegex(
            request_kwargs["params"]["freshness"], r"^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$"
        )

    @patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "test-key"})
    @patch("tools.tool_set.requests.get", side_effect=requests.ConnectionError)
    def test_search_wraps_backend_failures(self, get):
        with self.assertRaisesRegex(RuntimeError, "Web search request failed"):
            ToolSet().search("python")


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.html = """
            <html>
              <head><title>Example docs</title></head>
              <body>
                <nav>Navigation should be removed</nav>
                <main>
                  <h1>Guide</h1>
                  <p>Read the <a href="/reference">reference</a>.</p>
                  <div class="language-tabs">
                    <pre><code class="language-python">print("hello")
print("```")</code></pre>
                  </div>
                </main>
              </body>
            </html>
        """

    @patch("tools.tool_set.requests.get")
    def test_fetch_preserves_code_and_absolute_links(self, get):
        get.return_value = FakeResponse(
            text=self.html, url="https://docs.example.com/guide"
        )

        result = ToolSet().fetch("https://docs.example.com/guide")

        self.assertEqual(result["title"], "Example docs")
        self.assertIn("# Guide", result["content_markdown"])
        self.assertIn("[reference](https://docs.example.com/reference)", result["content_markdown"])
        self.assertIn("print(\"hello\")\nprint(\"```\")", result["content_markdown"])
        self.assertIn("````python", result["content_markdown"])
        self.assertNotIn("Navigation should be removed", result["content_markdown"])

    @patch("tools.tool_set.requests.get")
    def test_fetch_returns_contiguous_bounded_windows(self, get):
        get.return_value = FakeResponse(
            text="<main><p>abcdefghijklmnopqrstuvwxyz</p></main>",
            url="https://docs.example.com/page",
        )
        tool = ToolSet()
        full_result = tool.fetch("https://docs.example.com/page")
        full_content = full_result["content_markdown"]
        tool._FETCH_WINDOW_CHARS = 10

        first_window = tool.fetch("https://docs.example.com/page", offset=0)
        second_window = tool.fetch("https://docs.example.com/page", offset=10)

        self.assertEqual(first_window["content_markdown"], full_content[:10])
        self.assertEqual(second_window["content_markdown"], full_content[10:20])
        self.assertEqual(first_window["total_length"], len(full_content))
        self.assertTrue(first_window["truncated"])
        self.assertEqual(second_window["truncated"], 20 < len(full_content))


if __name__ == "__main__":
    unittest.main()
