#!/usr/bin/env python3
"""Test Shell and Files tabs with Playwright - v2"""

from playwright.sync_api import sync_playwright
import time
import sys

def test_tabs():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        
        # Collect console messages
        console_messages = []
        page.on('console', lambda msg: console_messages.append((msg.type, msg.text)))
        
        print("1. Navigating to login page...")
        page.goto('http://localhost:3456')
        page.wait_for_load_state('networkidle')
        time.sleep(1)
        
        # Screenshot of initial page
        page.screenshot(path='/tmp/01_initial.png')
        print("   Screenshot: /tmp/01_initial.png")
        
        # Login
        print("2. Logging in...")
        password_input = page.locator('input[type="password"]')
        if password_input.is_visible():
            password_input.fill('admin')
            page.locator('button[type="submit"]').click()
            time.sleep(2)
        
        page.screenshot(path='/tmp/02_after_login.png')
        print("   Screenshot: /tmp/02_after_login.png")
        
        # Get page content to understand structure
        print("3. Analyzing page structure...")
        buttons = page.locator('button').all()
        print(f"   Found {len(buttons)} buttons:")
        for btn in buttons[:10]:
            text = btn.text_content() or ''
            if text.strip():
                print(f"     - '{text.strip()}'")
        
        # Check for tabs
        print("4. Looking for tabs...")
        
        # Try different selectors for tabs
        tab_selectors = [
            'button:has-text("Shell")',
            'button:has-text("Files")', 
            'button:has-text("Chat")',
            'button:has-text("Git")',
        ]
        
        for selector in tab_selectors:
            loc = page.locator(selector).first
            if loc.is_visible():
                print(f"   ✓ Found: {selector}")
            else:
                print(f"   ✗ Not found: {selector}")
        
        # Test Shell tab
        print("5. Testing Shell tab...")
        shell_btn = page.locator('button').filter(has_text='Shell').first
        if shell_btn.is_visible():
            shell_btn.click()
            time.sleep(1)
            page.screenshot(path='/tmp/03_shell_tab.png')
            print("   Screenshot: /tmp/03_shell_tab.png")
            
            # Check status
            content = page.content()
            if 'Disconnected' in content:
                print("   ⚠ Status: Disconnected")
            elif 'Connected' in content:
                print("   ✓ Status: Connected")
            else:
                print("   ? Status: Unknown")
        else:
            print("   ✗ Shell button not visible")
        
        # Test Files tab
        print("6. Testing Files tab...")
        files_btn = page.locator('button').filter(has_text='Files').first
        if files_btn.is_visible():
            files_btn.click()
            time.sleep(1.5)
            page.screenshot(path='/tmp/04_files_tab.png')
            print("   Screenshot: /tmp/04_files_tab.png")
            
            content = page.content()
            if 'Empty directory' in content:
                print("   ⚠ Shows: Empty directory")
            elif 'No matching files' in content:
                print("   ⚠ Shows: No matching files")
            else:
                print("   ✓ Shows file listing")
        else:
            print("   ✗ Files button not visible")
        
        # Check console for WebSocket errors
        print("7. Console messages:")
        ws_errors = [(t, m) for t, m in console_messages if 'websocket' in m.lower() or 'ws' in m.lower()]
        if ws_errors:
            print(f"   WebSocket messages ({len(ws_errors)}):")
            for t, m in ws_errors[:5]:
                print(f"     [{t}] {m[:100]}")
        else:
            print("   No WebSocket messages logged")
        
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
