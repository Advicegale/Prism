from __future__ import annotations
import os
from pathlib import Path

DATA_DIR = Path(os.getenv("PRISM_DATA_DIR", str(Path.home() / ".local" / "share" / "prism-pr-review"))).expanduser().resolve()
MAX_FILES = int(os.getenv("PRISM_MAX_FILES", "2500"))
MAX_FILE_BYTES = int(os.getenv("PRISM_MAX_FILE_BYTES", "600000"))
MAX_TOTAL_BYTES = int(os.getenv("PRISM_MAX_TOTAL_BYTES", "35000000"))
MAX_DIFF_CHARS = int(os.getenv("PRISM_MAX_DIFF_CHARS", "70000"))
