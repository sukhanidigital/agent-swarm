"""File/shell tools exposed to OpenAI/Claude dev agents via function calling.
Every tool is bound to one worktree root and refuses to touch paths outside it."""
import subprocess
from pathlib import Path


class WorkspaceTools:
    """Bind a fresh set of tool functions to a single worktree so the dev agent can't escape it."""

    def __init__(self, worktree_path: str, report=None):
        self.root = Path(worktree_path).resolve()
        self.log: list[str] = []
        self._report = report or (lambda text: None)  # optional live-activity callback for the UI

    def _resolve(self, rel_path: str) -> Path:
        target = (self.root / rel_path).resolve()
        if self.root not in target.parents and target != self.root:
            raise ValueError(f"Path '{rel_path}' escapes the workspace root")
        return target

    def list_dir(self, rel_path: str = ".") -> str:
        """List files and directories at the given path, relative to the project root."""
        self.log.append(f"list_dir({rel_path})")
        self._report(f"looking at {rel_path}")
        target = self._resolve(rel_path)
        if not target.exists():
            return f"'{rel_path}' does not exist"
        entries = sorted(p.name + ("/" if p.is_dir() else "") for p in target.iterdir()
                          if p.name not in (".git",))
        return "\n".join(entries) or "(empty)"

    MAX_READ_CHARS = 12000  # ~a few hundred lines — bounds worst-case tool-loop cost on large files

    def read_file(self, rel_path: str) -> str:
        """Read a file's text contents, relative to the project root. Large files are truncated —
        this is a cost cap, not a correctness guarantee; a dev/gate that needs more can read in parts."""
        self.log.append(f"read_file({rel_path})")
        self._report(f"reading {rel_path}")
        target = self._resolve(rel_path)
        if not target.exists():
            return f"'{rel_path}' does not exist"
        content = target.read_text(encoding="utf-8", errors="replace")
        if len(content) > self.MAX_READ_CHARS:
            content = content[:self.MAX_READ_CHARS] + f"\n\n... TRUNCATED at {self.MAX_READ_CHARS} chars ..."
        return content

    def write_file(self, rel_path: str, content: str) -> str:
        """Create or overwrite a file with the given content, relative to the project root."""
        self.log.append(f"write_file({rel_path}, {len(content)} chars)")
        self._report(f"writing {rel_path}")
        target = self._resolve(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return f"wrote {len(content)} chars to {rel_path}"

    def run_shell(self, command: str) -> str:
        """Run a shell command (e.g. a test runner or linter) inside the project root and return its output."""
        self.log.append(f"run_shell({command})")
        self._report(f"running: {command[:60]}")
        result = subprocess.run(
            command, shell=True, cwd=self.root, capture_output=True, text=True, timeout=120
        )
        output = result.stdout + result.stderr
        return f"exit={result.returncode}\n{output[-4000:]}"

    def tool_functions(self):
        return [self.list_dir, self.read_file, self.write_file, self.run_shell]

    def tool_impls(self) -> dict:
        return {fn.__name__: fn for fn in self.tool_functions()}

    @staticmethod
    def anthropic_tool_defs(include_write: bool = True) -> list[dict]:
        """Same four tools, described in Anthropic's tool schema for Claude's manual tool-use loop."""
        defs = [
            {
                "name": "list_dir",
                "description": "List files and directories at the given path, relative to the project root.",
                "input_schema": {"type": "object", "properties": {"rel_path": {"type": "string"}}},
            },
            {
                "name": "read_file",
                "description": "Read and return the full text contents of a file, relative to the project root.",
                "input_schema": {"type": "object", "properties": {"rel_path": {"type": "string"}}, "required": ["rel_path"]},
            },
            {
                "name": "run_shell",
                "description": "Run a shell command (e.g. a test runner or linter) inside the project root and return its output.",
                "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
            },
        ]
        if include_write:
            defs.append({
                "name": "write_file",
                "description": "Create or overwrite a file with the given content, relative to the project root.",
                "input_schema": {
                    "type": "object",
                    "properties": {"rel_path": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["rel_path", "content"],
                },
            })
        return defs

    @staticmethod
    def _openai_list_dir_def() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and directories at the given path, relative to the project root.",
                "parameters": {"type": "object", "properties": {"rel_path": {"type": "string"}}},
            },
        }

    @staticmethod
    def _openai_read_file_def() -> dict:
        return {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read and return the full text contents of a file, relative to the project root.",
                "parameters": {"type": "object", "properties": {"rel_path": {"type": "string"}},
                               "required": ["rel_path"]},
            },
        }

    @classmethod
    def openai_discovery_tool_defs(cls) -> list[dict]:
        """list_dir + read_file only, no run_shell — used by the advisory chat, which operates
        directly on the user's live repo_path (not an isolated worktree)."""
        return [cls._openai_list_dir_def(), cls._openai_read_file_def()]

    @staticmethod
    def openai_tool_defs(include_write: bool = True) -> list[dict]:
        """Same four tools, described in OpenAI's function-calling schema for the manual tool-use loop."""
        defs = [
            WorkspaceTools._openai_list_dir_def(),
            WorkspaceTools._openai_read_file_def(),
            {
                "type": "function",
                "function": {
                    "name": "run_shell",
                    "description": "Run a shell command (e.g. a test runner or linter) inside the project root and return its output.",
                    "parameters": {"type": "object", "properties": {"command": {"type": "string"}},
                                   "required": ["command"]},
                },
            },
        ]
        if include_write:
            defs.append({
                "type": "function",
                "function": {
                    "name": "write_file",
                    "description": "Create or overwrite a file with the given content, relative to the project root.",
                    "parameters": {
                        "type": "object",
                        "properties": {"rel_path": {"type": "string"}, "content": {"type": "string"}},
                        "required": ["rel_path", "content"],
                    },
                },
            })
        return defs
