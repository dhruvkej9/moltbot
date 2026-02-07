# Session Timeout Hook

Automatically detects and cleans up stuck runs to prevent session blocking.

## Problem Solved

When a run completes in the session file but the in-memory run state remains "active",
it creates an "orphaned run" that blocks new messages from being processed.

## How It Works

1. Monitors session health every 30 seconds
2. Detects runs that have been "active" for too long (>15 minutes)
3. Automatically clears stuck runs to allow new messages to process
4. Logs all actions for debugging

## Configuration

Add to `openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-timeout": {
          "enabled": true,
          "maxRunDurationMinutes": 15,
          "checkIntervalSeconds": 30
        }
      }
    }
  }
}
```

## Enable/Disable

```bash
# Enable
openclaw hooks enable session-timeout

# Disable
openclaw hooks disable session-timeout
```
