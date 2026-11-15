# Harness desktop modules

Unmodified modules from DeepSeek Harness Desktop at the commit recorded in harness-company.lock.json. The company desktop composes its own company login, window and job lifecycle with these upstream Host/process/profile/HTTP implementations. It does not launch the official desktop executable, modify its signed resources, or embed another application window.

Source: https://github.com/deepseek-ai/deepseek-harness/tree/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/apps/desktop/src

License: MIT; see LICENSE. Regenerate the recorded vendor copy with scripts/prepare-company-source.mjs after reviewing an upstream update. The build verifies every recorded source digest and the pinned runtime artifact. Runtime libraries and the original workspace UI remain at their pinned release; company UI registers through the Harness client slot API.
