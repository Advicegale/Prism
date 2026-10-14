#!/usr/bin/env python3
"""Install Graphify's declared language parsers without unrelated service extras.

The installed Graphify metadata is authoritative, so new parser dependencies
join setup automatically when the pinned engine is deliberately updated.
"""
from importlib.metadata import requires
import re

requirements=sorted({requirement.split(';',1)[0].strip() for requirement in requires('graphifyy') or []
                     if re.match(r'(?:tree[-_]sitter(?:[-_\w]*)?|robotframework)\b',requirement,re.I)})
print('\n'.join(requirements))
