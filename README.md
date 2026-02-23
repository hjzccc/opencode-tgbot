# opencode-tgbot

Telegram remote control for OpenCode. Monitor sessions, send prompts, answer questions, and manage tasks — all from your phone.

## Quick Start

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and grab the token.

2. Get your Telegram chat ID (send `/start` to [@userinfobot](https://t.me/userinfobot)).

3. Create `~/.config/opencode/opencode-notifier.json`:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": YOUR_CHAT_ID
  }
}
```

4. Add the plugin to your `opencode.json`:

```json
{
  "plugin": ["opencode-tgbot"]
}
```

5. Restart OpenCode. The bot starts polling automatically.

## What You Can Do

**From your phone, you can:**

- See all active sessions and what they're working on
- Connect to a session and send prompts, just like the TUI
- Answer questions OpenCode asks (permission prompts, the question tool)
- View todo/task lists for any session
- Start new sessions with an initial prompt
- Stop individual sessions or all active ones
- Mute/unmute notifications

## Commands

| Command | Description |
|---|---|
| `/sessions` | List all sessions, sorted by activity. Reply with a number to connect. |
| `/status` | Show active sessions with current tool, output preview, and tasks. |
| `/connect` | Show connected session details. Also accepts a number or session ID prefix. |
| `/disconnect` | Disconnect from the current session. |
| `/todos` | Show the task list for the connected session. |
| `/new <message>` | Create a new session and send an initial prompt. |
| `/stop` | Abort the connected session. |
| `/cancel` | Abort all active sessions. |
| `/mute` | Silence all notifications. |
| `/unmute` | Re-enable notifications. |
| `/help` | Show the command list. |

## Interaction Flow

1. `/sessions` to see what's running
2. Type a number (e.g. `1`) to connect to a session
3. Type any message to send it as a prompt
4. Type a number again to switch sessions
5. `/disconnect` when done

**Answering questions:** When OpenCode asks a question, you'll see numbered options. Reply with `a1`, `a2`, etc. to pick one, or `a: your custom answer` for free-text input. Plain numbers always select sessions, never answer questions.

## Notifications

You'll get push notifications for:

- Session completion (with file changes, tools used, and output preview)
- Errors
- Permission requests
- Questions that need answering

Toggle per-event notifications in the config:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "...",
    "chatId": 123,
    "events": {
      "permission": true,
      "complete": true,
      "subagent_complete": false,
      "error": true,
      "question": true,
      "interrupted": true
    }
  }
}
```

## Multi-Instance Support

If you run OpenCode in multiple terminals/projects simultaneously:

- Only one instance polls Telegram for commands (lock file based)
- All instances send push notifications
- Session state is shared via files in `~/.config/opencode/notifier/`
- Questions asked in any instance can be answered from Telegram

## Config Reference

Full config at `~/.config/opencode/opencode-notifier.json`:

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "YOUR_BOT_TOKEN",
    "chatId": YOUR_CHAT_ID,
    "events": {
      "permission": true,
      "complete": true,
      "subagent_complete": false,
      "error": true,
      "question": true,
      "interrupted": true
    }
  },
  "showProjectName": true,
  "showSessionTitle": true,
  "messages": {
    "permission": "Session needs permission: {sessionTitle}",
    "complete": "Session has finished: {sessionTitle}",
    "subagent_complete": "Subagent task completed: {sessionTitle}",
    "error": "Session encountered an error: {sessionTitle}",
    "question": "Session has a question: {sessionTitle}"
  }
}
```

- `showProjectName` - Include project folder name in notifications (default: true)
- `showSessionTitle` - Include session title in notification messages (default: true)
- `messages` - Customize notification text. Supports `{sessionTitle}` and `{projectName}` placeholders.

## Troubleshooting

**Bot not responding?**
- Verify `botToken` and `chatId` in the config
- Make sure only one OpenCode instance is running (or that the polling instance is alive)
- Check `~/.config/opencode/notifier-poll.lock` — delete it if the owning process is dead

**Not getting notifications?**
- Check `telegram.enabled` is `true`
- Check per-event toggles in `telegram.events`
- Try `/unmute` in case you muted the bot

**Questions not forwarding?**
- The question API requires OpenCode v2 endpoints. Make sure your OpenCode version supports it.

## License

MIT
