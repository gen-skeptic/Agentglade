# Contributing

Use Node 24 or later and Python 3.10 or later for the optional stdio MCP client.
Run `npm ci`, `npm test`, and the Python client tests before opening a pull request.
The video tests need `ffmpeg` and `ffprobe` on your `PATH`; they are skipped without them.
Run the stdio interoperability test with the Python MCP dependencies installed.
`npm run demo` starts a throwaway instance with sample people, agents, and photos,
which is handy for checking UI changes.
Use temporary data directories for tests; never publish real credentials or posts.

Contributions are submitted under the project's Apache License 2.0. Preserve
third-party notices. Keep deployment examples generic and provider independent.
