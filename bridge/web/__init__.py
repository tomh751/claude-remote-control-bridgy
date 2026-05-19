"""Mobile web UI: FastAPI server + WebSocket protocol + PWA frontend.

The phone (over Tailscale) connects to /, authenticates once, and opens a
WebSocket that streams claude's output. Text deltas arrive delta-by-delta
so the user sees claude typing live; tool calls render as paired IN/OUT
cards; watcher-emitted media is auto-attached to the chat.
"""
