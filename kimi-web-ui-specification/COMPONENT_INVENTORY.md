# Kimi Web UI - Component Inventory

**Complete inventory of all UI components with specifications.**

---

## Layout Components

### App Shell

**Purpose**: Root layout container

**Structure**:
```
<AppShell>
  <Header />
  <Layout>
    <Sidebar />
    <MainContent>
      <RouterOutlet />
    </MainContent>
  </Layout>
</AppShell>
```

**Props**:
- `version`: string - App version to display
- `isAuthenticated`: boolean - Auth state

---

### Header

**Purpose**: Top navigation bar with branding

**Location**: Fixed top, full width

**Dimensions**:
- Height: 50-60px
- Padding: 0 16-24px

**Children**:
1. **Logo** - Brand icon + name
2. **VersionTag** - Small version text

**States**:
- Default: White background
- Scrolled: Optional shadow

---

### Sidebar

**Purpose**: Session navigation and management

**Location**: Fixed left

**Dimensions**:
- Width: 280px (fixed)
- Height: calc(100vh - headerHeight)

**Sections** (top to bottom):
1. **SectionHeader** - "SESSIONS" label
2. **Toolbar** - Action buttons
3. **SearchBox** - Session filter
4. **SessionList** - Scrollable list
5. **Footer** - Archive toggle, settings

**Props**:
- `sessions`: Session[]
- `activeSessionId`: string
- `archivedCount`: number
- `onNewSession`: () => void
- `onSelectSession`: (id) => void

---

### MainContent

**Purpose**: Dynamic content area

**Location**: Right of sidebar

**Dimensions**:
- Width: calc(100vw - sidebarWidth)
- Height: calc(100vh - headerHeight)

**Routes**:
- `/` - Sessions list (empty state)
- `/session/:id` - Chat interface

---

## Content Components

### EmptyState

**Purpose**: Display when no session selected

**Visual Elements**:
- Large centered icon (sparkles)
- Heading: "Create a session to begin"
- Subtext: Instruction text
- CTA Button: "+ Create new session"

**Props**:
- `icon`: IconComponent
- `title`: string
- `description`: string
- `actionLabel`: string
- `onAction`: () => void

---

### ChatInterface

**Purpose**: Main conversation view

**Structure**:
```
<ChatInterface>
  <ChatHeader /> (optional)
  <MessageList>
    <MessageBubble />...
  </MessageList>
  <InputArea />
</ChatInterface>
```

**Props**:
- `session`: Session
- `messages`: Message[]
- `onSendMessage`: (text) => void
- `isLoading`: boolean

---

### MessageList

**Purpose**: Scrollable container for messages

**Behavior**:
- Auto-scroll to bottom on new messages
- Scroll up shows "Scroll to bottom" button
- Grouped by date (optional)

**Props**:
- `messages`: Message[]
- `isStreaming`: boolean

---

### MessageBubble

**Purpose**: Individual message display

**Variants**:
1. **User** - Right-aligned, dark background
2. **Assistant** - Left-aligned, light background
3. **System** - Centered, muted style (for errors/notices)

**Structure**:
```
<MessageBubble variant="user|assistant">
  <Avatar /> (assistant only)
  <Content>
    <Header /> (assistant: model name)
    <Body /> (markdown content)
    <Actions /> (copy, regenerate, etc.)
  </Content>
</MessageBubble>
```

**Props**:
- `variant`: 'user' | 'assistant' | 'system'
- `content`: string (markdown)
- `timestamp`: Date
- `modelName`: string (assistant only)
- `onCopy`: () => void
- `onRegenerate`: () => void
- `isStreaming`: boolean

---

### InputArea

**Purpose**: Message composition

**Structure**:
```
<InputArea>
  <TextInput
    placeholder="Type a message..."
    onSubmit={send}
  />
  <SendButton />
  <HintText>Press / for commands</HintText>
</InputArea>
```

**Props**:
- `value`: string
- `placeholder`: string
- `disabled`: boolean
- `onChange`: (value) => void
- `onSubmit`: (value) => void
- `onSlashCommand`: () => void

---

## List Components

### SessionList

**Purpose**: Display list of sessions

**Item Structure**:
```
<SessionListItem
  name="session name"
  timestamp={Date}
  isActive={boolean}
  onClick={select}
/>
```

**Props**:
- `sessions`: Session[]
- `activeId`: string
- `onSelect`: (id) => void
- `emptyMessage`: string

---

### RecentDirectoriesList

**Purpose**: Show recent working directories

**Props**:
- `directories`: Directory[]
- `onSelect`: (path) => void

---

## Modal Components

### Modal (Base)

**Purpose**: Reusable modal container

**Structure**:
```
<Modal
  isOpen={boolean}
  onClose={() => void}
  title={string}
  size="sm|md|lg"
>
  <ModalContent />
  <ModalFooter>
    <Button variant="secondary">Cancel</Button>
    <Button variant="primary">Confirm</Button>
  </ModalFooter>
</Modal>
```

**Features**:
- Backdrop click to close (configurable)
- Escape key to close
- Focus trap
- Scroll lock

---

### DirectoryPickerModal

**Purpose**: Select working directory

**Content**:
1. Search input
2. Current directory section
3. Recent directories list

**Props**:
- `currentPath`: string
- `recentDirs`: string[]
- `onSelect`: (path) => void
- `onCancel`: () => void

---

### CommandPaletteModal

**Purpose**: Slash command selection

**Content**:
1. Filter input (pre-filled with "/")
2. Command list (filtered)
3. Command descriptions

**Props**:
- `commands`: Command[]
- `onSelect`: (command) => void
- `onCancel`: () => void

---

### ModelSelectorModal

**Purpose**: Select AI model

**Content**:
1. Refresh button
2. Model list with radio buttons
3. Thinking mode toggle

**Props**:
- `models`: Model[]
- `selectedId`: string
- `thinkingMode`: boolean
- `onSelect`: (id, thinking) => void

---

### ConfirmationDialog

**Purpose**: Confirm destructive actions

**Props**:
- `title`: string
- `message`: string
- `confirmLabel`: string
- `danger`: boolean (red button)
- `onConfirm`: () => void
- `onCancel`: () => void

---

### AlertDialog

**Purpose**: Show errors and alerts

**Variants**:
- `info` - Blue accent
- `warning` - Yellow accent
- `error` - Red accent
- `success` - Green accent

**Props**:
- `variant`: 'info' | 'warning' | 'error' | 'success'
- `title`: string
- `message`: string
- `actions`: Action[]

---

## Form Components

### Button

**Variants**:
1. **Primary** - Dark bg, white text
2. **Secondary** - Light bg, dark text, border
3. **Ghost** - Transparent, hover highlight
4. **Danger** - Red bg (destructive)

**Sizes**:
- `sm` - 32px height
- `md` - 40px height (default)
- `lg` - 48px height

**Props**:
- `variant`: 'primary' | 'secondary' | 'ghost' | 'danger'
- `size`: 'sm' | 'md' | 'lg'
- `disabled`: boolean
- `loading`: boolean
- `icon`: IconComponent
- `iconPosition`: 'left' | 'right'
- `onClick`: () => void

---

### TextInput

**Props**:
- `value`: string
- `placeholder`: string
- `disabled`: boolean
- `error`: string
- `prefix`: ReactNode (icon)
- `suffix`: ReactNode (clear button)
- `onChange`: (value) => void
- `onFocus`: () => void
- `onBlur`: () => void
- `onKeyDown`: (e) => void

---

### SearchInput

**Extends**: TextInput

**Additional Props**:
- `onClear`: () => void
- `loading`: boolean (show spinner)

---

### RadioGroup

**Props**:
- `options`: Option[]
- `value`: string
- `onChange`: (value) => void
- `orientation`: 'vertical' | 'horizontal'

---

### Checkbox

**Props**:
- `checked`: boolean
- `label`: string
- `onChange`: (checked) => void

---

## Feedback Components

### Toast

**Purpose**: Brief notifications

**Variants**:
- `info` - Blue
- `success` - Green
- `warning` - Yellow
- `error` - Red

**Props**:
- `message`: string
- `variant`: ToastVariant
- `duration`: number (ms)
- `onClose`: () => void

**Behavior**:
- Auto-dismiss after duration
- Stacked (max 3 visible)
- Swipe to dismiss

---

### LoadingSpinner

**Props**:
- `size`: 'sm' | 'md' | 'lg'
- `color`: string

---

### ProgressBar

**Props**:
- `value`: number (0-100)
- `label`: string (optional)
- `showValue`: boolean

---

### Skeleton

**Purpose**: Loading placeholder

**Variants**:
- `text` - Single line
- `paragraph` - Multiple lines
- `circle` - Avatar placeholder
- `rectangle` - Card placeholder

---

## Utility Components

### Tooltip

**Props**:
- `content`: string
- `position`: 'top' | 'bottom' | 'left' | 'right'
- `delay`: number (ms)

---

### DropdownMenu

**Props**:
- `trigger`: ReactNode
- `items`: MenuItem[]
- `align`: 'start' | 'end'

---

### ContextMenu

**Props**:
- `children`: ReactNode
- `items`: MenuItem[]

---

### Pager

**Purpose**: Fullscreen scrollable content (for help, changelog)

**Props**:
- `content`: string (markdown)
- `onClose`: () => void

---

### Badge

**Purpose**: Status indicators

**Variants**:
- `default` - Gray
- `primary` - Blue
- `success` - Green
- `warning` - Yellow
- `danger` - Red

**Props**:
- `variant`: BadgeVariant
- `children`: ReactNode

---

## Icon Components

### Icon Library

All icons are 18-24px, outlined style:

**Navigation**:
- `Home`
- `Back`
- `Forward`
- `ChevronDown`, `ChevronUp`, `ChevronLeft`, `ChevronRight`

**Actions**:
- `Plus` - New
- `Refresh` - Reload
- `Search` - Find
- `Settings` - Gear
- `Close` - X
- `Send` - Paper airplane
- `Copy` - Documents
- `Check` - Checkmark
- `Trash` - Delete

**File/Folder**:
- `Folder`
- `FolderOpen`
- `File`
- `FileText`

**Status**:
- `Info` - Circle with i
- `Warning` - Triangle
- `Error` - Circle with x
- `Success` - Check circle

**Misc**:
- `Sparkles` - AI/assistant indicator
- `Terminal` - CLI reference
- `ExternalLink` - Opens in new tab

---

## Data Types

```typescript
interface Session {
  id: string;
  name: string;
  workingDirectory: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  isArchived: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  modelName?: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  name: string;
  arguments: object;
  result?: object;
}

interface Command {
  name: string;
  aliases: string[];
  description: string;
  args?: string;
  requiresConfirmation?: boolean;
}

interface Model {
  id: string;
  name: string;
  description: string;
  supportsThinking: boolean;
}
```

---

## Component Hierarchy

```
App
├── Header
│   ├── Logo
│   └── VersionTag
├── Sidebar
│   ├── SectionHeader
│   ├── Toolbar
│   │   ├── RefreshButton
│   │   ├── NewSessionButton
│   │   └── ViewToggle
│   ├── SearchInput
│   ├── SessionList
│   │   └── SessionListItem
│   └── SidebarFooter
│       ├── ArchiveExpander
│       └── SettingsButton
└── MainContent
    ├── EmptyState
    │   ├── Icon
    │   ├── Heading
    │   ├── Description
    │   └── Button
    └── ChatInterface
        ├── ChatHeader
        ├── MessageList
        │   └── MessageBubble
        │       ├── Avatar
        │       ├── Content
        │       │   ├── Header
        │       │   ├── Body (Markdown)
        │       │   └── Actions
        │       │       ├── CopyButton
        │       │       └── RegenerateButton
        │       └── Timestamp
        └── InputArea
            ├── TextInput
            ├── SendButton
            └── HintText
```

---

*Component specifications derived from automated UI testing*
