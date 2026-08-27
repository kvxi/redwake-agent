import os
import re
import subprocess
from datetime import date, timedelta
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from markdownify import markdownify


from pathlib import Path
from typing import List, Optional


class ToolSet:
    def __init__(self) -> None:
        self._read_paths: set[Path] = set()

    _MAX_OUTPUT_CHARS = 20_000
    _MAX_OUTPUT_LINES = 1_000
    _FETCH_WINDOW_CHARS = 20_000
    _HTTP_TIMEOUT_SECONDS = 20
    _SEARCH_RESULT_COUNT = 20


    def read(self, file_path: str, view_range: Optional[List[int]] = None) -> str:
        path = Path(file_path).resolve()
        if path.is_dir():
            raise IsADirectoryError(f"Cannot read directory: {file_path}")

        raw_content = path.read_bytes()
        if b"\x00" in raw_content:
            raise ValueError(f"Cannot read binary file: {file_path}")

        try:
            content = raw_content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError(f"Cannot read binary file: {file_path}") from error

        lines = content.splitlines()
        start, end = self._resolve_view_range(view_range, len(lines))
        self._read_paths.add(path)
        selected_lines = enumerate(lines[start - 1 : end], start)

        output = []
        output_size = 0
        for line_number, line in selected_lines:
            rendered_line = f"{line_number}: {line}"
            separator_size = 1 if output else 0
            if (
                len(output) == self._MAX_OUTPUT_LINES
                or output_size + separator_size + len(rendered_line)
                > self._MAX_OUTPUT_CHARS
            ):
                output.append(
                    "[output truncated; use view_range to request a smaller section]"
                )
                break

            output.append(rendered_line)
            output_size += separator_size + len(rendered_line)

        return "\n".join(output)

    @staticmethod
    def _resolve_view_range(
        view_range: Optional[List[int]], line_count: int
    ) -> tuple[int, int]:
        if view_range is None:
            return 1, line_count

        if (
            not isinstance(view_range, (list, tuple))
            or len(view_range) != 2
            or any(type(value) is not int for value in view_range)
        ):
            raise ValueError("view_range must be a two-item list of integers")

        start, end = view_range
        if start < 1:
            raise ValueError("view_range start must be at least 1")
        if end == -1:
            return start, line_count
        if end < start:
            raise ValueError("view_range end must be at least the start or -1")

        return start, min(end, line_count)

    @staticmethod
    def _strip_read_line_numbers(text: str) -> str:
        return re.sub(r"(?m)^[1-9]\d*: ", "", text)


    def write(self, file_path: str, contents: str) -> str:
        path = Path(file_path).resolve()
        if path.is_dir():
            raise IsADirectoryError(f"Cannot write to directory: {file_path}")
        if path.exists() and path not in self._read_paths:
            raise ValueError(f"Cannot overwrite unread file: {file_path}")

        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
        self._read_paths.add(path)
        return f"Successfully wrote {file_path}"

    def edit(self, file_path: str, old_string: str, new_string: str) -> str:
        old_string = self._strip_read_line_numbers(old_string)
        new_string = self._strip_read_line_numbers(new_string)
        if not old_string:
            raise ValueError("old_string must not be empty")

        path = Path(file_path).resolve()
        content = path.read_text(encoding="utf-8")
        match_count = content.count(old_string)
        if match_count == 0:
            raise ValueError("No exact match found for replacement text")
        if match_count > 1:
            raise ValueError(
                "Found multiple exact matches; provide more replacement context"
            )

        self.write(file_path, content.replace(old_string, new_string, 1))
        return "Successfully replaced text at exactly one location."

    def bash(self, command: str) -> dict[str, object]:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            check=False,
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
        }
    def search(
        self,
        query: str,
        domains: Optional[list[str]] = None,
        recency_days: Optional[int] = None,
    ) -> list[dict[str, object]]:
        if not isinstance(query, str) or not query.strip():
            raise ValueError("query must be a non-empty string")

        normalized_domains = self._normalize_domains(domains)
        freshness = self._freshness_range(recency_days)
        api_key = os.environ.get("BRAVE_SEARCH_API_KEY")
        if not api_key:
            raise RuntimeError("BRAVE_SEARCH_API_KEY must be configured for search")

        params: dict[str, object] = {
            "q": query,
            "count": self._SEARCH_RESULT_COUNT,
        }
        if freshness:
            params["freshness"] = freshness

        try:
            response = requests.get(
                "https://api.search.brave.com/res/v1/web/search",
                headers={
                    "Accept": "application/json",
                    "X-Subscription-Token": api_key,
                },
                params=params,
                timeout=self._HTTP_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            payload = response.json()
        except requests.RequestException as error:
            raise RuntimeError("Web search request failed") from error
        except ValueError as error:
            raise RuntimeError("Web search returned invalid JSON") from error

        web_results = payload.get("web", {}).get("results", [])
        if not isinstance(web_results, list):
            raise RuntimeError("Web search returned an invalid result payload")

        results = []
        for result in web_results:
            if not isinstance(result, dict):
                continue

            result_url = result.get("url")
            if not isinstance(result_url, str) or not self._matches_domains(
                result_url, normalized_domains
            ):
                continue

            article = result.get("article")
            published_date = result.get("page_age")
            if not published_date and isinstance(article, dict):
                published_date = article.get("date")

            results.append(
                {
                    "rank": len(results) + 1,
                    "title": result.get("title", ""),
                    "url": result_url,
                    "snippet": result.get("description", ""),
                    "published_date": published_date,
                }
            )
            if len(results) == 10:
                break

        return results

    def fetch(self, url: str, offset: int = 0) -> dict[str, object]:
        if not isinstance(url, str) or not self._is_http_url(url):
            raise ValueError("url must be an absolute HTTP or HTTPS URL")
        if type(offset) is not int or offset < 0:
            raise ValueError("offset must be a non-negative integer")

        try:
            response = requests.get(url, timeout=self._HTTP_TIMEOUT_SECONDS)
            response.raise_for_status()
        except requests.RequestException as error:
            raise RuntimeError(f"Could not fetch URL: {url}") from error

        page_url = response.url
        soup = BeautifulSoup(response.text, "html.parser")
        title = soup.title.get_text(" ", strip=True) if soup.title else page_url
        content = soup.find("main") or soup.find("article") or soup.body or soup

        for element in content.select(
            "aside, footer, form, header, nav, noscript, script, style, template"
        ):
            element.decompose()
        for link in content.find_all("a", href=True):
            link["href"] = urljoin(page_url, link["href"])

        code_blocks = []
        for index, preformatted in enumerate(content.find_all("pre")):
            marker = f"TOOLSETCODEBLOCK{index}END"
            code = preformatted.get_text()
            code_tag = preformatted.find("code")
            classes = code_tag.get("class", []) if code_tag else []
            language = next(
                (
                    class_name.removeprefix("language-")
                    for class_name in classes
                    if class_name.startswith("language-")
                ),
                "",
            )
            longest_backtick_run = max(
                (len(match.group()) for match in re.finditer(r"`+", code)),
                default=0,
            )
            fence = "`" * max(3, longest_backtick_run + 1)
            trailing_newline = "" if code.endswith("\n") else "\n"
            code_blocks.append(
                (marker, f"\n{fence}{language}\n{code}{trailing_newline}{fence}\n")
            )
            preformatted.replace_with(marker)

        markdown = markdownify(str(content), heading_style="ATX")
        for marker, code_block in code_blocks:
            markdown = markdown.replace(marker, code_block)

        total_length = len(markdown)
        end = offset + self._FETCH_WINDOW_CHARS
        return {
            "title": title,
            "content_markdown": markdown[offset:end],
            "truncated": end < total_length,
            "total_length": total_length,
        }

    @staticmethod
    def _normalize_domains(domains: Optional[list[str]]) -> Optional[set[str]]:
        if domains is None:
            return None
        if not isinstance(domains, list):
            raise ValueError("domains must be a list of hostnames")

        normalized = set()
        for domain in domains:
            if not isinstance(domain, str):
                raise ValueError("domains must contain only hostnames")
            hostname = domain.strip().lower().rstrip(".")
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", hostname):
                raise ValueError(f"Invalid domain: {domain}")
            normalized.add(hostname)

        return normalized or None

    @staticmethod
    def _matches_domains(url: str, domains: Optional[set[str]]) -> bool:
        if domains is None:
            return True

        hostname = urlparse(url).hostname
        if hostname is None:
            return False
        hostname = hostname.lower().rstrip(".")
        return any(hostname == domain or hostname.endswith(f".{domain}") for domain in domains)

    @staticmethod
    def _freshness_range(recency_days: Optional[int]) -> Optional[str]:
        if recency_days is None:
            return None
        if type(recency_days) is not int or recency_days < 1:
            raise ValueError("recency_days must be a positive integer")

        end_date = date.today()
        start_date = end_date - timedelta(days=recency_days)
        return f"{start_date.isoformat()}to{end_date.isoformat()}"

    @staticmethod
    def _is_http_url(url: str) -> bool:
        parsed = urlparse(url)
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)