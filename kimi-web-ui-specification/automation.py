#!/usr/bin/env python3
"""
Kimi Web UI Comprehensive Testing Automation
Uses Playwright to systematically test and document the Kimi Web UI.
"""

import os
import sys
import time
import json
from pathlib import Path

from playwright.sync_api import sync_playwright, Page, Browser

# Configuration
BASE_URL = "https://kimi.letsautomate.work/?token=EFydwGvlqcZW0M7DL37VJHQIbWwxVERi"
SNAPSHOTS_DIR = Path("/root/pi-web-ui/kimi-web-ui-specification/snapshots")
VIDEOS_DIR = Path("/root/pi-web-ui/kimi-web-ui-specification/videos")

SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
VIDEOS_DIR.mkdir(parents=True, exist_ok=True)

# Global counter for snapshot numbering
snapshot_counter = 0

def get_snapshot_filename(name: str) -> str:
    """Generate numbered snapshot filename."""
    global snapshot_counter
    snapshot_counter += 1
    return f"{snapshot_counter:02d}-{name}"

def save_snapshot(page: Page, name: str, full_page: bool = True):
    """Save screenshot with YAML metadata."""
    filename_base = get_snapshot_filename(name)
    
    # Save PNG
    png_path = SNAPSHOTS_DIR / f"{filename_base}.png"
    page.screenshot(path=str(png_path), full_page=full_page)
    print(f"Saved: {png_path}")
    
    # Save HTML content for reference
    html_path = SNAPSHOTS_DIR / f"{filename_base}.html"
    html_content = page.content()
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html_content)
    
    # Save accessibility snapshot
    try:
        snapshot = page.accessibility.snapshot()
        json_path = SNAPSHOTS_DIR / f"{filename_base}.json"
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(snapshot, f, indent=2, default=str)
    except Exception as e:
        print(f"Could not save accessibility snapshot: {e}")
    
    return png_path

def wait_for_load(page: Page):
    """Wait for page to fully load."""
    page.wait_for_load_state('networkidle')
    time.sleep(1)  # Extra wait for any animations

def phase1_sessions_list(page: Page):
    """Phase 1: Document sessions list view."""
    print("\n=== PHASE 1: Sessions List ===")
    
    # Navigate to base URL
    print("Navigating to Kimi Web UI...")
    page.goto(BASE_URL)
    wait_for_load(page)
    
    # Initial landing snapshot
    save_snapshot(page, "initial-landing")
    
    # Wait for any initial animations
    time.sleep(2)
    save_snapshot(page, "sessions-list")
    
    # Try to identify all buttons and controls
    buttons = page.query_selector_all('button')
    print(f"Found {len(buttons)} buttons on initial page")
    
    # Document any interactive elements
    interactive_elements = page.query_selector_all('button, [role="button"], a, input, [role="listitem"]')
    print(f"Found {len(interactive_elements)} interactive elements")
    
    return True

def phase2_create_session(page: Page):
    """Phase 2: Create new session and document chat interface."""
    print("\n=== PHASE 2: Create New Session ===")
    
    # Look for new session button (typically a + button)
    # Try different selectors
    new_session_selectors = [
        'button:has-text("+")',
        'button:has-text("New")',
        '[data-testid="new-session"]',
        'button svg[viewBox]',
        'button[aria-label*="new" i]',
        'button[title*="new" i]',
    ]
    
    new_session_btn = None
    for selector in new_session_selectors:
        try:
            btn = page.query_selector(selector)
            if btn:
                new_session_btn = btn
                print(f"Found new session button with selector: {selector}")
                break
        except:
            continue
    
    if not new_session_btn:
        # List all buttons to help debug
        buttons = page.query_selector_all('button')
        print(f"Available buttons: {len(buttons)}")
        for i, btn in enumerate(buttons[:10]):
            text = btn.inner_text()[:50] if btn else "no text"
            print(f"  Button {i}: {text}")
        
        # Try clicking first button that looks like it could be "new"
        if buttons:
            new_session_btn = buttons[0]
    
    if new_session_btn:
        save_snapshot(page, "before-click-new-session")
        new_session_btn.click()
        time.sleep(2)
        save_snapshot(page, "new-session-view")
    else:
        print("Could not find new session button")
    
    return True

def phase3_chat_interaction(page: Page):
    """Phase 3: Chat interaction and response boxes."""
    print("\n=== PHASE 3: Chat Interaction ===")
    
    # Find input area
    input_selectors = [
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[placeholder*="message" i]',
        '[placeholder*="ask" i]',
    ]
    
    input_element = None
    for selector in input_selectors:
        try:
            elem = page.query_selector(selector)
            if elem:
                input_element = elem
                print(f"Found input with selector: {selector}")
                break
        except:
            continue
    
    if input_element:
        # Type a test message
        input_element.fill("Hello! Can you help me understand your interface?")
        save_snapshot(page, "typing-message")
        
        # Submit message (Enter key)
        input_element.press("Enter")
        time.sleep(2)
        save_snapshot(page, "message-sent")
        
        # Wait for AI response (up to 30 seconds)
        print("Waiting for AI response...")
        time.sleep(5)
        save_snapshot(page, "ai-response-loading")
        
        # Wait longer for full response
        time.sleep(10)
        save_snapshot(page, "ai-response-complete")
        
        # Send follow-up about slash commands
        input_element.fill("What slash commands do you support?")
        input_element.press("Enter")
        time.sleep(15)
        save_snapshot(page, "conversation-flow")
    else:
        print("Could not find input element")
    
    return True

def phase4_slash_commands(page: Page):
    """Phase 4: Test slash commands and document pop-ups."""
    print("\n=== PHASE 4: Slash Commands ===")
    
    # Find input area
    input_selectors = [
        'textarea',
        'input[type="text"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ]
    
    input_element = None
    for selector in input_selectors:
        try:
            elem = page.query_selector(selector)
            if elem:
                input_element = elem
                break
        except:
            continue
    
    if not input_element:
        print("Could not find input element for slash commands")
        return False
    
    # Clear any existing content
    input_element.fill("")
    time.sleep(0.5)
    
    # Test 1: Type "/" to trigger command completion
    print("Testing / command trigger...")
    input_element.type("/", delay=100)
    time.sleep(2)
    save_snapshot(page, "slash-trigger-popup")
    
    # Clear and test specific commands
    commands_to_test = [
        ("/help", "slash-help"),
        ("/version", "slash-version"),
        ("/sessions", "slash-sessions"),
        ("/new", "slash-new"),
        ("/model", "slash-model"),
        ("/plan", "slash-plan"),
        ("/yolo", "slash-yolo"),
        ("/debug", "slash-debug"),
        ("/export", "slash-export"),
        ("/clear", "slash-clear"),
    ]
    
    for command, snapshot_name in commands_to_test:
        try:
            # Clear input
            input_element.fill("")
            time.sleep(0.5)
            
            # Type command
            print(f"Testing command: {command}")
            input_element.type(command, delay=50)
            time.sleep(1)
            
            # Take snapshot before enter
            save_snapshot(page, f"{snapshot_name}-typed")
            
            # Press Enter to execute
            input_element.press("Enter")
            time.sleep(3)
            
            # Take snapshot after execution
            save_snapshot(page, f"{snapshot_name}-executed")
            
            # Close any modals if they exist (press Escape)
            page.keyboard.press("Escape")
            time.sleep(0.5)
            
            # Dismiss any confirmation dialogs
            try:
                page.keyboard.press("Escape")
            except:
                pass
            
        except Exception as e:
            print(f"Error testing {command}: {e}")
    
    return True

def phase5_input_features(page: Page):
    """Phase 5: Document input area features."""
    print("\n=== PHASE 5: Input Features ===")
    
    input_element = page.query_selector('textarea, input[type="text"], [contenteditable="true"]')
    if not input_element:
        print("Input not found")
        return False
    
    # Test multiline input
    input_element.fill("")
    input_element.type("Line 1", delay=50)
    input_element.press("Shift+Enter")
    input_element.type("Line 2", delay=50)
    time.sleep(1)
    save_snapshot(page, "multiline-input")
    
    return True

def phase6_tool_execution(page: Page):
    """Phase 6: Trigger and document tool execution display."""
    print("\n=== PHASE 6: Tool Execution ===")
    
    input_element = page.query_selector('textarea, input[type="text"], [contenteditable="true"]')
    if not input_element:
        return False
    
    # Trigger a tool execution
    input_element.fill("List all files in the current directory")
    input_element.press("Enter")
    time.sleep(10)
    save_snapshot(page, "tool-execution")
    
    return True

def phase7_return_to_sessions(page: Page):
    """Phase 7: Return to sessions list."""
    print("\n=== PHASE 7: Return to Sessions List ===")
    
    # Try to find back button or sessions link
    back_selectors = [
        'button:has-text("Back")',
        'button:has-text("Sessions")',
        'a:has-text("Sessions")',
        '[data-testid="back-button"]',
        'button svg',  # Could be an icon button
    ]
    
    for selector in back_selectors:
        try:
            btn = page.query_selector(selector)
            if btn:
                btn.click()
                time.sleep(2)
                save_snapshot(page, "back-to-sessions")
                break
        except:
            continue
    
    # Also try navigating directly
    page.goto(BASE_URL)
    wait_for_load(page)
    time.sleep(2)
    save_snapshot(page, "updated-sessions-list")
    
    return True

def main():
    """Main execution function."""
    print("=" * 60)
    print("Kimi Web UI Comprehensive Testing")
    print("=" * 60)
    
    with sync_playwright() as p:
        # Launch browser with sandbox disabled (for containerized environments)
        print("Launching browser...")
        browser = p.chromium.launch(
            headless=True,
            args=[
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
            ]
        )
        
        # Create context with viewport size
        context = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            record_video_dir=str(VIDEOS_DIR),
        )
        
        # Create page
        page = context.new_page()
        
        try:
            # Execute all phases
            phase1_sessions_list(page)
            phase2_create_session(page)
            phase3_chat_interaction(page)
            phase4_slash_commands(page)
            phase5_input_features(page)
            phase6_tool_execution(page)
            phase7_return_to_sessions(page)
            
            print("\n" + "=" * 60)
            print("Testing completed successfully!")
            print(f"Total snapshots: {snapshot_counter}")
            print(f"Snapshots saved to: {SNAPSHOTS_DIR}")
            print(f"Video saved to: {VIDEOS_DIR}")
            print("=" * 60)
            
        except Exception as e:
            print(f"\nError during testing: {e}")
            import traceback
            traceback.print_exc()
            
            # Save final state on error
            try:
                save_snapshot(page, "error-state")
            except:
                pass
        
        finally:
            # Cleanup
            context.close()
            browser.close()
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
