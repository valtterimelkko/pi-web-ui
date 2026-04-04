#!/usr/bin/env python3
"""Test Shell and Files tabs with Playwright - v3 (dev mode on port 3457)"""

from playwright.sync_api import sync_playwright
import time
import sys

def test_tabs():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        
        # Collect console messages
        console_messages = []
        def handle_console(msg):
            console_messages.append((msg.type, msg.text))
            if 'WebSocket' in msg.text or 'ws' in msg.text.lower():
                print(f"   [Console {msg.type}] {msg.text[:120]}")
        
        page.on('console', handle_console)
        
        # Capture page errors
        page_errors = []
        page.on('pageerror', lambda err: page_errors.append(str(err)))
        
        print("1. Navigating to client dev server on port 3457...")
        page.goto('http://localhost:3457')
        page.wait_for_load_state('networkidle')
        time.sleep(2)
        
        # Screenshot of initial page
        page.screenshot(path='/tmp/01_initial.png')
        print("   Screenshot: /tmp/01_initial.png")
        
        # Login
        print("2. Logging in...")
        password_input = page.locator('input[type="password"]')
        if password_input.is_visible():
            password_input.fill('admin')
            page.locator('button[type="submit"]').click()
            time.sleep(3)
        
        page.screenshot(path='/tmp/02_after_login.png')
        print("   Screenshot: /tmp/02_after_login.png")
        
        # Get page content to understand structure
        print("3. Analyzing page structure...")
        buttons = page.locator('button').all()
        print(f"   Found {len(buttons)} buttons:")
        for btn in buttons[:15]:
            text = btn.text_content() or ''
            if text.strip():
                print(f"     - '{text.strip()[:40]}'")
        
        # Check for tabs
        print("4. Looking for tabs...")
        
        # Try different selectors for tabs
        tab_labels = ['Chat', 'Shell', 'Files', 'Git', 'Tasks']
        for label in tab_labels:
            loc = page.locator('button').filter(has_text=label).first
            if loc.is_visible():
                print(f"   ✓ Found tab: {label}")
            else:
                print(f"   ✗ Not found: {label}")
        
        # Test Shell tab
        print("5. Testing Shell tab...")
        shell_btn = page.locator('button').filter(has_text='Shell').first
        if shell_btn.is_visible():
            shell_btn.click()
            time.sleep(2)  # Wait for WebSocket connection
            page.screenshot(path='/tmp/03_shell_tab.png')
            print("   Screenshot: /tmp/03_shell_tab.png")
            
            # Check status
            content = page.content()
            if 'Disconnected' in content:
                print("   ⚠ Status: Disconnected (terminal not working)")
            elif 'Connected' in content:
                print("   ✓ Status: Connected (terminal working!)")
            elif 'node-pty' in content or 'not available' in content.lower():
                print("   ⚠ Terminal unavailable on server")
            else:
                print(f"   ? Status unclear - content snippet: {content[:200]}")
        else:
            print("   ✗ Shell button not visible")
        
        # Test Files tab
        print("6. Testing Files tab...")
        files_btn = page.locator('button').filter(has_text='Files').first
        if files_btn.is_visible():
            files_btn.click()
            time.sleep(2)  # Wait for files to load
            page.screenshot(path='/tmp/04_files_tab.png')
            print("   Screenshot: /tmp/04_files_tab.png")
            
            content = page.content()
            if 'Empty directory' in content:
                print("   ⚠ Shows: Empty directory (files not loading)")
            elif 'No matching files' in content:
                print("   ⚠ Shows: No matching files (filter active)")
            elif content.count('/') > 5:  # Multiple file paths
                print("   ✓ Shows file listing")
            else:
                print(f"   ? Files content: {content[:200]}")
        else:
            print("   ✗ Files button not visible")
        
        # Switch back to chat
        print("7. Switching back to Chat tab...")
        chat_btn = page.locator('button').filter(has_text='Chat').first
        if chat_btn.is_visible():
            chat_btn.click()
            time.sleep(0.5)
            print("   ✓ Back on Chat tab")
        
        # Check for errors
        print("8. Checking for errors...")
        if page_errors:
            print(f"   ⚠ Page errors ({len(page_errors)}):")
            for err in page_errors[:5]:
                print(f"     - {err[:100]}")
        else:
            print("   ✓ No page errors")
        
        ws_errors = [(t, m) for t, m in console_messages if 'websocket' in m.lower() or 'ws' in m.lower()]
        if ws_errors:
            print(f"   WebSocket messages: {len(ws_errors)}")
        
        browser.close()
        print("\n=== Test Complete ===")
        return True

if __name__ == '__main__':
    try:
        test_tabs()
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
