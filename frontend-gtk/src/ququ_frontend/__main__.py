"""模块入口 — `python -m ququ_frontend` 或 `ququ-gtk`。"""

from __future__ import annotations

import sys

from .app import main

if __name__ == "__main__":
    sys.exit(main())
