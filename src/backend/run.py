#!/usr/bin/env python3
"""Entry point used by the DSM lifecycle script."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from frpui.app import main  # noqa: E402

if __name__ == "__main__":
    main()
