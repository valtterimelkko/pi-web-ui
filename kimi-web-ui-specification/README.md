# Kimi Web UI - Comprehensive UI Specification

This folder contains a complete UI specification for the Kimi Code CLI Web Interface, generated through automated testing using Playwright.

## 📁 Contents

### Documentation

| File | Description |
|------|-------------|
| `UI_SPECIFICATION.md` | Main comprehensive specification covering layout, components, interactions, and visual design |
| `SLASH_COMMANDS_REFERENCE.md` | Complete reference for all 25+ slash commands with UI behaviors |
| `COMPONENT_INVENTORY.md` | Detailed inventory of all UI components with props and specifications |
| `TESTING_PLAN.md` | The original testing plan used to generate this specification |

### Assets

| Folder | Contents |
|--------|----------|
| `snapshots/` | 33 PNG screenshots + HTML captures of UI states |
| `videos/` | Full session video recording (WebM format) |

### Automation

| File | Description |
|------|-------------|
| `automation.py` | Python Playwright script used for automated testing |
| `playwright-config.json` | Browser configuration for testing |

---

## 📸 Snapshot Overview

### Initial States
- `01-initial-landing.png` - First view of sessions list
- `02-sessions-list.png` - Sessions list with entries
- `03-before-click-new-session.png` - Before creating session

### Session Creation
- `04-new-session-view.png` - Directory picker modal

### Chat Interface
- `05-typing-message.png` - Typing in input
- `06-message-sent.png` - Message sent
- `07-ai-response-loading.png` - AI loading
- `08-ai-response-complete.png` - Response complete
- `09-conversation-flow.png` - Full conversation

### Slash Commands
- `10-slash-trigger-popup.png` - Command palette
- `11-12-slash-help-*.png` - /help command
- `13-14-slash-version-*.png` - /version command
- `15-16-slash-sessions-*.png` - /sessions command
- `17-18-slash-new-*.png` - /new command
- `19-20-slash-model-*.png` - /model command
- `21-22-slash-plan-*.png` - /plan command
- `23-24-slash-yolo-*.png` - /yolo command
- `25-26-slash-debug-*.png` - /debug command
- `27-28-slash-export-*.png` - /export command
- `29-30-slash-clear-*.png` - /clear command

### Additional Features
- `31-multiline-input.png` - Multiline text input
- `32-tool-execution.png` - Tool execution display
- `33-updated-sessions-list.png` - Return to sessions

---

## 🎯 What This Specification Covers

### Layout Architecture
- Two-pane layout (sidebar + main content)
- Fixed header with branding
- Responsive considerations

### Sessions List View
- Session cards and metadata
- Empty state design
- Search and filtering

### Session Creation Flow
- Directory selection modal
- Recent directories list
- Search functionality

### Chat Interface
- Message bubbles (user & AI)
- Input area design
- Action buttons on messages

### Slash Commands System
- 25+ commands documented
- Command palette UI
- Modal dialogs for each command
- Keyboard navigation

### Modal Dialogs
- Directory picker
- Confirmation dialogs
- Alert/error dialogs
- Selection modals

### Component Library
- Buttons (primary, secondary, ghost, danger)
- Input fields
- Lists and list items
- Icons

### Interaction Patterns
- Creating sessions
- Sending messages
- Using slash commands
- Switching sessions

### Visual Design System
- Color palette
- Typography
- Spacing
- Shadows
- Border radius

---

## 🚀 How to Use This Specification

### For UI Development
1. Reference `UI_SPECIFICATION.md` for overall layout and behavior
2. Use `COMPONENT_INVENTORY.md` for component implementation details
3. Check `SLASH_COMMANDS_REFERENCE.md` for command system

### For Testing
1. Review `snapshots/` for expected UI states
2. Watch `videos/full-session.webm` for interaction flows
3. Use `automation.py` as a base for regression testing

### For Design
1. Follow color palette in Visual Design System section
2. Use component specifications for consistent sizing
3. Reference snapshots for visual hierarchy

---

## 🛠️ Regenerating the Specification

To re-run the automated testing:

```bash
cd /root/pi-web-ui/kimi-web-ui-specification
python3 automation.py
```

Requirements:
- Python 3.8+
- Playwright: `pip install playwright`
- Browser binaries: `playwright install chromium`

---

## 📝 Specification Details

**Generated**: 2026-03-14  
**Kimi Version**: v1.19.0  
**Test URL**: https://kimi.letsautomate.work/  
**Tool**: Playwright (Python)  
**Total Snapshots**: 33  
**Video Duration**: ~2 minutes  

---

## 🤝 Contributing

This specification was generated autonomously through automated UI testing. To improve it:

1. Add more interaction scenarios to `automation.py`
2. Run the script to capture new states
3. Update documentation files with findings
4. Commit changes with descriptive messages

---

*This specification serves as a comprehensive reference for building or improving agent web UI interfaces.*
